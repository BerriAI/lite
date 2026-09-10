import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

describe('plugin API: plan/install/list/remove round trip', () => {
  let dir: string, workspace: string, pkg: string, store: Store, server: Server, base: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-plugins-api-')));
    workspace = join(dir, 'workspace'); pkg = join(dir, 'pkg');
    await mkdir(workspace); await mkdir(pkg);
    store = new Store(join(dir, 'state'));
    store.saveSettings({ workspace, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: 'http://localhost:9' }], defaultProvider: 'test', defaultModel: 'm' });
    const created = createApp({ store });
    server = createServer(created.app); base = await listen(server);
  });
  afterEach(async () => { await close(server); store.close(); await rm(dir, { recursive: true, force: true }); });

  async function request(path: string, body?: unknown, method?: string) {
    const response = await fetch(`${base}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function writePackage() {
    await mkdir(join(pkg, 'skills'), { recursive: true });
    await writeFile(join(pkg, 'skills', 'audit.md'), 'AUDIT SKILL BODY\n');
    await writeFile(join(pkg, 'release.md'), '# Release\nChecklist.\n');
    await writeFile(join(pkg, 'speedrail-plugin.json'), JSON.stringify({
      name: 'kit', version: '1.0.0', description: 'API test kit.',
      skills: [{ id: 'audit', path: 'skills/audit.md' }],
      commands: [{ name: 'release', path: 'release.md' }],
      mcpServers: { search: { url: 'https://mcp.example.com/sse' } },
      hooks: [{ event: 'Stop', command: 'echo done' }],
    }));
  }

  it('plans, installs, lists, and removes through the HTTP API', async () => {
    await writePackage();
    const plan = await request('/plugins/plan', { source: pkg, workspace });
    expect(plan.status).toBe(200);
    expect(plan.data.plan.plugin).toEqual({ name: 'kit', version: '1.0.0', description: 'API test kit.' });
    expect(plan.data.plan.actions).toHaveLength(4);
    // The public plan carries bounded previews, never a full-content field.
    for (const action of plan.data.plan.actions) { expect(action.content).toBeUndefined(); expect(action.preview.length).toBeLessThanOrEqual(500); }
    expect(plan.data.applied).toBeUndefined(); // Plan alone never applies.
    expect((await request('/plugins')).data.plugins).toEqual({});
    await expect(readFile(join(workspace, '.speedrail', 'skills', 'audit', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    const install = await request('/plugins/install', { source: pkg, workspace });
    expect(install.status).toBe(200);
    expect(install.data.applied).toBe(true);
    expect(install.data.plugin.name).toBe('kit');
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe('AUDIT SKILL BODY\n');
    expect(await readFile(join(workspace, '.speedrail', 'commands', 'release.md'), 'utf8')).toBe('# Release\nChecklist.\n');
    expect(store.settings().mcpServers.search).toEqual({ url: 'https://mcp.example.com/sse', enabled: false });
    expect(store.settings().hooks).toEqual([{ event: 'Stop', command: 'echo done' }]);

    const list = await request('/plugins');
    expect(list.status).toBe(200);
    expect(list.data.plugins.kit).toMatchObject({ version: '1.0.0', workspace: await realpath(workspace) });
    expect(list.data.plugins.kit.items).toHaveLength(4);

    const removed = await request(`/plugins/kit?workspace=${encodeURIComponent(workspace)}`, undefined, 'DELETE');
    expect(removed.status).toBe(200);
    expect(removed.data.removed).toHaveLength(4);
    expect(removed.data.warnings).toEqual([]);
    expect((await request('/plugins')).data.plugins).toEqual({});
    await expect(readFile(join(workspace, '.speedrail', 'commands', 'release.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.settings().mcpServers.search).toBeUndefined();
    expect(store.settings().hooks).toEqual([]);
  });

  it('installing twice is an idempotent same-plugin update, not a conflict', async () => {
    await writePackage();
    expect((await request('/plugins/install', { source: pkg, workspace })).status).toBe(200);
    const again = await request('/plugins/install', { source: pkg, workspace });
    expect(again.status).toBe(200);
    expect(again.data.plan.actions.map((action: any) => action.conflict)).toEqual(['same-plugin-update', 'same-plugin-update', 'same-plugin-update', 'same-plugin-update']);
    expect(store.settings().hooks).toHaveLength(1); // No hook duplication.
    expect(Object.keys(store.settings().plugins ?? {})).toEqual(['kit']);
  });

  it('a conflicting foreign file is skipped with the warning surfaced in the install response', async () => {
    await writePackage();
    await mkdir(join(workspace, '.speedrail', 'commands'), { recursive: true });
    await writeFile(join(workspace, '.speedrail', 'commands', 'release.md'), 'USER COMMAND');
    const install = await request('/plugins/install', { source: pkg, workspace });
    expect(install.status).toBe(200);
    expect(install.data.plan.warnings.join(' ')).toContain('Command "release" conflicts with an existing .speedrail/commands/release.md');
    expect(install.data.plan.actions.find((action: any) => action.kind === 'command').conflict).toBe('exists');
    expect(await readFile(join(workspace, '.speedrail', 'commands', 'release.md'), 'utf8')).toBe('USER COMMAND');
    // Provenance excludes the skipped command.
    expect(store.settings().plugins?.kit?.items.map((item: any) => item.kind).sort()).toEqual(['hook', 'mcp', 'skill']);
  });

  it.each([
    { name: 'missing source', body: {} },
    { name: 'empty source', body: { source: '' } },
    { name: 'non-string source', body: { source: 42 } },
    { name: 'unknown key', body: { source: '/tmp/x', extra: true } },
    { name: 'oversized workspace', body: { source: '/tmp/x', workspace: 'w'.repeat(5000) } },
  ])('returns 400 for invalid request bodies: $name', async ({ body }) => {
    for (const path of ['/plugins/plan', '/plugins/install']) expect((await request(path, body)).status).toBe(400);
  });

  it('returns 400 for a hostile package through the API (traversal), and 404 removing an unknown plugin', async () => {
    await writeFile(join(pkg, 'speedrail-plugin.json'), JSON.stringify({ name: 'hostile', version: '1', commands: [{ name: 'steal', path: '../outside.md' }] }));
    const plan = await request('/plugins/plan', { source: pkg, workspace });
    expect(plan.status).toBe(400);
    expect(plan.data.error).toContain('must stay inside the package directory');
    expect((await request('/plugins/ghost', undefined, 'DELETE')).status).toBe(404);
  });

  it('defaults the workspace to the settings workspace when omitted', async () => {
    await writePackage();
    const install = await request('/plugins/install', { source: pkg });
    expect(install.status).toBe(200);
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe('AUDIT SKILL BODY\n');
    const removed = await request('/plugins/kit', undefined, 'DELETE');
    expect(removed.status).toBe(200);
    await expect(readFile(join(workspace, '.speedrail', 'skills', 'audit', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
