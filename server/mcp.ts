import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, JSONRPCMessageSchema, ListToolsResultSchema, ToolListChangedNotificationSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig, Settings, ToolDefinition } from '../shared/types.js';
import type { McpServerStatus } from '../shared/mcp.js';
import type { ExternalTools, ExternalToolLease } from './external.js';

export const MCP_LIMITS = {
  servers: 30, operations: 8, operationMs: 30_000, requestMs: 15_000,
  pages: 20, tools: 1000, catalogBytes: 1024 * 1024,
  toolMs: 60_000, outputBytes: 100_000,
  frameBytes: 2 * 1024 * 1024, schemaDepth: 64,
} as const;

class SafeError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
const cancelled = () => new SafeError('MCP operation cancelled.', 409);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function bounded(text: string, max: number) {
  const bytes = Buffer.from(text); if (bytes.length <= max) return text;
  let end = max; while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function secrets(config: McpServerConfig): string[] {
  const values = Object.values(config.env ?? {});
  if (config.url) {
    try {
      const url = new URL(config.url); values.push(url.username, url.password, ...url.searchParams.values());
      for (const encoded of [url.username, url.password]) { try { values.push(decodeURIComponent(encoded)); } catch { /* Never expose malformed URL text. */ } }
    } catch { /* Invalid configuration is reported generically. */ }
  }
  return [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
}
function clean(text: string, config: McpServerConfig, max: number = MCP_LIMITS.outputBytes) {
  for (const secret of secrets(config)) text = text.split(secret).join('[redacted]');
  // Strip terminal escapes and invisible/control characters, retaining newlines and tabs.
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cf}\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, '');
  return bounded(text, max);
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function deadline(signals: AbortSignal[], ms: number) {
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(), ms); timer.unref();
  return { signal: AbortSignal.any([...signals, timerController.signal]), clear: () => clearTimeout(timer) };
}

/** The SDK's stdio reader has no frame limit. Bound bytes before parsing, use
 * only its allowlisted environment, discard stderr, and await child termination. */
class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private stopped = false;
  private closing?: Promise<void>;
  private exited?: Promise<void>;
  constructor(private config: McpServerConfig) {}
  async start() {
    if (this.child || this.stopped) throw new SafeError('MCP transport is unavailable.');
    const child = spawn(this.config.command!, this.config.args ?? [], {
      env: { ...getDefaultEnvironment(), ...this.config.env }, shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = new Promise(resolve => child.once('close', () => { this.stopped = true; this.onclose?.(); resolve(); }));
    child.stderr.resume(); // Drain and discard; never retain, log, or expose stderr.
    child.stdin.on('error', () => this.onerror?.(new SafeError('MCP transport failed.')));
    child.stdout.on('error', () => this.fail());
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        this.bytes += i - start;
        if (this.bytes > MCP_LIMITS.frameBytes) { this.fail(); return; }
        this.chunks.push(chunk.subarray(start, i));
        const line = Buffer.concat(this.chunks, this.bytes);
        this.chunks = []; this.bytes = 0; start = i + 1;
        try { this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))); }
        catch { this.fail(); return; }
        if (this.stopped) return;
      }
      if (start < chunk.length) {
        this.bytes += chunk.length - start;
        if (this.bytes > MCP_LIMITS.frameBytes) { this.fail(); return; }
        this.chunks.push(chunk.subarray(start));
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.on('error', () => { const error = new SafeError('Unable to start MCP server.'); this.onerror?.(error); reject(error); });
    });
  }
  private fail() { this.onerror?.(new SafeError('Invalid or oversized MCP transport data.')); void this.close(); }
  async send(message: JSONRPCMessage) {
    if (this.stopped || !this.child?.stdin.writable) throw new SafeError('MCP transport is unavailable.');
    const text = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(text) > MCP_LIMITS.frameBytes) throw new SafeError('MCP request is too large.', 400);
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(text, error => error ? reject(new SafeError('MCP transport failed.')) : resolve()));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.chunks = []; this.bytes = 0;
    const child = this.child;
    this.closing = (async () => {
      if (!child) { this.onclose?.(); return; }
      child.stdin.end();
      const wait = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); timer.unref(); })]);
        clearTimeout(timer);
      };
      await wait(500);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await wait(500); }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await this.exited;
    })();
    return this.closing;
  }
}

/** Bound JSON bodies and individual SSE events before the SDK parser buffers
 * them. HTTP redirects and transport retries are never implicit authorization. */
