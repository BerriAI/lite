import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { WebSocket } from 'ws';
import { spawn, type IPty } from 'node-pty';
import { Store } from '../server/store.js';
import { attachTerminals, TerminalManager, TERMINAL_LIMITS, terminalEnvironment } from '../server/terminal.js';

const until = async (check: () => boolean, timeout = 7000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for terminal event');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};
type WireMessage = { type: string; data?: string; seq?: number; terminalId?: string; cols?: number; rows?: number; message?: string; exitCode?: number };
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: WireMessage[] = [];
  terminated = false;
  code?: number;
  send(data: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(data)); callback?.(); }
  close(code = 1000) { this.code = code; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.terminated = true; this.close(1006); }
  ping() { this.emit('pong'); }
  message(data: unknown, binary = false) { this.emit('message', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), binary); }
  get ws() { return this as unknown as WebSocket; }
}
class FakePty {
  cols = 80; rows = 24; pid = 123; process = 'bash'; handleFlowControl = false;
  writes: string[] = []; signals: string[] = [];
  dataListeners = new Set<(data: string) => void>();
  exitListeners = new Set<(event: { exitCode: number }) => void>();
  onData = (fn: (data: string) => void) => { this.dataListeners.add(fn); return { dispose: () => this.dataListeners.delete(fn) }; };
  onExit = (fn: (event: { exitCode: number }) => void) => { this.exitListeners.add(fn); return { dispose: () => this.exitListeners.delete(fn) }; };
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  kill(signal = 'SIGHUP') { this.signals.push(signal); queueMicrotask(() => this.exit()); }
  clear() {} pause() {} resume() {}
  output(data: string) { for (const fn of this.dataListeners) fn(data); }
  exit() { for (const fn of this.exitListeners) fn({ exitCode: 0 }); }
}

