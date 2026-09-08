import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// Opt in after building: LITE_TEST_NODE=/absolute/path/to/node vitest run tests/runtime.test.ts
// No credential-bearing environment is inherited by the built app or CLI.
const runtime = process.env.LITE_TEST_NODE;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const instances: ChildProcess[] = [];
const servers: Server[] = [];
let temporary = '';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const environment = (home: string): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8' });
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
function processResult(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  instances.push(child);
  let output = '';
  child.stdout?.on('data', data => { output += data; });
  child.stderr?.on('data', data => { output += data; });
  const finished = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, finished, output: () => output };
}
afterEach(async () => {
  for (const child of instances.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(servers.splice(0).map(close));
  if (temporary) { await delay(100); await rm(temporary, { recursive: true, force: true }); temporary = ''; }
});

describe.skipIf(!runtime)('built runtime compatibility (explicit opt-in)', () => {
  it('serves production and CLI and preserves exact turn undo/redo across restarts without provider replay', async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'lite-runtime-')));
    const installation = join(temporary, 'installation');
    const workspace = join(temporary, 'workspace');
    const data = join(temporary, 'data');
    await mkdir(installation);
    await mkdir(workspace);
    await cp(join(project, 'dist'), join(installation, 'dist'), { recursive: true });
    await cp(join(project, 'bin'), join(installation, 'bin'), { recursive: true });
    await cp(join(project, 'package.json'), join(installation, 'package.json'));
    await symlink(join(project, 'node_modules'), join(installation, 'node_modules'));
    const env = { ...environment(temporary), LITE_DATA_DIR: data, LITE_WORKSPACE: workspace };
    const version = await processResult(runtime!, ['--version'], temporary, env).finished;
    expect(version.code).toBe(0);
    expect(version.output.trim()).toMatch(/^v22\.13\.0$/);
    const providerCalls: unknown[] = [];
    const fixtureContent = String.fromCharCode(0xfeff) + 'persisted runtime output — exact UTF-8\r\nno final newline';
    const provider = createServer(async (req, res) => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'runtime-model' }] })); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      providerCalls.push(request);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      if (request.messages.at(-1)?.role !== 'tool') emit({ tool_calls: [{ index: 0, id: 'runtime-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'runtime.txt', content: fixtureContent }) } }] });
      else { emit({ content: 'Runtime ' }); emit({ content: 'complete.' }); }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: request.messages.at(-1)?.role === 'tool' ? 'stop' : 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    servers.push(provider);
    const providerPort = await listen(provider);
    async function start(cli: boolean) {
      const reservation = createServer();
      const port = await listen(reservation);
      await close(reservation);
      const args = cli ? [join(installation, 'bin/lite.mjs'), 'serve', '--port', String(port), '--workspace', workspace] : [join(installation, 'dist/server/index.js')];
      const app = processResult(runtime!, args, workspace, { ...env, LITE_PORT: String(port) });
      const base = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (app.child.exitCode !== null || app.child.signalCode !== null) throw new Error(`Built app exited before health: ${app.output()}`);
        try { if ((await fetch(base + '/api/health')).ok) return { ...app, base }; } catch { /* Starting. */ }
        await delay(25);
      }
      throw new Error(`Built app did not become healthy: ${app.output()}`);
    }
    let app = await start(false);
    const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(app.base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    expect(await api('/health')).toEqual({ ok: true, version: '0.1.0' });
    expect(await (await fetch(app.base + '/')).text()).toContain('<div id="root">');
    const initial = await api('/settings');
    expect(initial.providers).toHaveLength(1);
    expect(initial.providers[0].baseUrl).toBe('http://localhost:4000');
    expect(initial.providers[0].apiKey).toBeUndefined();
    await api('/settings', { providers: [{ id: 'runtime', name: 'Runtime mock', kind: 'openai', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'synthetic-runtime-only' }], defaultProvider: 'runtime', defaultModel: 'runtime-model' }, 'PATCH');
    const session = await api('/sessions', { title: 'Node runtime fixture', permissionMode: 'auto' });
    const sessionPath = `/sessions/${session.id}`;
    const baseline = await api(sessionPath);
    expect(baseline.history).toMatchObject({ hasCheckpoints: false, canUndo: false, canRedo: false });
    const streamAbort = new AbortController();
    const response = await fetch(`${app.base}/api/sessions/${session.id}/events`, { signal: streamAbort.signal });
    const events: { type: string; data: unknown }[] = [];
    const streamed = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) throw new Error('Stream ended without done.');
          buffer += decoder.decode(part.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const line = frame.split('\n').find(line => line.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)); events.push(event);
            if (event.type === 'done') return;
          }
        }
      } finally { await reader.cancel(); }
    })();
    await api(`/sessions/${session.id}/messages`, { content: 'Create the runtime fixture.' });
    await streamed;
    streamAbort.abort();
    expect(events.some(event => event.type === 'delta'), JSON.stringify(events)).toBe(true);
    const fixtureBytes = Buffer.from(fixtureContent, 'utf8');
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect(providerCalls).toHaveLength(2);
    const completed = await api(sessionPath);
    expect(completed.messages.at(-1).content).toBe('Runtime complete.');
    expect(completed.history).toMatchObject({ hasCheckpoints: true, canUndo: true, canRedo: false });
    expect(completed.history.undoId).toEqual(expect.any(String));
    expect(completed.history.pendingRecovery).toBeUndefined();
    const checkpointId = completed.history.undoId;
    const recorded = await api(`${sessionPath}/changes`);
    expect(recorded.changes).toEqual([{ path: 'runtime.txt', before: null, after: fixtureContent }]);
    app.child.kill('SIGTERM');
    expect((await app.finished).code).toBe(0);
    app = await start(true);
    const persisted = await api(sessionPath);
    expect(persisted.messages).toEqual(completed.messages);
    expect(persisted.todos).toEqual(completed.todos);
    expect(persisted.history).toEqual(completed.history);
    expect(persisted.session.status).toBe('idle');
    expect(await api(`${sessionPath}/changes`)).toEqual(recorded);
    expect(providerCalls).toHaveLength(2);
    const undone = await api(`${sessionPath}/history/undo`, { checkpointId });
    expect(undone).toMatchObject({ hasCheckpoints: true, canUndo: false, canRedo: true, redoId: checkpointId });
    expect(undone.pendingRecovery).toBeUndefined();
    const undoneDetail = await api(sessionPath);
    expect(undoneDetail.messages).toEqual(baseline.messages);
    expect(undoneDetail.todos).toEqual(baseline.todos);
    expect(undoneDetail.queue.paused).toBe(true);
    expect(await api(`${sessionPath}/changes`)).toEqual({ changes: [] });
    await expect(readFile(join(workspace, 'runtime.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(providerCalls).toHaveLength(2);
    // Restart while undone: the redo branch must be persisted, not reconstructed
    // by calling the provider or executing the original write tool a second time.
    app.child.kill('SIGTERM');
    expect((await app.finished).code).toBe(0);
    app = await start(false);
    const restartedUndone = await api(sessionPath);
    expect(restartedUndone.history).toEqual(undone);
    expect(restartedUndone.messages).toEqual(baseline.messages);
    expect(restartedUndone.todos).toEqual(baseline.todos);
    expect(restartedUndone.queue.paused).toBe(true);
    await expect(readFile(join(workspace, 'runtime.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(providerCalls).toHaveLength(2);
    const redone = await api(`${sessionPath}/history/redo`, { checkpointId: restartedUndone.history.redoId });
    expect(redone).toEqual(completed.history);
    const restored = await api(sessionPath);
    expect(restored.messages).toEqual(completed.messages);
    expect(restored.todos).toEqual(completed.todos);
    expect(await api(`${sessionPath}/changes`)).toEqual(recorded);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect(providerCalls).toHaveLength(2);
    const cli = await processResult(runtime!, [join(installation, 'bin/lite.mjs'), 'sessions', '--url', app.base], workspace, env).finished;
    expect(cli.code).toBe(0);
    expect(cli.output).toContain(session.id);
    // Validate the installed native PTY on this exact ABI without starting a
    // login shell (which would read the real user's startup files).
    const pty = await processResult(runtime!, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(installation, 'package.json'))}); const {spawn}=require('node-pty'); const p=spawn('/bin/sh',['-c','printf "PTY_RUNTIME_OK\\n"'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:process.cwd(),TERM:'xterm'}}); p.onData(s=>process.stdout.write(s)); p.onExit(e=>process.exit(e.exitCode)); setTimeout(()=>process.exit(2),3000).unref();`], workspace, env).finished;
    expect(pty.code, pty.output).toBe(0);
    expect(pty.output).toContain('PTY_RUNTIME_OK');
    app.child.kill('SIGINT');
    expect((await app.finished).code).toBe(0);
  }, 30_000);
});
