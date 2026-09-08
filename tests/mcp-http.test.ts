import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpManager } from '../server/mcp.js';
import type { Settings } from '../shared/types.js';

// Real SDK servers and transports on ephemeral loopback ports. No provider,
// subprocess, environment credentials, or externally reachable endpoint is used.
type RemoteTool = { name: string; description?: string; inputSchema: { type: 'object'; [key: string]: unknown } };
type Page = { tools: RemoteTool[]; nextCursor?: string };
const tool = (name: string): RemoteTool => ({ name, description: `Remote ${name}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
const fixtures: { close(): Promise<void> }[] = [];
const managers: McpManager[] = [];
const signal = () => new AbortController().signal;
async function until(check: () => boolean | Promise<boolean>) {
  await expect.poll(check, { timeout: 5000, interval: 10 }).toBe(true);
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

async function remoteFixture(kind: 'http' | 'sse', options: {
  page?: (cursor: string | undefined, index: number, signal: AbortSignal) => Page | Promise<Page>;
  failure?: string;
  initializationStatus?: number;
  redirect?: { to: string; when: 'initialize' | 'call' };
  oversizedCommentEvent?: boolean;
} = {}) {
  const requests: { method: string; path: string; rpc?: string }[] = [];
  const listings: (string | undefined)[] = [];
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const cancelled: string[] = [];
  const closedRequests: string[] = [];
  let getStreams = 0;
  const transports = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();
  const servers = new Set<Server>();
  let catalog = [tool('echo'), tool('fail'), tool('slow')];
  let initialized = 0;
  let stopped = false;
  function sdkServer() {
    const server = new Server({ name: 'loopback-remote-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const index = listings.length; listings.push(request.params?.cursor);
      return options.page ? await options.page(request.params?.cursor, index, extra.signal) : { tools: catalog };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls.push(request.params);
      if (request.params.name === 'slow') {
        await new Promise<void>(resolve => {
          if (extra.signal.aborted) { cancelled.push(request.params.name); resolve(); return; }
          extra.signal.addEventListener('abort', () => { cancelled.push(request.params.name); resolve(); }, { once: true });
        });
        return { content: [{ type: 'text', text: 'Cancelled remote operation.' }] };
      }
      if (request.params.name === 'fail') return { isError: true, content: [{ type: 'text', text: options.failure ?? 'Remote fixture failure.' }] };
      return { content: [{ type: 'text', text: `remote:${request.params.arguments?.text ?? ''}` }] };
    });
    servers.add(server); return server;
  }
  // Each data line is small; colon-only comments are not event delimiters.
  // The aggregate event must still hit the 2 MiB pre-parser frame bound.
  const oversizedEvent = options.oversizedCommentEvent ? (`data: ${' '.repeat(4096)}\n:\n`.repeat(513)) : '';
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      requests.push({ method: req.method!, path: url.pathname, ...(body?.method ? { rpc: body.method } : {}) });
      if (body?.method) res.on('close', () => { closedRequests.push(body.method); });
      if (options.initializationStatus) { res.writeHead(options.initializationStatus, { 'Content-Type': 'text/plain' }); res.end(options.failure ?? 'Fixture initialization failed.'); return; }
      if (options.redirect && (options.redirect.when === 'call' ? body?.method === 'tools/call' : kind === 'http' ? body?.method === 'initialize' : req.method === 'GET' && url.pathname === '/sse')) {
        res.writeHead(307, { Location: options.redirect.to }); res.end(); return;
      }
      if (kind === 'sse' && url.pathname === '/sse') {
        if (req.method !== 'GET') { res.writeHead(405); res.end('Use the legacy SSE endpoint.'); return; }
        if (options.oversizedCommentEvent) {
          const write = res.write.bind(res);
          res.write = ((...args: Parameters<typeof res.write>) => {
            const text = String(args[0]);
            return text.includes('"tools":[') ? write(oversizedEvent) : write(...args);
          }) as typeof res.write;
        }
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport); initialized++;
        await sdkServer().connect(transport); return;
      }
      if (kind === 'sse' && url.pathname === '/messages') {
        const transport = transports.get(url.searchParams.get('sessionId') ?? '');
        if (!(transport instanceof SSEServerTransport)) { res.writeHead(404); res.end(); return; }
        await transport.handlePostMessage(req, res, body); return;
      }
      if (kind === 'http' && url.pathname === '/mcp') {
        if (options.oversizedCommentEvent && body?.method === 'tools/list') {
          listings.push(body.params?.cursor); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(oversizedEvent); return;
        }
        const id = req.headers['mcp-session-id'];
        let transport = typeof id === 'string' ? transports.get(id) : undefined;
        if (!transport && req.method === 'POST' && isInitializeRequest(body)) {
          const created = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => { transports.set(id, created); } });
          transport = created; initialized++;
          await sdkServer().connect(created);
        }
        if (!(transport instanceof StreamableHTTPServerTransport)) { res.writeHead(404); res.end(); return; }
        if (req.method === 'GET') {
          const writeHead = res.writeHead.bind(res);
          res.writeHead = ((...args: Parameters<typeof res.writeHead>) => { getStreams++; return writeHead(...args); }) as typeof res.writeHead;
        }
        await transport.handleRequest(req, res, body); return;
      }
      res.writeHead(404); res.end();
    } catch { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end(); }
  });
  const port = await new Promise<number>(resolve => http.listen(0, '127.0.0.1', () => resolve((http.address() as { port: number }).port)));
  const fixture = {
    url: `http://127.0.0.1:${port}/${kind === 'http' ? 'mcp' : 'sse'}`,
    requests, listings, calls, cancelled, closedRequests, initialized: () => initialized,
    ready: () => kind === 'sse' || getStreams > 0,
    setCatalog: (value: RemoteTool[]) => { catalog = value; },
    async changed() { await Promise.all([...servers].map(server => server.sendToolListChanged())); },
    async disconnect() { await Promise.all([...servers].map(server => server.close())); },
    async close() {
      if (stopped) return; stopped = true;
      await Promise.allSettled([...servers].map(server => server.close()));
      await Promise.allSettled([...transports.values()].map((transport: Transport) => transport.close()));
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
  fixtures.push(fixture); return fixture;
}

function managerFor(config: Settings['mcpServers']) {
  const manager = new McpManager(() => config); managers.push(manager); return manager;
}
async function connect(manager: McpManager, name = 'remote') {
  const before = manager.status().find(server => server.name === name)!;
  await manager.reconnect(name, before.revision, signal());
  expect(manager.status().find(server => server.name === name)?.status).toBe('connected');
  return manager.capture(signal());
}
function named(lease: ReturnType<McpManager['capture']>, remote: string) {
  const definition = lease.definitions.find(tool => tool.function.name.includes(`_${remote}_`));
  expect(definition, `Missing advertised ${remote} tool`).toBeDefined(); return definition!.function.name;
}

describe.each(['http', 'sse'] as const)('real SDK remote MCP over %s', kind => {
  it('connects only explicitly, advertises immutable tools, and calls exactly once', async () => {
    const fixture = await remoteFixture(kind), manager = managerFor({ remote: { url: fixture.url } });
    expect(manager.status()).toMatchObject([{ name: 'remote', status: 'disconnected', tools: [] }]);
    const cold = manager.capture(signal()); expect(cold.definitions).toEqual([]); cold.release();
    expect(fixture.requests).toEqual([]);
    const lease = await connect(manager), echo = named(lease, 'echo');
    expect(lease.definitions).toHaveLength(3); expect(Object.isFrozen(lease.definitions)).toBe(true);
    expect(Object.isFrozen(lease.definitions[0].function.parameters)).toBe(true);
    expect(lease.definitions.every(tool => tool.function.name.length <= 64)).toBe(true);
    expect(manager.status()[0].tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: echo, remoteName: 'echo' })]));
    const observed = fixture.requests.length;
    manager.status(); const passive = manager.capture(signal()); passive.release();
    expect(fixture.requests).toHaveLength(observed);
    expect(await lease.execute(echo, { text: 'hello' }, signal())).toBe('remote:hello');
    expect(fixture.calls).toEqual([{ name: 'echo', arguments: { text: 'hello' } }]);
    expect(fixture.listings).toEqual([undefined]); expect(fixture.initialized()).toBe(1);
    const fallback = fixture.requests.filter(request => request.path === '/sse' && request.method === 'POST');
    expect(fallback).toHaveLength(kind === 'sse' ? 1 : 0);
    lease.release();
  });

  it('collects bounded paginated discovery completely before publishing tools', async () => {
    const fixture = await remoteFixture(kind, { page: cursor => cursor === undefined ? { tools: [tool('first')], nextCursor: 'second-page' } : { tools: [tool('second')] } });
    const manager = managerFor({ remote: { url: fixture.url } }), lease = await connect(manager);
    expect(fixture.listings).toEqual([undefined, 'second-page']); expect(lease.definitions).toHaveLength(2);
    expect(await lease.execute(named(lease, 'second'), { text: 'page two' }, signal())).toBe('remote:page two');
    expect(fixture.calls).toHaveLength(1); lease.release();
  });

  it('cancels a pending tool without replay and leaves the accepted connection usable', async () => {
    const fixture = await remoteFixture(kind), manager = managerFor({ remote: { url: fixture.url } }), lease = await connect(manager);
    const controller = new AbortController();
    const pending = lease.execute(named(lease, 'slow'), {}, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await until(() => fixture.calls.length === 1); controller.abort(); await rejected;
    await until(() => fixture.cancelled.length === 1);
    expect(fixture.calls.map(call => call.name)).toEqual(['slow']);
    expect(await lease.execute(named(lease, 'echo'), { text: 'after cancel' }, signal())).toBe('remote:after cancel');
    expect(fixture.calls.map(call => call.name)).toEqual(['slow', 'echo']);
    expect(fixture.initialized()).toBe(1); lease.release();
  });

  it('invalidates advertised leases on tool-list change without silently rediscovering', async () => {
    const fixture = await remoteFixture(kind), manager = managerFor({ remote: { url: fixture.url } }), old = await connect(manager), echo = named(old, 'echo');
    const originalRevision = manager.status()[0].revision, originalScope = old.scope(echo);
    await until(fixture.ready);
    fixture.setCatalog([tool('echo'), tool('new-tool')]); await fixture.changed();
    await until(() => manager.status()[0].status === 'stale');
    expect(manager.status()[0].revision).not.toBe(originalRevision);
    expect(() => old.assertCurrent(echo)).toThrow();
    await expect(old.execute(echo, { text: 'must not dispatch' }, signal())).rejects.toThrow();
    const stale = manager.capture(signal()); expect(stale.definitions).toEqual([]); stale.release();
    expect(fixture.listings).toEqual([undefined]); expect(fixture.calls).toEqual([]);
    await manager.refresh('remote', manager.status()[0].revision, signal());
    const fresh = manager.capture(signal()), freshEcho = named(fresh, 'echo');
    expect(fresh.scope(freshEcho)).not.toEqual(originalScope);
    expect(fresh.definitions).toHaveLength(2);
    expect(await fresh.execute(freshEcho, { text: 'fresh catalog' }, signal())).toBe('remote:fresh catalog');
    expect(fixture.listings).toEqual([undefined, undefined]); expect(fixture.calls).toHaveLength(1);
    old.release(); fresh.release();
  });

  it('reconnects only on explicit action and never revives a released generation', async () => {
    const fixture = await remoteFixture(kind), manager = managerFor({ remote: { url: fixture.url } }), old = await connect(manager), echo = named(old, 'echo');
    const scope = old.scope(echo), revision = manager.status()[0].revision;
    await manager.reconnect('remote', revision, signal());
    expect(fixture.initialized()).toBe(2); expect(fixture.listings).toEqual([undefined, undefined]);
    expect(() => old.assertCurrent(echo)).toThrow();
    await expect(old.execute(echo, {}, signal())).rejects.toThrow(); expect(fixture.calls).toEqual([]);
    const current = manager.capture(signal()); expect(current.scope(named(current, 'echo'))).toEqual(scope);
    expect(await current.execute(named(current, 'echo'), { text: 'reconnected' }, signal())).toBe('remote:reconnected');
    current.release(); expect(() => current.assertCurrent(named(current, 'echo'))).toThrow(); old.release();
  });

  it('invalidates a closed remote connection and does not reconnect until requested', async () => {
    const fixture = await remoteFixture(kind), manager = managerFor({ remote: { url: fixture.url } }), old = await connect(manager), echo = named(old, 'echo');
    await until(() => kind === 'sse' || fixture.requests.some(request => request.method === 'GET' && request.path === '/mcp'));
    await fixture.disconnect();
    await until(() => manager.status()[0].status !== 'connected');
    expect(() => old.assertCurrent(echo)).toThrow(); await expect(old.execute(echo, {}, signal())).rejects.toThrow();
    const count = fixture.requests.length;
    const unavailable = manager.capture(signal()); expect(unavailable.definitions).toEqual([]); unavailable.release(); manager.status();
    expect(fixture.requests).toHaveLength(count); expect(fixture.initialized()).toBe(1); expect(fixture.calls).toEqual([]);
    const current = await connect(manager);
    expect(fixture.initialized()).toBe(2);
    expect(await current.execute(named(current, 'echo'), { text: 'explicit reconnect after close' }, signal())).toBe('remote:explicit reconnect after close');
    expect(fixture.calls).toHaveLength(1); old.release(); current.release();
  });

  it('disconnects on explicit disable and requires explicit reconnect after re-enabling', async () => {
    const fixture = await remoteFixture(kind), config = { remote: { url: fixture.url, enabled: true } };
    const manager = managerFor(config), old = await connect(manager), echo = named(old, 'echo');
    config.remote.enabled = false;
    expect(manager.status()[0]).toMatchObject({ status: 'disabled', tools: [] });
    expect(() => old.assertCurrent(echo)).toThrow(); await expect(old.execute(echo, {}, signal())).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
    config.remote.enabled = true;
    expect(manager.status()[0]).toMatchObject({ status: 'disconnected', tools: [] });
    const passive = manager.capture(signal()); expect(passive.definitions).toEqual([]); passive.release();
    expect(fixture.initialized()).toBe(1);
    const reconnected = await connect(manager);
    expect(fixture.initialized()).toBe(2);
    expect(await reconnected.execute(named(reconnected, 'echo'), { text: 'after explicit enable' }, signal())).toBe('remote:after explicit enable');
    expect(fixture.calls).toHaveLength(1); old.release(); reconnected.release();
  });

  it('never invokes a replacement endpoint through an old advertised tool', async () => {
    const first = await remoteFixture(kind), second = await remoteFixture(kind), config = { remote: { url: first.url } };
    const manager = managerFor(config), old = await connect(manager), echo = named(old, 'echo'), revision = manager.status()[0].revision;
    config.remote.url = second.url;
    expect(() => old.assertCurrent(echo)).toThrow();
    await expect(old.execute(echo, { text: 'wrong endpoint' }, signal())).rejects.toThrow();
    expect(manager.status()[0].status).toBe('disconnected');
    expect(second.requests).toEqual([]); expect(first.calls).toEqual([]);
    await expect(manager.reconnect('remote', revision, signal())).rejects.toThrow(); expect(second.requests).toEqual([]);
    const fresh = await connect(manager);
    expect(await fresh.execute(named(fresh, 'echo'), { text: 'new endpoint accepted' }, signal())).toBe('remote:new endpoint accepted');
    expect(first.calls).toEqual([]); expect(second.calls).toHaveLength(1);
    await expect(old.execute(echo, {}, signal())).rejects.toThrow(); expect(second.calls).toHaveLength(1);
    old.release(); fresh.release();
  });

  it.each(['initialize', 'call'] as const)('refuses307 endpoint redirects during %s without touching the target', async when => {
    const target = await remoteFixture(kind), source = await remoteFixture(kind, { redirect: { to: target.url, when } });
    const manager = managerFor({ remote: { url: source.url } });
    if (when === 'initialize') {
      await manager.reconnect('remote', manager.status()[0].revision, signal()).catch(() => {});
      expect(manager.status()[0].status).toBe('error');
    } else {
      const lease = await connect(manager);
      await expect(lease.execute(named(lease, 'echo'), { text: 'never forward this call' }, signal())).rejects.toThrow();
      lease.release();
      expect(source.requests.filter(request => request.rpc === 'tools/call')).toHaveLength(1);
    }
    expect(target.requests).toEqual([]); expect(source.calls).toEqual([]); expect(target.calls).toEqual([]);
  });

  it('redacts configured URL secrets and remote terminal controls in tool failures', async () => {
    const secret = 'SYNTHETIC_REMOTE_TOKEN', unsafe = `remote ${secret} ${String.fromCharCode(27)}[2J${String.fromCharCode(13)}spoof`;
    const fixture = await remoteFixture(kind, { failure: unsafe }), manager = managerFor({ remote: { url: `${fixture.url}?token=${secret}` } }), lease = await connect(manager);
    const failure = await lease.execute(named(lease, 'fail'), {}, signal()).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error); const message = (failure as Error).message;
    expect(message).not.toContain(secret); expect(message).not.toContain(String.fromCharCode(27)); expect(message).not.toContain(String.fromCharCode(13));
    expect(message.length).toBeLessThanOrEqual(1000); expect(fixture.calls).toHaveLength(1); lease.release();
  });
});

