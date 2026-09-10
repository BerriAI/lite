import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { notify, type Spawner } from '../server/notify.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const realPlatform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value, configurable: true });

describe('notify unit (injected spawner, no real OS surface)', () => {
  afterEach(() => setPlatform(realPlatform));
  const spawner = () => vi.fn() as unknown as Spawner & ReturnType<typeof vi.fn>;

  it('macOS: builds one osascript -e argument with AppleScript-escaped strings and a 2s timeout', () => {
    setPlatform('darwin');
    const spawn = spawner();
    notify('Speedrail', 'He said "hi" \\ done', spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('osascript');
    expect(args[0]).toBe('-e');
    // \\ then " escaped — the only escapes AppleScript honors in string literals.
    expect(args[1]).toBe('display notification "He said \\"hi\\" \\\\ done" with title "Speedrail"');
    expect(options).toEqual({ timeout: 2000 });
  });
  it('macOS: strips control and format characters so user text cannot smuggle terminal or script structure', () => {
    setPlatform('darwin');
    const spawn = spawner();
    notify('Speedrail', 'line1\nline2[2Jend‮', spawn);
    expect(spawn.mock.calls[0][1][1]).toBe('display notification "line1 line2 [2Jend " with title "Speedrail"');
  });
  it('linux: notify-send with plain title/body argv (no shell)', () => {
    setPlatform('linux');
    const spawn = spawner();
    notify('Speedrail', 'response finished', spawn);
    expect(spawn).toHaveBeenCalledWith('notify-send', ['Speedrail', 'response finished'], { timeout: 2000 }, expect.any(Function));
  });
  it('windows and unknown platforms: complete no-op', () => {
    for (const platform of ['win32', 'freebsd']) {
      setPlatform(platform);
      const spawn = spawner();
      notify('Speedrail', 'body', spawn);
      expect(spawn).not.toHaveBeenCalled();
    }
  });
  it('never throws, even when the spawner itself throws synchronously', () => {
    setPlatform('darwin');
    expect(() => notify('Speedrail', 'body', (() => { throw new Error('spawn failed'); }) as unknown as Spawner)).not.toThrow();
  });
  it('bounds runaway text so argv stays small', () => {
    setPlatform('linux');
    const spawn = spawner();
    notify('T'.repeat(5000), 'B'.repeat(5000), spawn);
    expect((spawn.mock.calls[0][1][0] as string).length).toBe(100);
    expect((spawn.mock.calls[0][1][1] as string).length).toBe(300);
  });
});

describe('runner notification semantics (injected spawner)', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let respond: (body: any, res: ServerResponse) => void;
  let spawn: ReturnType<typeof vi.fn>;
  const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  const until = async (check: () => boolean) => { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
  const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
  const api = async (path: string, data?: unknown) => { const response = await fetch(url + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const bodies = () => spawn.mock.calls.map(call => JSON.stringify(call[1]));
  beforeEach(async () => {
    setPlatform('darwin'); // Deterministic channel: assertions read the osascript args.
    directory = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-notify-runner-')));
    store = new Store(join(directory, 'state'));
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); respond(JSON.parse(Buffer.concat(chunks).toString()), res); });
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: await listen(provider), apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
    spawn = vi.fn();
    runner.notifySpawner = spawn as never;
  });
  afterEach(async () => { setPlatform(realPlatform); runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('fires on a slow-turn seal with the session title, reading the setting live', async () => {
    store.saveSettings({ notifications: true });
    runner.notifyMinTurnMs = -1; // Every turn counts as slow for this test.
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    runner.start(session.id, 'Long research question'); await runner.whenIdle();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toContain('Long research question: response finished');
  });
  it('does not fire for a fast turn (the >10s gate)', async () => {
    store.saveSettings({ notifications: true }); // Gate stays at the default 10s.
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    runner.start(session.id, 'Quick one'); await runner.whenIdle();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('does not fire when notifications are disabled (the default)', async () => {
    runner.notifyMinTurnMs = -1;
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    runner.start(session.id, 'Silent by default'); await runner.whenIdle();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('fires on the waiting transition for a pending approval, once, and not again on the fast seal', async () => {
    store.saveSettings({ notifications: true }); // Default 10s gate: the seal itself stays silent.
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res) : stream(res, { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'x' }) } }] }, 'tool_calls');
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    runner.start(session.id, 'Needs approval');
    await until(() => runner.permissions(session.id).length === 1);
    await new Promise(resolve => setTimeout(resolve, 0)); // Flush the microtask-deferred check.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toContain('Needs approval: needs your approval');
    runner.decide(session.id, runner.permissions(session.id)[0].id, 'deny');
    await runner.whenIdle();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it('a mid-turn settings flip takes effect at the next notification moment (live read, not captured)', async () => {
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res) : stream(res, { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'x' }) } }] }, 'tool_calls');
    runner.notifyMinTurnMs = -1;
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    runner.start(session.id, 'Flip mid-turn'); // Accepted while notifications are OFF.
    await until(() => runner.permissions(session.id).length === 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(spawn).not.toHaveBeenCalled(); // Off at the waiting moment.
    store.saveSettings({ notifications: true }); // Turn on mid-turn.
    runner.decide(session.id, runner.permissions(session.id)[0].id, 'allow');
    await runner.whenIdle();
    expect(spawn).toHaveBeenCalledTimes(1); // Seal notifies under the LIVE setting.
    expect(bodies()[0]).toContain('response finished');
  });
  it('never fires for a researcher child seal — only the parent turn notifies', async () => {
    store.saveSettings({ notifications: true });
    runner.notifyMinTurnMs = -1;
    const child = (body: any) => body.messages.find((m: any) => m.role === 'user')?.content?.startsWith('CHILD');
    respond = (body, res) => {
      if (child(body)) text(res, 'Child evidence');
      else if (body.messages.at(-1)?.role === 'tool') text(res, 'Root done');
      else stream(res, { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'Inspect', prompt: 'CHILD inspect' }) } }] }, 'tool_calls');
    };
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    runner.start(session.id, 'ROOT research'); await runner.whenIdle();
    expect(runner.delegations.list(session.id)).toHaveLength(1); // The child really sealed.
    expect(spawn).toHaveBeenCalledTimes(1); // Parent only.
    expect(bodies()[0]).toContain('ROOT research: response finished');
  });
});