describe('persistent terminal manager', () => {
  let dir: string, store: Store, manager: TerminalManager;
  let ptys: FakePty[], factory: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speedrail-terminal-manager-'));
    store = new Store(join(dir, 'state')); store.saveSettings({ workspace: dir });
    ptys = [];
    factory = vi.fn(() => { const pty = new FakePty(); ptys.push(pty); return pty as IPty; });
    manager = new TerminalManager(store, factory as typeof spawn);
  });
  afterEach(async () => { await manager.close(); store.close(); await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const output = (socket: FakeSocket) => socket.sent.filter(m => m.type === 'output').map(m => m.data).join('');

  it('spawns lazily in the stored workspace with a minimal credential-free environment', () => {
    vi.stubEnv('LITELLM_API_KEY', 'hidden-provider-key'); vi.stubEnv('SPEEDRAIL_DATA_DIR', '/secret/app-state');
    vi.stubEnv('OPENAI_API_KEY', 'hidden-other-key'); vi.stubEnv('NODE_OPTIONS', '--inspect');
    vi.stubEnv('BASH_ENV', '/secret/initialization'); vi.stubEnv('ARBITRARY_SECRET', 'hidden');
    const session = store.createSession();
    expect(factory).not.toHaveBeenCalled();
    const socket = new FakeSocket(); manager.attach(session.id, socket.ws);
    const [shell, args, options] = factory.mock.calls[0] as unknown as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(shell.startsWith('/')).toBe(true); expect(args).toEqual(['-l', '-i']);
    expect(options.cwd).toBe(realpathSync(dir));
    expect(Object.keys(options.env).sort()).toEqual(expect.arrayContaining(['HOME', 'PATH', 'USER', 'SHELL', 'TERM']));
    for (const key of ['LITELLM_API_KEY', 'SPEEDRAIL_DATA_DIR', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'BASH_ENV', 'ARBITRARY_SECRET']) expect(options.env[key]).toBeUndefined();
    expect(JSON.stringify(socket.sent)).not.toContain('hidden-provider-key');
  });

  it('rejects internal read-only children before session or workspace access and native spawn', () => {
    const child = store.createSession({ workspace: join(dir, 'must-not-read') });
    const identity = vi.spyOn(store, 'isChild').mockImplementation(id => id === child.id);
    const lookup = vi.spyOn(store, 'session');
    try {
      expect(() => manager.validate(child.id)).toThrow('Researcher child sessions are read-only');
      expect(() => manager.attach(child.id, new FakeSocket().ws)).toThrow('Researcher child sessions are read-only');
      expect(lookup).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
    } finally { identity.mockRestore(); lookup.mockRestore(); }
  });

  it('does not confuse ordinary fork ancestry with private child identity', () => {
    const parent = store.createSession();
    const fork = store.fork(parent.id);
    expect(fork.parentId).toBe(parent.id); expect(store.isChild(fork.id)).toBe(false);
    manager.attach(fork.id, new FakeSocket().ws);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('stops existing terminal control and detached replay when child identity is found', async () => {
    const session = store.createSession(), socket = new FakeSocket();
    manager.attach(session.id, socket.ws);
    const identity = vi.spyOn(store, 'isChild').mockImplementation(id => id === session.id);
    try {
      expect(() => manager.attach(session.id, new FakeSocket().ws)).toThrow('Researcher child sessions are read-only');
      socket.message({ type: 'input', data: 'must not execute\\r' });
      expect(ptys[0].writes).toEqual([]); expect(ptys[0].signals).toEqual(['SIGHUP']);
      await Promise.resolve();
    } finally { identity.mockRestore(); }
    const detached = store.createSession(), viewer = new FakeSocket();
    manager.attach(detached.id, viewer.ws); viewer.close();
    const changed = vi.spyOn(store, 'isChild').mockImplementation(id => id === detached.id);
    try { manager.sweep(); expect(ptys[1].signals).toEqual(['SIGHUP']); await Promise.resolve(); }
    finally { changed.mockRestore(); }
  });

  it('reattaches the same shell, replays output, and shares resize and input across viewers', () => {
    const session = store.createSession(), first = new FakeSocket(); manager.attach(session.id, first.ws);
    ptys[0].output('hello\r\n'); first.close();
    ptys[0].output('while detached\r\n');
    const second = new FakeSocket(), third = new FakeSocket(); manager.attach(session.id, second.ws); manager.attach(session.id, third.ws);
    expect(factory).toHaveBeenCalledTimes(1); expect(output(second)).toBe('hello\r\nwhile detached\r\n');
    expect(first.sent[0].terminalId).toBe(second.sent[0].terminalId);
    second.message({ type: 'input', data: 'pwd\r' }); second.message({ type: 'resize', cols: 117, rows: 37 });
    expect(ptys[0].writes).toEqual(['pwd\r']); expect([ptys[0].cols, ptys[0].rows]).toEqual([117, 37]);
    expect(third.sent.at(-1)).toEqual({ type: 'resize', cols: 117, rows: 37 });
  });

  it('keeps session terminals separate and requires an existing session', () => {
    const a = store.createSession(), b = store.createSession();
    const first = new FakeSocket(), second = new FakeSocket(); manager.attach(a.id, first.ws); manager.attach(b.id, second.ws);
    ptys[0].output('only-a'); expect(output(first)).toBe('only-a'); expect(output(second)).toBe('');
    expect(() => manager.attach('missing', new FakeSocket().ws)).toThrow('Session not found');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('bounds replay in bytes without corrupting UTF-8', () => {
    const session = store.createSession(), first = new FakeSocket(); manager.attach(session.id, first.ws); first.close();
    ptys[0].output('oldest marker\r\n' + 'あ'.repeat(TERMINAL_LIMITS.scrollbackBytes) + '\r\nnewest marker');
    const second = new FakeSocket(); manager.attach(session.id, second.ws);
    expect(Buffer.byteLength(output(second))).toBeLessThanOrEqual(TERMINAL_LIMITS.scrollbackBytes);
    expect(output(second)).not.toContain('oldest marker'); expect(output(second)).toContain('newest marker');
    expect(output(second)).not.toContain('�');
  });

  it.each([
    'not-json', 'null', '[]', { type: 'input', data: 4 }, { type: 'input', data: '' },
    { type: 'input', data: 'a'.repeat(TERMINAL_LIMITS.inputBytes + 1) },
    { type: 'resize', cols: 0, rows: 24 }, { type: 'resize', cols: 80, rows: 201 },
    { type: 'resize', cols: 80.5, rows: 24 }, { type: 'resize', cols: '80', rows: 24 },
    { type: 'resize', cols: 80, rows: 24, cwd: '/tmp' }, { type: 'input', data: 'pwd\r', workspace: '/tmp' },
    { type: 'exec', command: 'pwd' }, { type: 'ack', seq: 99 },
  ])('rejects malformed or out-of-bounds input %j', message => {
    const socket = new FakeSocket(); manager.attach(store.createSession().id, socket.ws); socket.message(message);
    expect(socket.code).toBe(1008); expect(ptys[0].writes).toEqual([]);
  });

  it('rejects binary and oversized JSON messages', () => {
    const session = store.createSession(); const a = new FakeSocket(), b = new FakeSocket();
    manager.attach(session.id, a.ws); a.message({ type: 'input', data: 'x' }, true); expect(a.code).toBe(1008);
    manager.attach(session.id, b.ws); b.message(' '.repeat(TERMINAL_LIMITS.messageBytes + 1)); expect(b.code).toBe(1008);
  });

  it('disconnects slow viewers without blocking the shell, while ACKs release output budget', () => {
    const session = store.createSession(), slow = new FakeSocket(), fast = new FakeSocket();
    manager.attach(session.id, slow.ws); manager.attach(session.id, fast.ws);
    for (let i = 0; i < 300; i++) {
      ptys[0].output('x'.repeat(8192));
      const seq = fast.sent.at(-1)?.seq;
      if (seq) fast.message({ type: 'ack', seq });
    }
    expect(slow.terminated).toBe(true); expect(fast.terminated).toBe(false); expect(ptys[0].signals).toEqual([]);
    fast.bufferedAmount = TERMINAL_LIMITS.pendingBytes; ptys[0].output('more'); expect(fast.terminated).toBe(true);
  });

  it('limits control message rates and cumulative input per connection', () => {
    const first = new FakeSocket(); manager.attach(store.createSession().id, first.ws);
    for (let i = 0; i < 301; i++) first.message({ type: 'resize', cols: 80, rows: 24 });
    expect(first.code).toBe(1008);
    const second = new FakeSocket(); manager.attach(store.createSession().id, second.ws);
    for (let i = 0; i < 9; i++) second.message({ type: 'input', data: 'x'.repeat(8192) });
    expect(second.code).toBe(1008); expect(ptys[1].writes).toHaveLength(8);
  });

  it('validates ACKs and removes unresponsive viewers on heartbeat', () => {
    const socket = new FakeSocket(); manager.attach(store.createSession().id, socket.ws);
    ptys[0].output('output'); socket.message({ type: 'ack', seq: 1 }); socket.message({ type: 'ack', seq: 1 });
    expect(socket.code).toBe(1008);
    const unresponsive = new FakeSocket(); unresponsive.ping = () => {};
    manager.attach(store.createSession().id, unresponsive.ws);
    manager.sweep(); expect(unresponsive.terminated).toBe(false);
    manager.sweep(); expect(unresponsive.terminated).toBe(true);
  });

  it('never exposes native shell errors or secret-bearing spawn details', () => {
    factory.mockImplementation(() => { throw new Error('private-secret-value from native shell'); });
    expect(() => manager.attach(store.createSession().id, new FakeSocket().ws)).toThrow('Could not start the shell.');
    try { manager.attach(store.createSession().id, new FakeSocket().ws); }
    catch (error) { expect((error as Error).message).not.toContain('private-secret-value'); }
  });

  it('enforces terminal/viewer limits and cleans up explicit close, deletion, idle and shutdown', async () => {
    const session = store.createSession(), first = new FakeSocket(); manager.attach(session.id, first.ws);
    for (let i = 1; i < TERMINAL_LIMITS.clients; i++) manager.attach(session.id, new FakeSocket().ws);
    expect(() => manager.attach(session.id, new FakeSocket().ws)).toThrow('Too many terminal viewers');
    for (let i = 1; i < TERMINAL_LIMITS.terminals; i++) manager.attach(store.createSession().id, new FakeSocket().ws);
    expect(() => manager.attach(store.createSession().id, new FakeSocket().ws)).toThrow('Terminal limit reached');
    first.message({ type: 'close' }); await Promise.resolve();
    expect(ptys[0].signals).toEqual(['SIGHUP']);
    const deleted = store.createSession(); manager.attach(deleted.id, new FakeSocket().ws); store.deleteSession(deleted.id); manager.sweep(); await Promise.resolve();
    expect(ptys.at(-1)?.signals).toEqual(['SIGHUP']);
    const idle = store.createSession(), idleSocket = new FakeSocket(); manager.attach(idle.id, idleSocket.ws); idleSocket.close();
    manager.sweep(Date.now() + TERMINAL_LIMITS.idleMs + 1); await Promise.resolve(); expect(ptys.at(-1)?.signals).toEqual(['SIGHUP']);
    await manager.close(); expect(ptys.every(pty => pty.signals.length === 1)).toBe(true);
    expect(() => manager.attach(session.id, new FakeSocket().ws)).toThrow('stopping');
  });

  it('stops a deleted session before accepting further shell input', () => {
    const session = store.createSession(), socket = new FakeSocket(); manager.attach(session.id, socket.ws);
    store.deleteSession(session.id); socket.message({ type: 'input', data: 'do not run\r' });
    expect(ptys[0].writes).toEqual([]); expect(ptys[0].signals).toEqual(['SIGHUP']);
  });

  it('reports shell exit and allows an explicitly reopened new shell', () => {
    const session = store.createSession(), first = new FakeSocket(); manager.attach(session.id, first.ws); ptys[0].exit();
    expect(first.sent.at(-1)).toEqual({ type: 'exit', exitCode: 0 }); expect(first.code).toBe(1000);
    const second = new FakeSocket(); manager.attach(session.id, second.ws);
    expect(second.sent[0].terminalId).not.toBe(first.sent[0].terminalId); expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('terminal WebSocket transport', () => {
  let dir: string, store: Store, server: Server, base: string, transport: ReturnType<typeof attachTerminals>;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'speedrail-terminal-wire-')); store = new Store(join(dir, 'state')); store.saveSettings({ workspace: dir });
    server = createServer((_req, res) => { res.writeHead(404); res.end(); }); transport = attachTerminals(server, store);
    base = await new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await transport.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  const rejectStatus = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + path, { headers }); sockets.push(socket);
    socket.on('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode!); });
    socket.on('open', () => reject(new Error('Unexpected accepted WebSocket'))); socket.on('error', () => {});
  });
  const connect = async (sessionId: string) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + `/api/sessions/${sessionId}/terminal`, { origin: base }); sockets.push(socket);
    const messages: WireMessage[] = [];
    socket.on('message', raw => { const message: WireMessage = JSON.parse(raw.toString()); messages.push(message); if (message.type === 'output') socket.send(JSON.stringify({ type: 'ack', seq: message.seq })); });
    socket.on('error', () => {});
    await until(() => messages.some(m => m.type === 'replay-end' || m.type === 'error'));
    return { socket, messages, output: () => messages.filter(m => m.type === 'output').map(m => m.data).join('') };
  };

  it('blocks cross-site, absent/malformed origin, DNS rebinding and wrong origin port before spawning', async () => {
    const id = store.createSession().id, path = `/api/sessions/${id}/terminal`;
    for (const headers of [
      {}, { Origin: 'https://evil.example' }, { Origin: 'null' }, { Origin: `${base}/path` },
      { Origin: 'http://127.0.0.1:1' }, { Origin: base.replace('http:', 'https:') },
      { Origin: base, Host: 'evil.example' }, { Origin: base, 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'http://localhost:1', Host: 'localhost:1' },
    ]) expect(await rejectStatus(path, headers as Record<string, string>)).toBe(403);
  });

  it('rejects internal read-only child WebSocket upgrades before session lookup', async () => {
    const child = store.createSession({ workspace: join(dir, 'must-not-read') });
    const identity = vi.spyOn(store, 'isChild').mockImplementation(id => id === child.id);
    const lookup = vi.spyOn(store, 'session');
    try {
      expect(await rejectStatus(`/api/sessions/${child.id}/terminal`, { Origin: base })).toBe(409);
      expect(lookup).not.toHaveBeenCalled();
    } finally { identity.mockRestore(); lookup.mockRestore(); }
  });

  it('rejects duplicate authentication headers and malformed WebSocket handshakes', async () => {
    const id = store.createSession().id, path = `/api/sessions/${id}/terminal`;
    const rawStatus = (headers: string[]) => new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + path, { headers }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    const normal = ['Host', new URL(base).host, 'Origin', base, 'Connection', 'Upgrade', 'Upgrade', 'websocket', 'Sec-WebSocket-Version', '13', 'Sec-WebSocket-Key', 'MTIzNDU2Nzg5MDEyMzQ1Ng=='];
    expect(await rawStatus([...normal, 'Origin', base])).toBe(403);
    expect(await rawStatus([...normal, 'Host', new URL(base).host])).toBe(403);
    expect(await rawStatus(['Host', new URL(base).host, 'Origin', base, 'Connection', 'Upgrade', 'Upgrade', 'websocket'])).toBe(400);
  });

  it('requires a stored session and disallows alternate workspace or secret query parameters', async () => {
    expect(await rejectStatus('/api/sessions/missing/terminal', { Origin: base })).toBe(404);
    const id = store.createSession().id;
    expect(await rejectStatus(`/api/sessions/${id}/terminal?workspace=/tmp`, { Origin: base })).toBe(400);
    expect(await rejectStatus(`/api/sessions/${id}/terminal?token=secret`, { Origin: base })).toBe(400);
    expect(await rejectStatus('/api/sessions/%2e%2e/terminal', { Origin: base })).toBe(400);
  });

  it('runs real PTY commands in a temp workspace and preserves shell state across reconnects', async context => {
    let probe: IPty;
    try { probe = spawn('/bin/bash', ['--noprofile', '--norc', '-i'], { cwd: dir, env: terminalEnvironment('/bin/bash'), cols: 80, rows: 24 }); }
    catch (error) { context.skip(`Native PTY is unavailable: ${(error as Error).message}`); return; }
    await new Promise<void>(resolve => { probe.onExit(() => resolve()); probe.write('exit\r'); });
    const session = store.createSession(), first = await connect(session.id);
    expect(first.messages.find(m => m.type === 'error')).toBeUndefined();
    first.socket.send(JSON.stringify({ type: 'input', data: "printf '__CWD_%s__\\n' \"$PWD\"; export SPEEDRAIL_TERMINAL_TEST_STATE=kept\r" }));
    await until(() => first.output().includes(`__CWD_${realpathSync(dir)}__`));
    const terminalId = first.messages.find(m => m.type === 'ready')?.terminalId;
    first.socket.close(); await until(() => first.socket.readyState === WebSocket.CLOSED);
    const second = await connect(session.id);
    expect(second.messages.find(m => m.type === 'ready')?.terminalId).toBe(terminalId);
    expect(second.output()).toContain(`__CWD_${realpathSync(dir)}__`);
    second.socket.send(JSON.stringify({ type: 'resize', cols: 101, rows: 33 }));
    second.socket.send(JSON.stringify({ type: 'input', data: "printf '__STATE_%s__\\n' \"$SPEEDRAIL_TERMINAL_TEST_STATE\"; stty size\r" }));
    await until(() => second.output().includes('__STATE_kept__') && second.output().includes('33 101'));
    second.socket.send(JSON.stringify({ type: 'input', data: 'sleep 30\r' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    second.socket.send(JSON.stringify({ type: 'input', data: '' }));
    second.socket.send(JSON.stringify({ type: 'input', data: "printf '__INT_%s__\\n' ok\r" }));
    await until(() => second.output().includes('__INT_ok__'));
    second.socket.send(JSON.stringify({ type: 'close' })); await until(() => second.messages.some(m => m.type === 'exit'));
  });
});
