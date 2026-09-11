import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const text = (res: ServerResponse, cached?: number) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 5, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) } })}\n\ndata: [DONE]\n\n`);
};

describe('cache diagnostics in the request path', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let cachedTokens: number | undefined;
  let requests: any[], readNext: boolean;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const run = async (id: string, content: string) => { runner.start(id, content); await runner.whenIdle(); };
  const lastCache = (id: string) => store.messages(id).filter(m => m.role === 'assistant').at(-1)?.context?.cache;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-cache-diag-'))); store = new Store(join(directory, 'state')); cachedTokens = undefined; requests = []; readNext = false;
    provider = createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part; requests.push(JSON.parse(raw));
      if (readNext) {
        readNext = false; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      } else text(res, cachedTokens);
    });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('caches actual runner file results for a gateway alias and persists only clean history', async () => {
    const original = store.settings().providers[0];
    store.saveSettings({ providers: [{ ...original, anthropicCacheModels: ['model'] }] });
    await writeFile(join(directory, 'README.md'), 'Synthetic project content for cache verification.');
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    readNext = true;
    await run(session.id, 'Read README.md and report its content.');
    const continuation = requests.find(body => body.messages.at(-1)?.role === 'tool');
    expect(continuation).toBeDefined();
    expect(continuation.messages.at(-1)).toMatchObject({ tool_call_id: 'fixture-read', cache_control: { type: 'ephemeral' } });
    expect(continuation.messages.at(-1).content).toContain('Synthetic project content');
    expect(continuation.messages.filter((message: any) => message.role === 'user').every((message: any) => !JSON.stringify(message).includes('cache_control'))).toBe(true);
    expect(JSON.stringify(store.messages(session.id))).not.toContain('cache_control');
    expect(store.session(session.id)?.status).toBe('idle');
    await run(session.id, 'Continue from that file.');
    expect(requests.at(-1).messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(store.messages(session.id))).not.toContain('cache_control');
  });

  it('reports first_turn once, then a byte-stable prefix on later turns of the same session', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    await run(session.id, 'First turn');
    const first = lastCache(session.id);
    expect(first).toMatchObject({ prefixChanged: true, reasons: ['first_turn'] });
    await run(session.id, 'Second turn');
    const second = lastCache(session.id);
    expect(second).toMatchObject({ prefixChanged: false, reasons: [] });
    expect(second!.shape).toEqual(first!.shape);
  });
  it('carries provider-reported cached tokens into the snapshot', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    cachedTokens = 96;
    await run(session.id, 'Turn with cache usage');
    expect(lastCache(session.id)).toMatchObject({ cachedTokens: 96, inputTokens: 120 });
  });
  it('omits cachedTokens honestly when the provider does not report it', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    await run(session.id, 'No cache reporting');
    const cache = lastCache(session.id)!;
    expect(cache.cachedTokens).toBeUndefined();
    expect(cache.inputTokens).toBe(120);
  });
  it('attributes the miss to undo/redo history edits without claiming the prefix changed', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    await run(session.id, 'Establish history');
    const detail = await api(`/sessions/${session.id}`);
    const undoId = detail.body.history.undoId;
    expect((await api(`/sessions/${session.id}/history/undo`, { checkpointId: undoId })).status).toBe(200);
    expect((await api(`/sessions/${session.id}/history/redo`, { checkpointId: undoId })).status).toBe(200);
    await run(session.id, 'After history edits');
    const cache = lastCache(session.id)!;
    expect(cache.prefixChanged).toBe(true);
    expect(cache.reasons).toEqual(['history_edited']);
    expect(cache.reasons).not.toContain('system');
  });
  it('keeps parent and researcher prefix tracking separate', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'ask' });
    await run(session.id, 'Parent only turn');
    await run(session.id, 'Parent second turn');
    expect(lastCache(session.id)).toMatchObject({ prefixChanged: false });
  });
});
