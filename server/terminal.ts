import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty, type IDisposable } from 'node-pty';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Store } from './store.js';

export const TERMINAL_LIMITS = Object.freeze({
  terminals: 12, clients: 8, scrollbackBytes: 256 * 1024,
  messageBytes: 16 * 1024, inputBytes: 8 * 1024,
  pendingBytes: 2 * 1024 * 1024, idleMs: 30 * 60 * 1000,
  maxCols: 500, maxRows: 200,
});
const CHUNK_CHARS = 8192;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
type PtyFactory = typeof spawn;
type Client = { socket: WebSocket; alive: boolean; seq: number; ack: number; pending: Map<number, number>; pendingBytes: number; window: number; messages: number; inputBytes: number };
type TerminalEntry = {
  id: string; sessionId: string; cwd: string; pty: IPty; clients: Set<Client>;
  history: string; historyBytes: number; lastDetach: number; closing: boolean;
  listeners: IDisposable[]; stopped: Promise<void>; resolveStopped: () => void;
  killTimer?: ReturnType<typeof setTimeout>;
};

/** Only a small, explicit user environment crosses into the shell, never process.env wholesale. */
export function terminalEnvironment(shell: string): Record<string, string> {
  const user = userInfo();
  const env: Record<string, string> = {
    HOME: user.homedir, USER: user.username, LOGNAME: user.username, SHELL: shell,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) {
    const value = process.env[key];
    if (value && /^[a-zA-Z0-9_.@-]{1,64}$/.test(value)) env[key] = value;
  }
  return env;
}

