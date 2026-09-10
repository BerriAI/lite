import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../server/store.js';
import { collectDiagnostics } from '../server/doctor.js';
import { createApp } from '../server/app.js';

describe('doctor diagnostics report', () => {
  let directory: string, store: Store;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'speedrail-doctor-')); store = new Store(join(directory, 'state')); });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  it('reports the full shape with integrity ok on a healthy store', () => {
    const session = store.createSession({ title: 'Doctor check' });
    store.saveMessage({ id: 'm1', sessionId: session.id, role: 'user', content: 'hello', createdAt: 1 });
    const report = collectDiagnostics(store);
    expect(report.node).toBe(process.version);
    expect(report.platform).toBe(process.platform);
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/); // Read from package.json, not hardcoded.
    expect(report.database).toMatchObject({ exists: true, sessions: 1, messages: 1, integrity: 'ok' });
    expect(report.database.sizeBytes).toBeGreaterThan(0);
    expect(report.database.path).toBe(join(directory, 'state', 'speedrail.db'));
    expect(report.settings).toMatchObject({ memoryEnabled: false, hookCount: 0, sidecarCount: 0, pluginCount: 0, permissionRuleCount: 0 });
    expect(report.workspace.path).toBe(store.settings().workspace);
  });

  it('redacts by construction: hasKey booleans and host-only URLs, no keys, no env values, no full URLs', () => {
    store.saveSettings({
      workspace: directory,
      providers: [
        { id: 'gw', name: 'Gateway', kind: 'openai', baseUrl: 'https://gateway.example.com:8443/v1/private-route?token=leaky', apiKey: 'sk-super-secret-value' },
        { id: 'local', name: 'Local', kind: 'anthropic', baseUrl: 'http://localhost:4000' },
      ],
      defaultProvider: 'gw',
      mcpServers: { files: { command: 'run-files-server --token SECRET_ENV', env: { API_TOKEN: 'env-secret-value' } }, remote: { url: 'https://mcp.example.com/secret-path' } },
      hooks: [{ event: 'Stop', command: 'echo done' }],
      permissionRules: { version: 1, rules: [{ tool: 'bash', decision: 'ask' }] },
      memoryEnabled: true,
    });
    const report = collectDiagnostics(store);
    expect(report.settings.providers).toEqual([
      { id: 'gw', kind: 'openai', host: 'gateway.example.com', hasKey: true },
      { id: 'local', kind: 'anthropic', host: 'localhost', hasKey: false },
    ]);
    expect(report.settings.mcpServers).toEqual([{ name: 'files', transport: 'stdio' }, { name: 'remote', transport: 'http' }]);
    expect(report.settings).toMatchObject({ memoryEnabled: true, hookCount: 1, permissionRuleCount: 1 });
    // The entire serialized report carries none of the sensitive material.
    const serialized = JSON.stringify(report);
    for (const secret of ['sk-super-secret-value', 'env-secret-value', 'SECRET_ENV', 'private-route', 'token=leaky', 'secret-path', 'run-files-server', 'echo done']) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('https://gateway.example.com'); // Host only, never a URL.
  });

  it('never includes message content', () => {
    const session = store.createSession();
    store.saveMessage({ id: 'm1', sessionId: session.id, role: 'user', content: 'CONFIDENTIAL_MESSAGE_BODY', createdAt: 1 });
    expect(JSON.stringify(collectDiagnostics(store))).not.toContain('CONFIDENTIAL_MESSAGE_BODY');
  });

  it('reports a missing workspace honestly', () => {
    // Persist a workspace path directly (saveSettings via API validates; the
    // store itself does not), simulating a directory deleted after configuration.
    store.saveSettings({ workspace: join(directory, 'deleted-later') });
    const report = collectDiagnostics(store);
    expect(report.workspace).toMatchObject({ exists: false, isGit: false });
  });
});

describe('doctor API', () => {
  let directory: string, store: Store, server: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'speedrail-doctor-api-'));
    store = new Store(join(directory, 'state'));
    store.saveSettings({ workspace: directory, providers: [{ id: 'p', name: 'P', kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'secret-api-key' }], defaultProvider: 'p' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); store.close(); rmSync(directory, { recursive: true, force: true }); });

  it('GET /api/doctor returns the redacted report', async () => {
    const response = await fetch(`${url}/api/doctor`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.database.integrity).toBe('ok');
    expect(body.settings.providers[0]).toEqual({ id: 'p', kind: 'openai', host: 'api.example.com', hasKey: true });
    expect(JSON.stringify(body)).not.toContain('secret-api-key');
  });

  it('POST /api/doctor/reindex rebuilds the search index and reports counts', async () => {
    const session = store.createSession({ title: 'Indexed' });
    store.saveMessage({ id: 'm1', sessionId: session.id, role: 'user', content: 'findable content', createdAt: 1 });
    const response = await fetch(`${url}/api/doctor/reindex`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions).toBe(1);
    expect(body.parts).toBeGreaterThan(0);
    // The rebuilt index is queryable through the same FTS table.
    const rows = store.db.prepare("SELECT COUNT(*) AS count FROM history_fts WHERE history_fts MATCH 'findable'").get() as { count: number };
    expect(Number(rows.count)).toBe(1);
  });
});