describe('remote MCP catalog refusal and discovery cancellation', () => {
  it.each(['http', 'sse'] as const)('bounds aggregate SSE event bytes across colon-only comments (%s)', async kind => {
    const fixture = await remoteFixture(kind, { oversizedCommentEvent: true }), manager = managerFor({ remote: { url: fixture.url } });
    let settled = false;
    const controller = new AbortController();
    const pending = manager.reconnect('remote', manager.status()[0].revision, controller.signal).catch(error => error).finally(() => { settled = true; });
    try {
      await until(() => settled);
      expect(await pending).toBeInstanceOf(Error);
      expect(manager.status()[0].tools).toEqual([]);
      const lease = manager.capture(signal()); expect(lease.definitions).toEqual([]); lease.release();
      expect(fixture.initialized()).toBe(1); expect(fixture.calls).toEqual([]);
    } finally { controller.abort(); await pending; }
  });

  it('accepts exactly 20 pages and 1000 tools when discovery ends at the configured bound', async () => {
    const fixture = await remoteFixture('http', { page: (_cursor, index) => ({
      tools: Array.from({ length: 50 }, (_, offset) => tool(`tool-${index * 50 + offset}`)),
      ...(index < 19 ? { nextCursor: `page-${index + 1}` } : {}),
    }) });
    const manager = managerFor({ remote: { url: fixture.url } }), lease = await connect(manager);
    expect(fixture.listings).toHaveLength(20); expect(lease.definitions).toHaveLength(1000);
    expect(await lease.execute(named(lease, 'tool-999'), { text: 'last bounded tool' }, signal())).toBe('remote:last bounded tool');
    expect(fixture.calls).toHaveLength(1); lease.release();
  });

  it.each([401, 403, 500])('does not fall back to SSE or replay a failed HTTP initialization (%s)', async status => {
    const secret = 'SYNTHETIC_INITIALIZATION_TOKEN';
    const fixture = await remoteFixture('http', { initializationStatus: status, failure: `Failure ${secret}${String.fromCharCode(27)}[2J` });
    const manager = managerFor({ remote: { url: `${fixture.url}?token=${secret}` } });
    await manager.reconnect('remote', manager.status()[0].revision, signal()).catch(() => {});
    expect(manager.status()[0]).toMatchObject({ status: 'error', tools: [] });
    const observation = manager.status()[0].error ?? '';
    expect(observation).not.toContain(secret); expect(observation).not.toContain(String.fromCharCode(27));
    expect(fixture.requests).toEqual([{ method: 'POST', path: '/mcp', rpc: 'initialize' }]);
    expect(fixture.calls).toEqual([]); expect(fixture.listings).toEqual([]);
    manager.status(); const lease = manager.capture(signal()); expect(lease.definitions).toEqual([]); lease.release();
    expect(fixture.requests).toHaveLength(1);
  });

  it.each([
    { name: 'duplicate tool names', page: (): Page => ({ tools: [tool('same'), tool('same')] }) },
    { name: 'repeated cursor', page: (_: string | undefined, index: number): Page => ({ tools: [tool(`page-${index}`)], nextCursor: 'repeated' }) },
    { name: 'more than 20 pages', page: (_: string | undefined, index: number): Page => ({ tools: [tool(`page-${index}`)], nextCursor: `page-${index + 1}` }) },
    { name: 'more than 1000 tools', page: (): Page => ({ tools: Array.from({ length: 1001 }, (_, index) => tool(`tool-${index}`)) }) },
    { name: 'oversized aggregate schema', page: (): Page => ({ tools: [{ ...tool('oversized'), inputSchema: { type: 'object', description: 'x'.repeat(1024 * 1024 + 1) } }] }) },
    { name: 'malformed input schema', page: (): Page => ({ tools: [{ ...tool('bad-schema'), inputSchema: { type: 'array' } as unknown as RemoteTool['inputSchema'] }] }) },
  ])('refuses $name atomically without exposing a partial tool list', async ({ page }) => {
    const fixture = await remoteFixture('http', { page }), manager = managerFor({ remote: { url: fixture.url } });
    await manager.reconnect('remote', manager.status()[0].revision, signal()).catch(() => {});
    const status = manager.status()[0]; expect(status.status).toBe('error'); expect(status.tools).toEqual([]);
    const lease = manager.capture(signal()); expect(lease.definitions).toEqual([]); lease.release();
    expect(fixture.listings.length).toBeLessThanOrEqual(20); expect(fixture.calls).toEqual([]);
    const count = fixture.requests.length; manager.status(); expect(fixture.requests).toHaveLength(count);
  });

  it('does not retain a previous catalog after an explicitly requested refresh fails validation', async () => {
    const fixture = await remoteFixture('http'), manager = managerFor({ remote: { url: fixture.url } }), old = await connect(manager), echo = named(old, 'echo');
    fixture.setCatalog([tool('duplicate'), tool('duplicate')]);
    await manager.refresh('remote', manager.status()[0].revision, signal()).catch(() => {});
    expect(manager.status()[0]).toMatchObject({ status: 'error', tools: [] });
    expect(() => old.assertCurrent(echo)).toThrow(); await expect(old.execute(echo, {}, signal())).rejects.toThrow();
    const rejected = manager.capture(signal()); expect(rejected.definitions).toEqual([]); rejected.release();
    expect(fixture.calls).toEqual([]); expect(fixture.listings).toHaveLength(2); old.release();
  });

  it('invalidates old leases at refresh start and publishes only the completed replacement catalog', async () => {
    let release: (() => void) | undefined;
    const fixture = await remoteFixture('http', { page: async (_cursor, index) => {
      if (index) await new Promise<void>(resolve => { release = resolve; });
      return { tools: [tool(index ? 'new-tool' : 'echo')] };
    } });
    const manager = managerFor({ remote: { url: fixture.url } }), old = await connect(manager), echo = named(old, 'echo');
    const refreshing = manager.refresh('remote', manager.status()[0].revision, signal());
    try {
      await until(() => Boolean(release));
      expect(manager.status()[0].status).toBe('refreshing');
      expect(() => old.assertCurrent(echo)).toThrow(); await expect(old.execute(echo, {}, signal())).rejects.toThrow();
      const during = manager.capture(signal()); expect(during.definitions).toEqual([]); during.release();
      expect(fixture.calls).toEqual([]);
    } finally { release?.(); await refreshing; }
    const fresh = manager.capture(signal()); expect(fresh.definitions).toHaveLength(1);
    expect(await fresh.execute(named(fresh, 'new-tool'), { text: 'finished refresh' }, signal())).toBe('remote:finished refresh');
    expect(fixture.calls).toHaveLength(1); old.release(); fresh.release();
  });

  it('cancels discovery without publishing partial tools or reconnecting automatically', async () => {
    let entered = false, aborted = false, release: (() => void) | undefined;
    const fixture = await remoteFixture('http', { page: async (_cursor, _index, signal) => {
      entered = true;
      await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
      return { tools: [tool('too-late')] };
    } });
    const manager = managerFor({ remote: { url: fixture.url } }), controller = new AbortController();
    const pending = manager.reconnect('remote', manager.status()[0].revision, controller.signal).catch(error => error);
    try {
      await until(() => entered); controller.abort(); expect(await pending).toBeInstanceOf(Error);
      // Closing discovery can overtake its best-effort cancellation notification.
      // Either SDK cancellation or a closed pending HTTP response proves teardown.
      await until(() => aborted || fixture.closedRequests.includes('tools/list'));
      expect(manager.status()[0].status).not.toBe('connected');
      const lease = manager.capture(signal()); expect(lease.definitions).toEqual([]); lease.release();
      expect(fixture.initialized()).toBe(1); expect(fixture.calls).toEqual([]);
    } finally { controller.abort(); release?.(); await pending; }
  });
});