/** One process-local shell per stored session. Detaching never destroys a running shell. */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly store: Store, private readonly spawnPty: PtyFactory = spawn) {}

  private terminalSession(sessionId: string) {
    // Private durable identity, not public parentId or caller-supplied metadata.
    // Reject before reading the workspace/login shell or starting a native PTY.
    if (this.store.isChild(sessionId)) throw fail(409, 'Researcher child sessions are read-only and cannot open a terminal.');
    return this.store.session(sessionId);
  }

  validate(sessionId: string) {
    if (this.closed) throw fail(503, 'Terminal service is stopping.');
    const session = this.terminalSession(sessionId);
    const entry = this.terminals.get(sessionId);
    if (!entry && this.terminals.size + this.stopping.size >= TERMINAL_LIMITS.terminals) throw fail(429, 'Terminal limit reached. End another shell first.');
    if (entry && entry.clients.size >= TERMINAL_LIMITS.clients) throw fail(429, 'Too many terminal viewers. Close another terminal tab.');
    return session;
  }

  attach(sessionId: string, socket: WebSocket) {
    // Repeat the lookup after the upgrade; neither URL parameters nor messages choose a directory.
    const session = this.validate(sessionId);
    let entry = this.terminals.get(sessionId);
    if (!entry) {
      if (process.platform === 'win32') throw fail(503, 'The terminal currently requires macOS or Linux.');
      let cwd: string, shell: string;
      try {
        cwd = realpathSync(session.workspace);
        if (!statSync(cwd).isDirectory()) throw new Error();
        const preferred = userInfo().shell;
        shell = preferred && isAbsolute(preferred) ? preferred : '/bin/bash';
        accessSync(shell, constants.X_OK);
      } catch { throw fail(400, 'The session workspace or login shell is no longer available.'); }
      let pty: IPty;
      try { pty = this.spawnPty(shell, ['-l', '-i'], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: terminalEnvironment(shell) }); }
      catch { throw fail(503, 'Could not start the shell. Check that node-pty is installed correctly and your login shell is executable.'); }
      let resolveStopped!: () => void;
      const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
      entry = { id: randomUUID(), sessionId, cwd, pty, clients: new Set(), history: '', historyBytes: 0, lastDetach: Date.now(), closing: false, listeners: [], stopped, resolveStopped };
      const current = entry;
      this.terminals.set(sessionId, current);
      current.listeners.push(pty.onData(data => this.output(current, data)));
      current.listeners.push(pty.onExit(({ exitCode, signal }) => {
        if (!current.closing) this.end(current, { type: 'exit', exitCode, signal });
        this.reaped(current);
      }));
      // node-pty's Unix socket errors use its legacy EventEmitter API, not onExit.
      // Without a listener an unexpected native I/O failure can crash the whole server.
      const emitter = pty as IPty & { on?: (name: string, listener: () => void) => void; removeListener?: (name: string, listener: () => void) => void };
      const onError = () => this.dispose(current, 'Terminal I/O failed. Reopen the shell to continue.');
      emitter.on?.('error', onError);
      current.listeners.push({ dispose: () => { emitter.removeListener?.('error', onError); } });
    }
    const client: Client = { socket, alive: true, seq: 0, ack: 0, pending: new Map(), pendingBytes: 0, window: Date.now(), messages: 0, inputBytes: 0 };
    const current = entry;
    current.clients.add(client);
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => { client.alive = true; });
    socket.on('close', () => {
      current.clients.delete(client);
      client.pending.clear();
      if (!current.clients.size) current.lastDetach = Date.now();
    });
    socket.on('message', (raw, binary) => this.message(current, client, raw, binary));
    this.send(client, { type: 'ready', terminalId: current.id, cols: current.pty.cols, rows: current.pty.rows });
    this.sendOutput(client, current.history, true);
    this.send(client, { type: 'replay-end' });
  }

  private send(client: Client, message: object) {
    const socket = client.socket;
    if (socket.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(message);
    if (socket.bufferedAmount + Buffer.byteLength(data) > TERMINAL_LIMITS.pendingBytes) { socket.terminate(); return false; }
    socket.send(data, error => { if (error) socket.terminate(); });
    return true;
  }

  private sendOutput(client: Client, data: string, replay = false) {
    for (let offset = 0; offset < data.length;) {
      // Never split a Unicode surrogate pair across independently encoded WebSocket frames.
      let end = Math.min(offset + CHUNK_CHARS, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const chunk = data.slice(offset, end); offset = end;
      const seq = ++client.seq;
      const bytes = Buffer.byteLength(chunk);
      if (client.pendingBytes + bytes > TERMINAL_LIMITS.pendingBytes || client.pending.size >= 4096) { client.socket.terminate(); return; }
      if (!this.send(client, { type: 'output', data: chunk, seq, replay })) return;
      client.pending.set(seq, bytes); client.pendingBytes += bytes;
    }
  }

  private output(entry: TerminalEntry, data: string) {
    if (entry.closing) return;
    entry.history += data;
    entry.historyBytes += Buffer.byteLength(data);
    if (entry.historyBytes > TERMINAL_LIMITS.scrollbackBytes) {
      const bytes = Buffer.from(entry.history);
      let start = bytes.length - TERMINAL_LIMITS.scrollbackBytes;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      entry.history = bytes.subarray(start).toString('utf8');
      entry.historyBytes = bytes.length - start;
    }
    for (const client of entry.clients) this.sendOutput(client, data);
  }

  private message(entry: TerminalEntry, client: Client, raw: RawData, binary: boolean) {
    if (entry.closing || client.socket.readyState !== WebSocket.OPEN) return;
    const bad = () => { this.send(client, { type: 'error', message: 'Invalid terminal message.' }); client.socket.close(1008, 'Invalid terminal message'); };
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
    if (binary || bytes.byteLength > TERMINAL_LIMITS.messageBytes) { bad(); return; }
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(bytes.toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      value = parsed;
    } catch { bad(); return; }
    if (Date.now() - client.window >= 1000) { client.window = Date.now(); client.messages = 0; client.inputBytes = 0; }
    // ACKs are bounded by the outstanding window instead of the keyboard/control rate.
    if (value.type === 'ack') {
      if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.seq) || (value.seq as number) <= client.ack || (value.seq as number) > client.seq) { bad(); return; }
      client.ack = value.seq as number;
      for (const [seq, size] of client.pending) {
        if (seq > client.ack) break;
        client.pendingBytes -= size; client.pending.delete(seq);
      }
      return;
    }
    if (++client.messages > 300) { bad(); return; }
    try { this.terminalSession(entry.sessionId); }
    catch { this.dispose(entry, 'Session no longer permits a terminal.'); return; }
    try {
      if (value.type === 'input' && Object.keys(value).length === 2 && typeof value.data === 'string' && value.data.length > 0 && Buffer.byteLength(value.data) <= TERMINAL_LIMITS.inputBytes) {
        client.inputBytes += Buffer.byteLength(value.data);
        if (client.inputBytes > 64 * 1024) { bad(); return; }
        entry.pty.write(value.data);
      } else if (value.type === 'resize' && Object.keys(value).length === 3 && Number.isInteger(value.cols) && Number.isInteger(value.rows) && (value.cols as number) >= 2 && (value.cols as number) <= TERMINAL_LIMITS.maxCols && (value.rows as number) >= 1 && (value.rows as number) <= TERMINAL_LIMITS.maxRows) {
        entry.pty.resize(value.cols as number, value.rows as number);
        for (const viewer of entry.clients) this.send(viewer, { type: 'resize', cols: value.cols, rows: value.rows });
      } else if (value.type === 'close' && Object.keys(value).length === 1) this.dispose(entry, 'Shell ended.');
      else bad();
    } catch { this.dispose(entry, 'The shell is no longer available.'); }
  }

  /** Called by the transport heartbeat; also checks deletion while a shell is detached. */
  sweep(now = Date.now()) {
    for (const entry of this.terminals.values()) {
      try { this.terminalSession(entry.sessionId); }
      catch { this.dispose(entry, 'Session no longer permits a terminal.'); continue; }
      if (!entry.clients.size && now - entry.lastDetach >= TERMINAL_LIMITS.idleMs) { this.dispose(entry, 'Detached shell expired after 30 minutes.'); continue; }
      for (const client of entry.clients) {
        if (!client.alive) client.socket.terminate();
        else { client.alive = false; if (client.socket.readyState === WebSocket.OPEN) client.socket.ping(); }
      }
    }
  }

  private end(entry: TerminalEntry, message: object) {
    entry.closing = true;
    if (this.terminals.get(entry.sessionId) === entry) this.terminals.delete(entry.sessionId);
    for (const client of entry.clients) {
      this.send(client, message);
      client.socket.close(1000, 'Terminal ended');
      // Do not let a peer that ignores the close handshake retain a socket indefinitely.
      const socket = client.socket;
      const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
      socket.once('close', () => clearTimeout(timer));
    }
    entry.history = ''; entry.historyBytes = 0;
  }

  private dispose(entry: TerminalEntry, reason: string) {
    if (entry.closing) return;
    this.end(entry, { type: 'exit', reason });
    this.stopping.add(entry.stopped);
    // Login shells normally forward SIGHUP to their jobs. Disowned/detached processes are not a sandbox.
    try { entry.pty.kill('SIGHUP'); } catch { /* Already exited. */ }
    entry.killTimer = setTimeout(() => {
      try { entry.pty.kill('SIGKILL'); } catch { /* Already exited. */ }
      // Native exit callbacks can fail during shutdown; never block application teardown forever.
      this.reaped(entry);
    }, 1000);
    entry.killTimer.unref();
  }

  private reaped(entry: TerminalEntry) {
    clearTimeout(entry.killTimer);
    for (const listener of entry.listeners.splice(0)) listener.dispose();
    this.stopping.delete(entry.stopped);
    entry.resolveStopped();
  }

  async close() {
    this.closed = true;
    for (const entry of this.terminals.values()) this.dispose(entry, 'Terminal service stopped.');
    await Promise.all(this.stopping);
  }
}