function guardedFetch(lifetime: AbortSignal): FetchLike {
  return async (input, init) => {
    let toolCall = false;
    try { toolCall = typeof init?.body === 'string' && JSON.parse(init.body).method === 'tools/call'; } catch { /* No data or errors from the request are exposed. */ }
    const request = deadline([lifetime, ...(init?.signal ? [init.signal] : [])], toolCall ? MCP_LIMITS.toolMs : MCP_LIMITS.requestMs);
    let response: Response;
    try { response = await fetch(input, { ...init, redirect: 'error', signal: request.signal }); }
    catch (error) { request.clear(); throw error; }
    // GET event streams are long-lived; POST response bodies retain their
    // request deadline, including a peer that sends headers then never ends.
    if (!response.body || !init?.method || init.method === 'GET') request.clear();
    if (!response.body) return response;
    const reader = response.body.getReader();
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    let bytes = 0, line = 0, previous = -1;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { request.clear(); controller.close(); return; }
          if (sse) {
            for (const byte of chunk.value) {
              bytes++; line++;
              if (bytes > MCP_LIMITS.frameBytes) throw new SafeError('MCP response is too large.');
              if (byte === 10) { if (line === 1 || (line === 2 && previous === 13)) bytes = 0; line = 0; }
              previous = byte;
            }
          } else { bytes += chunk.value.byteLength; if (bytes > MCP_LIMITS.frameBytes) throw new SafeError('MCP response is too large.'); }
          controller.enqueue(chunk.value);
        } catch { request.clear(); controller.error(new SafeError('Invalid MCP response.')); await reader.cancel().catch(() => {}); }
      },
      cancel: reason => { request.clear(); return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

interface Connection {
  client: Client;
  transport: Transport;
  lifetime: AbortController;
  ready: boolean;
  sends: Set<Promise<void>>;
  cancellations: Set<Promise<void>>;
  closing?: Promise<void>;
}
interface Catalog {
  definitions: readonly ToolDefinition[];
  names: ReadonlyMap<string, string>;
  digest: string;
}
interface Entry {
  name: string;
  config: McpServerConfig;
  fingerprint: string;
  generation: number;
  validity: AbortController;
  status: McpServerStatus['status'];
  error?: string;
  reason?: string;
  updatedAt: number;
  connection?: Connection;
  catalog?: Catalog;
  operation?: AbortController;
}

export class McpManager implements ExternalTools {
  private entries = new Map<string, Entry>();
  private nonce = randomUUID();
  private generation = 0;
  private operationCount = 0;
  private work = new Set<Promise<unknown>>();
  private shutdown = new AbortController();
  private closing?: Promise<void>;
  private configDigest = '';
  constructor(private getConfig: () => Settings['mcpServers']) {}

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.then(() => this.work.delete(promise), () => this.work.delete(promise));
    return promise;
  }
  private invalidate(entry: Entry) {
    entry.generation = ++this.generation;
    entry.catalog = undefined;
    entry.validity.abort(); entry.validity = new AbortController();
    entry.updatedAt = Date.now();
  }
  private dispose(connection?: Connection): Promise<void> {
    if (!connection) return Promise.resolve();
    if (connection.closing) return connection.closing;
    connection.ready = false;
    connection.closing = this.track((async () => {
      // The SDK sends cancellation without awaiting it. Give that notification
      // a bounded flush before aborting HTTP, otherwise close can erase it.
      if (connection.cancellations.size) {
        const flush = deadline([], 1000);
        try { await abortable(Promise.allSettled([...connection.cancellations]), flush.signal); } catch { /* Best effort; no delivery guarantee. */ }
        finally { flush.clear(); }
      }
      connection.lifetime.abort();
      await connection.client.close().catch(() => {});
      await connection.transport.close().catch(() => {});
      await Promise.allSettled([...connection.sends]);
    })());
    return connection.closing;
  }
  /** Reconciliation invalidates synchronously; it may close old connections but
   * never starts a process, makes a connection, or asks for tools. */
  private reconcile() {
    if (this.shutdown.signal.aborted) return;
    const configs = this.getConfig();
    const revision = digest(configs);
    if (revision === this.configDigest) return;
    if (Object.keys(configs).length > MCP_LIMITS.servers) {
      for (const entry of this.entries.values()) { this.invalidate(entry); entry.operation?.abort(); void this.dispose(entry.connection); entry.connection = undefined; entry.status = 'error'; entry.error = 'Too many configured MCP servers.'; }
      throw new SafeError('At most 30 MCP servers may be configured.', 400);
    }
    for (const [name, old] of this.entries) {
      if (!Object.hasOwn(configs, name) || digest(configs[name]) !== old.fingerprint) {
        this.invalidate(old); old.operation?.abort(); void this.dispose(old.connection); this.entries.delete(name);
      }
    }
    for (const [name, config] of Object.entries(configs)) {
      if (this.entries.has(name)) continue;
      this.entries.set(name, {
        name, config: freeze(structuredClone(config)), fingerprint: digest(config),
        generation: ++this.generation, validity: new AbortController(),
        status: config.enabled === false ? 'disabled' : 'disconnected', updatedAt: Date.now(),
        reason: config.enabled === false ? 'Disabled in saved configuration.' : 'Explicit refresh or reconnect required.',
      });
    }
    this.configDigest = revision;
  }
  configRevision(): string { this.reconcile(); return this.configDigest; }
  private revision(entry: Entry) { return digest([this.nonce, entry.fingerprint, entry.generation]); }
  status(): McpServerStatus[] {
    this.reconcile();
    return [...this.entries.values()].map(entry => ({
      name: entry.name, revision: this.revision(entry), status: entry.status,
      tools: entry.catalog?.definitions.map(tool => ({ name: tool.function.name, remoteName: entry.catalog!.names.get(tool.function.name)!, description: tool.function.description })) ?? [],
      ...(entry.error ? { error: entry.error } : {}), ...(entry.reason ? { reason: entry.reason } : {}), updatedAt: entry.updatedAt,
    }));
  }
  capture(signal: AbortSignal): ExternalToolLease {
    this.reconcile();
    if (signal.aborted || this.shutdown.signal.aborted) throw cancelled();
    const routes = new Map<string, { entry: Entry; connection: Connection; generation: number; remote: string; scope: string; validity: AbortSignal }>();
    const definitions: ToolDefinition[] = [];
    // Gateway partition, frozen with the lease: a tool routes through the
    // capability gateway unless its server opted into direct advertisement
    // (advertise: true). Membership is read from the entry's pinned config, so
    // a later settings edit cannot repartition an accepted turn.
    const gateway = new Map<string, string>();
    for (const entry of this.entries.values()) {
      if (entry.status !== 'connected' || !entry.connection?.ready || !entry.catalog) continue;
      for (const definition of entry.catalog.definitions) {
        const name = definition.function.name;
        if (routes.has(name)) throw new SafeError('Ambiguous MCP tool catalog.');
        routes.set(name, { entry, connection: entry.connection, generation: entry.generation, remote: entry.catalog.names.get(name)!, scope: digest([entry.name, entry.fingerprint, entry.catalog.digest]), validity: entry.validity.signal });
        if (entry.config.advertise !== true) gateway.set(name, entry.name);
        definitions.push(definition);
      }
    }
    const released = new AbortController();
    const assert = (name: string) => {
      this.reconcile();
      const route = routes.get(name);
      if (signal.aborted || released.signal.aborted || this.shutdown.signal.aborted) throw cancelled();
      if (!route || this.entries.get(route.entry.name) !== route.entry || route.entry.generation !== route.generation || route.entry.status !== 'connected' || route.entry.connection !== route.connection || !route.connection.ready || route.validity.aborted) {
        throw new SafeError('The accepted MCP tool catalog is stale. Review MCP settings and explicitly refresh before a new turn.');
      }
      return route;
    };
    return Object.freeze({
      definitions: freeze(definitions),
      gatewayTools: () => gateway,
      scope: (name: string) => assert(name).scope,
      assertCurrent: (name: string) => { assert(name); },
      execute: (name: string, args: Record<string, unknown>, requestSignal: AbortSignal) => {
        const operation = (async () => {
          const route = assert(name);
          const request = deadline([signal, released.signal, requestSignal, route.validity, route.connection.lifetime.signal, this.shutdown.signal], MCP_LIMITS.toolMs);
          try {
            if (request.signal.aborted) throw cancelled();
            if (Buffer.byteLength(JSON.stringify(args)) > MCP_LIMITS.catalogBytes) throw new SafeError('MCP arguments are too large.', 400);
            // Use the captured client and remote name. There is deliberately no
            // live lookup, rediscovery, retry, task execution, or resource fetch.
            const result = await abortable(route.connection.client.request({ method: 'tools/call', params: { name: route.remote, arguments: args } }, CallToolResultSchema, { signal: request.signal, timeout: MCP_LIMITS.toolMs }), request.signal);
            assert(name); if (request.signal.aborted) throw cancelled();
            const pieces: string[] = []; let remaining = MCP_LIMITS.outputBytes;
            for (const part of result.content) {
              const text = clean(part.type === 'text' ? part.text : `[${part.type} content omitted]`, route.entry.config, remaining);
              pieces.push(text); remaining -= Buffer.byteLength(text) + 1; if (remaining <= 0) break;
            }
            const text = clean(pieces.join('\n') || (result.structuredContent ? JSON.stringify(result.structuredContent) : ''), route.entry.config);
            if (result.isError) throw new SafeError(text || 'The MCP tool returned an error.', 502);
            return text;
          } catch (error) {
            if (request.signal.aborted) throw cancelled();
            if (error instanceof SafeError) throw error;
            throw new SafeError('The MCP tool request failed. It was not retried.', 502);
          } finally { request.clear(); }
        })();
        return this.track(operation);
      },
      release: () => released.abort(),
    });
  }
  refresh(name: string, expectedRevision: string, signal: AbortSignal) { return this.operate(name, expectedRevision, signal, false); }
  reconnect(name: string, expectedRevision: string, signal: AbortSignal) { return this.operate(name, expectedRevision, signal, true); }

  private operate(name: string, expectedRevision: string, signal: AbortSignal, reconnect: boolean): Promise<McpServerStatus[]> {
    // All authorization/revision checks and invalidation precede the first await.
    try {
      this.reconcile();
      if (this.shutdown.signal.aborted || signal.aborted) throw cancelled();
      const entry = this.entries.get(name);
      if (!entry) throw new SafeError('MCP server is not configured.', 404);
      if (expectedRevision !== this.revision(entry)) throw new SafeError('MCP server state changed. Review current status before retrying.');
      if (entry.config.enabled === false) throw new SafeError('MCP server is disabled.');
      if (entry.operation) throw new SafeError('An MCP lifecycle operation is already in progress.');
      if (this.operationCount >= MCP_LIMITS.operations) throw new SafeError('Too many MCP lifecycle operations are in progress.', 429);
      this.validateConfig(entry);
      if (!reconnect && (!entry.connection?.ready || !['connected', 'stale'].includes(entry.status))) throw new SafeError('MCP server is disconnected. Explicit reconnect required.');
      const reuse = !reconnect ? entry.connection : undefined;
      this.invalidate(entry);
      entry.status = reuse ? 'refreshing' : 'connecting'; entry.error = undefined; entry.reason = undefined;
      const generation = entry.generation, controller = new AbortController(); entry.operation = controller; this.operationCount++;
      const operation = deadline([signal, controller.signal, this.shutdown.signal], MCP_LIMITS.operationMs);
      return this.track((async () => {
        try {
          if (!reuse) { await this.dispose(entry.connection); entry.connection = undefined; }
          if (operation.signal.aborted) throw cancelled();
          const connection = reuse ?? await this.open(entry, operation.signal);
          const catalog = await this.discover(entry, connection, operation.signal);
          this.reconcile();
          if (operation.signal.aborted || this.entries.get(name) !== entry || entry.generation !== generation || !connection.ready) throw cancelled();
          entry.catalog = catalog; entry.status = 'connected'; entry.updatedAt = Date.now();
          return this.status();
        } catch (error) {
          if (this.entries.get(name) === entry && entry.generation === generation) {
            this.invalidate(entry); entry.status = operation.signal.aborted ? 'disconnected' : 'error';
            entry.error = operation.signal.aborted ? undefined : 'Unable to load MCP tools. Check the saved configuration and server, then explicitly retry.';
            entry.reason = operation.signal.aborted ? 'Operation cancelled or timed out. Explicit retry required.' : undefined;
          }
          const connection = entry.connection; entry.connection = undefined;
          if (this.entries.get(name) === entry && entry.operation === controller && entry.status === 'stale') {
            // A notification invalidated this operation's generation; its
            // aborted discovery cannot leave a refresh-only state without a client.
            entry.status = 'disconnected'; entry.reason = 'Catalog changed during discovery. Explicit reconnect required.'; entry.updatedAt = Date.now();
          }
          await this.dispose(connection);
          if (operation.signal.aborted) throw cancelled();
          if (error instanceof SafeError) throw error;
          throw new SafeError('Unable to load MCP tools. The operation was not retried.', 502);
        } finally { operation.clear(); entry.operation = undefined; this.operationCount--; }
      })());
    } catch (error) { return Promise.reject(error); }
  }
  private validateConfig(entry: Entry) {
    const config = entry.config;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name) || Boolean(config.command) === Boolean(config.url)) throw new SafeError('Invalid MCP configuration.', 400);
    if (config.command && (config.command.length > 1000 || config.command.includes('\0') || (config.args?.length ?? 0) > 100 || config.args?.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0')))) throw new SafeError('Invalid MCP command configuration.', 400);
    if (Object.entries(config.env ?? {}).some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0'))) throw new SafeError('Invalid MCP environment configuration.', 400);
    if (config.url) {
      try { const url = new URL(config.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
      catch { throw new SafeError('MCP URL must use HTTP or HTTPS.', 400); }
    }
  }
  private createConnection(entry: Entry, legacy: boolean): Connection {
    const lifetime = new AbortController();
    const fetch = guardedFetch(lifetime.signal);
    const transport: Transport = entry.config.command ? new BoundedStdioTransport(entry.config) : legacy
      ? new SSEClientTransport(new URL(entry.config.url!), { fetch, eventSourceInit: { fetch } })
      : new StreamableHTTPClientTransport(new URL(entry.config.url!), { fetch, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
    const client = new Client({ name: 'speedrail', version: '0.1.0' }, { capabilities: {} });
    const connection: Connection = { client, transport, lifetime, ready: false, sends: new Set(), cancellations: new Set() };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      const pending = send(message, options); connection.sends.add(pending);
      if ('method' in message && message.method === 'notifications/cancelled') connection.cancellations.add(pending);
      const settled = () => { connection.sends.delete(pending); connection.cancellations.delete(pending); };
      void pending.then(settled, settled);
      return pending;
    };
    const disconnected = () => {
      if (!connection.ready || connection.closing || entry.connection !== connection) return;
      this.invalidate(entry); entry.operation?.abort(); entry.connection = undefined;
      entry.status = 'disconnected'; entry.reason = 'Connection closed. Explicit reconnect required.'; entry.error = undefined;
      void this.dispose(connection);
    };
    // Transport failures invalidate; late protocol response warnings after a
    // cancellation do not. Never log either class of raw server error.
    transport.onerror = () => {
      if (connection.ready) disconnected();
      else if (legacy) void this.dispose(connection); // EventSource must not retry.
    };
    client.onclose = disconnected;
    client.onerror = () => {};
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (connection.closing || entry.connection !== connection) return;
      this.invalidate(entry); entry.operation?.abort(); entry.status = 'stale';
      entry.reason = 'The server changed its tool catalog. Explicit refresh required.'; entry.error = undefined;
    });
    return connection;
  }
  private async open(entry: Entry, signal: AbortSignal): Promise<Connection> {
    let connection = this.createConnection(entry, false); entry.connection = connection;
    try { await abortable(connection.client.connect(connection.transport, { signal, timeout: MCP_LIMITS.requestMs }), signal); }
    catch (error) {
      // Legacy SSE is protocol negotiation only, not an authentication/network
      // fallback. A fresh client is used; no tools/call is ever repeated.
      const fallback = entry.config.url && error instanceof StreamableHTTPError && [404, 405].includes(error.code ?? 0) && !signal.aborted;
      // Detach first so close cannot invalidate this operation's generation.
      if (entry.connection === connection) entry.connection = undefined;
      await this.dispose(connection);
      if (!fallback) throw error;
      connection = this.createConnection(entry, true); entry.connection = connection;
      await abortable(connection.client.connect(connection.transport, { signal, timeout: MCP_LIMITS.requestMs }), signal);
    }
    if (signal.aborted || entry.connection !== connection || connection.closing) throw cancelled();
    connection.ready = true;
    return connection;
  }
  private async discover(entry: Entry, connection: Connection, signal: AbortSignal): Promise<Catalog> {
    const definitions: ToolDefinition[] = [], names = new Map<string, string>(), remoteNames = new Set<string>(), cursors = new Set<string>();
    const identity: unknown[] = [];
    let cursor: string | undefined, bytes = 0;
    for (let page = 0; page < MCP_LIMITS.pages; page++) {
      const result = await abortable(connection.client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, ListToolsResultSchema, { signal, timeout: MCP_LIMITS.requestMs }), signal);
      for (const tool of result.tools) {
        if (definitions.length >= MCP_LIMITS.tools || !tool.name || tool.name.length > 128 || /[\p{Cc}\p{Cf}]/u.test(tool.name) || remoteNames.has(tool.name)) throw new SafeError('Invalid or duplicate MCP tool names.');
        remoteNames.add(tool.name);
        bytes += Buffer.byteLength(JSON.stringify(tool));
        if (bytes > MCP_LIMITS.catalogBytes) throw new SafeError('MCP catalog is too large.');
        if (tool.execution?.taskSupport === 'required') throw new SafeError('Task-only MCP tools are not supported.');
        this.validateSchema(tool.inputSchema);
        const schema = JSON.stringify(tool.inputSchema);
        if (secrets(entry.config).some(secret => tool.name.includes(secret) || schema.includes(secret))) throw new SafeError('MCP catalog contains configured credentials.');
        const raw = `${entry.name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const suffix = createHash('sha256').update(`${entry.name}\0${tool.name}`).digest('hex').slice(0, 8);
        const name = `mcp_${raw.slice(0, 48)}_${suffix}`;
        if (names.has(name)) throw new SafeError('MCP tool name collision.');
        names.set(name, tool.name);
        definitions.push({ type: 'function', function: { name, description: clean(`[${entry.name}] ${tool.description || tool.name}`, entry.config, 8000), parameters: structuredClone(tool.inputSchema) } });
        identity.push(tool);
      }
      if (result.nextCursor === undefined) {
        identity.sort((a, b) => (a as { name: string }).name < (b as { name: string }).name ? -1 : 1);
        return { definitions: freeze(definitions), names, digest: digest(identity) };
      }
      if (!result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) throw new SafeError('Invalid MCP pagination cursor.');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new SafeError('MCP catalog exceeds the pagination limit.');
  }
  private validateSchema(schema: unknown) {
    const visit = (value: unknown, depth: number) => {
      if (depth > MCP_LIMITS.schemaDepth) throw new SafeError('MCP tool schema is too deeply nested.');
      if (value === null || typeof value !== 'object') return;
      for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(schema, 0);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema as { type?: unknown }).type !== 'object') throw new SafeError('MCP tools require an object input schema.');
    const invalid = () => { throw new SafeError('Invalid MCP tool input schema.'); };
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const strings = (value: unknown) => Array.isArray(value) && value.every(key => typeof key === 'string') && new Set(value).size === value.length;
    const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
    const validate = (value: unknown) => {
      if (typeof value === 'boolean') return;
      if (!record(value)) return invalid();
      for (const [key, item] of Object.entries(value)) {
        if (key === 'type' && !(typeof item === 'string' ? types.has(item) : strings(item) && (item as string[]).length > 0 && (item as string[]).every(type => types.has(type)))) invalid();
        if (['$id', '$ref', '$schema', '$anchor', '$dynamicRef', 'title', 'description', 'pattern', 'format', 'contentEncoding', 'contentMediaType'].includes(key) && typeof item !== 'string') invalid();
        if (['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'].includes(key) && typeof item !== 'boolean') invalid();
        if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key) && (typeof item !== 'number' || !Number.isFinite(item) || (key === 'multipleOf' && item <= 0))) invalid();
        if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains'].includes(key) && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) invalid();
        if (key === 'required' && !strings(item)) invalid();
        if (key === 'enum' && (!Array.isArray(item) || !item.length || new Set(item.map(canonical)).size !== item.length)) invalid();
        if (['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'].includes(key)) {
          if (!record(item)) return invalid();
          for (const child of Object.values(item)) validate(child);
        }
        if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
          if (!Array.isArray(item) || !item.length) return invalid();
          for (const child of item) validate(child);
        }
        if (key === 'items' && Array.isArray(item)) { if (!item.length) invalid(); for (const child of item) validate(child); }
        else if (['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'].includes(key)) validate(item);
        if (key === 'dependentRequired') { if (!record(item) || Object.values(item).some(child => !strings(child))) invalid(); }
        if (key === 'dependencies') { if (!record(item)) return invalid(); for (const child of Object.values(item)) { if (Array.isArray(child)) { if (!strings(child)) invalid(); } else validate(child); } }
      }
    };
    // Validate schema structure without compiling patterns, resolving references,
    // or loading any external schema. Defaults/examples remain inert JSON.
    validate(schema);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.shutdown.abort();
    for (const entry of this.entries.values()) {
      this.invalidate(entry); entry.operation?.abort(); entry.status = entry.config.enabled === false ? 'disabled' : 'disconnected'; entry.error = undefined; entry.reason = 'MCP manager closed.';
      void this.dispose(entry.connection); entry.connection = undefined;
    }
    this.closing = (async () => { while (this.work.size) await Promise.allSettled([...this.work]); })();
    return this.closing;
  }
}