function trustedUpgrade(req: IncomingMessage) {
  const remote = req.socket.remoteAddress;
  if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const host = req.headers.host, origin = req.headers.origin;
  if (req.method !== 'GET' || !host || !origin || req.headers['sec-fetch-site'] === 'cross-site') return false;
  for (const name of ['host', 'origin']) {
    if (req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length !== 1) return false;
  }
  try {
    const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
    const target = new URL(`${protocol}//${host}`), source = new URL(origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return false;
    if (target.host !== host.toLowerCase() || target.username || target.password) return false;
    if (Number(target.port || (protocol === 'https:' ? 443 : 80)) !== req.socket.localPort) return false;
    return source.origin === target.origin && origin === source.origin;
  } catch { return false; }
}

/** Mount on the same HTTP server as the API. Call close() before closing Store during shutdown. */
export function attachTerminals(server: Server, store: Store): { close(): Promise<void> } {
  const manager = new TerminalManager(store);
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_LIMITS.messageBytes, perMessageDeflate: false, clientTracking: true });
  let closing: Promise<void> | undefined;
  const reject = (socket: Duplex, status: number) => {
    const reason = ({ 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 503: 'Service Unavailable' } as Record<number, string>)[status] || 'Bad Request';
    socket.on('error', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Leave unrelated upgrades (e.g. development HMR) to their own listeners.
    if (!req.url?.startsWith('/api/')) return;
    if (!trustedUpgrade(req)) { reject(socket, 403); return; }
    const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})\/terminal$/.exec(req.url);
    if (!match) { reject(socket, 400); return; }
    try { manager.validate(match[1]); }
    catch (error) { reject(socket, (error as { status?: number }).status || 503); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => ws.terminate());
      try { manager.attach(match[1], ws); }
      catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: (error as { status?: number }).status ? (error as Error).message : 'Terminal unavailable.' }));
        ws.close(1011, 'Terminal unavailable');
        const timer = setTimeout(() => ws.terminate(), 1000); timer.unref();
        ws.once('close', () => clearTimeout(timer));
      }
    });
  };
  const heartbeat = setInterval(() => manager.sweep(), 30_000); heartbeat.unref();
  const close = () => closing ||= (async () => {
    clearInterval(heartbeat);
    server.off('upgrade', upgrade); server.off('close', onClose);
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    await manager.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  })();
  const onClose = () => { void close(); };
  const onSignal = () => { void close(); };
  server.on('upgrade', upgrade); server.once('close', onClose);
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  return { close };
}
