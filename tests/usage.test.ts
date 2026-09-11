import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const today = () => new Date().toISOString().slice(0, 10);

describe('usage ledger in the store', () => {
  let directory: string, store: Store;
  beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-usage-store-'))); store = new Store(join(directory, 'state')); });
  afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });

  it('groups by day+provider+model with sums and request counts, keeping cachedTokens honest', () => {
    store.logUsage({ sessionId: 's1', providerId: 'p', model: 'a', inputTokens: 100, outputTokens: 10 });
    store.logUsage({ sessionId: 's1', providerId: 'p', model: 'a', inputTokens: 200, outputTokens: 20, cachedTokens: 50 });
    store.logUsage({ sessionId: 's2', providerId: 'p', model: 'b', inputTokens: 5, outputTokens: 1 });
    const rows = store.usageSummary({ days: 7 });
    expect(rows).toEqual([
      // SUM over a mixed NULL/value group reports the reported portion — never a fabricated 0 for the missing request.
      { day: today(), providerId: 'p', model: 'a', inputTokens: 300, outputTokens: 30, cachedTokens: 50, requests: 2 },
      { day: today(), providerId: 'p', model: 'b', inputTokens: 5, outputTokens: 1, requests: 1 },
    ]);
    expect(rows[1].cachedTokens).toBeUndefined(); // No request in this group reported one.
  });
  it('clamps the summary window to 1..90 and defaults to 30', () => {
    store.logUsage({ sessionId: 's', providerId: 'p', model: 'm', inputTokens: 1, outputTokens: 1 });
    for (const days of [0, -5, 10_000, Number.NaN]) expect(() => store.usageSummary({ days })).not.toThrow();
    expect(store.usageSummary({ days: 10_000 })).toHaveLength(1);
    expect(store.usageSummary()).toHaveLength(1);
  });
  it('rejects malformed token counts so a bad provider chunk cannot corrupt sums', () => {
    for (const inputTokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.logUsage({ sessionId: 's', providerId: 'p', model: 'm', inputTokens, outputTokens: 0 })).toThrow(/non-negative integers/);
    }
    expect(store.usageSummary({ days: 1 })).toEqual([]);
  });
  it('usage survives session deletion (no FK: the spend happened)', () => {
    const session = store.createSession();
    store.logUsage({ sessionId: session.id, providerId: 'p', model: 'm', inputTokens: 7, outputTokens: 3 });
    store.deleteSession(session.id);
    expect(store.usageSummary({ days: 1 })).toEqual([{ day: today(), providerId: 'p', model: 'm', inputTokens: 7, outputTokens: 3, requests: 1 }]);
  });
});

describe('usage recording in the runner and the API report', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let cachedTokens: number | undefined;
  let respond: ((body: any, res: ServerResponse) => void) | undefined;
  const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  const usageText = (res: ServerResponse, cached?: number) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 5, ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}) } })}\n\ndata: [DONE]\n\n`);
  };
  const api = async (path: string, data?: unknown) => { const response = await fetch(url + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-usage-runner-'))); store = new Store(join(directory, 'state')); cachedTokens = undefined; respond = undefined;
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); (respond ?? ((_b: any, r: ServerResponse) => usageText(r, cachedTokens)))(body, res); });
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: await listen(provider), apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('logs one row per turn with provider/model attribution, omitting unreported cachedTokens', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    runner.start(session.id, 'First turn'); await runner.whenIdle();
    expect(store.usageSummary({ days: 1 })).toEqual([{ day: today(), providerId: 'test', model: 'model', inputTokens: 120, outputTokens: 5, requests: 1 }]);
  });
  it('passes provider-reported cachedTokens through to the ledger', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    cachedTokens = 96;
    runner.start(session.id, 'Cached turn'); await runner.whenIdle();
    expect(store.usageSummary({ days: 1 })).toEqual([{ day: today(), providerId: 'test', model: 'model', inputTokens: 120, outputTokens: 5, cachedTokens: 96, requests: 1 }]);
  });
  it('records researcher child usage under the CHILD session id (their spend is real)', async () => {
    const child = (body: any) => body.messages.find((m: any) => m.role === 'user')?.content?.startsWith('CHILD');
    respond = (body, res) => {
      if (child(body)) usageText(res);
      else if (body.messages.at(-1)?.role === 'tool') usageText(res);
      else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'Inspect', prompt: 'CHILD inspect' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`); }
    };
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    runner.start(session.id, 'ROOT with child'); await runner.whenIdle();
    const childId = runner.delegations.list(session.id)[0].childSessionId;
    const rows = store.db.prepare('SELECT session_id FROM usage_log ORDER BY id').all() as { session_id: string }[];
    expect(rows.map(row => row.session_id)).toEqual([session.id, childId, session.id]);
    // Aggregation folds them together (40+120+120 in, 2+5+5 out): the day
    // total includes child spend alongside both parent steps.
    expect(store.usageSummary({ days: 1 })).toEqual([{ day: today(), providerId: 'test', model: 'model', inputTokens: 280, outputTokens: 12, requests: 3 }]);
  });
  it('GET /api/usage returns days with entries and totals, and clamps the days parameter', async () => {
    const { body: session } = await api('/sessions', { permissionMode: 'auto' });
    cachedTokens = 10;
    runner.start(session.id, 'API shape turn'); await runner.whenIdle();
    const { status, body } = await api('/usage?days=7');
    expect(status).toBe(200);
    expect(body).toEqual({
      days: [{ day: today(), entries: [{ providerId: 'test', model: 'model', inputTokens: 120, outputTokens: 5, cachedTokens: 10, requests: 1 }], totals: { inputTokens: 120, outputTokens: 5, cachedTokens: 10, requests: 1 } }],
      totals: { inputTokens: 120, outputTokens: 5, cachedTokens: 10, requests: 1 },
    });
    // Out-of-range and garbage days clamp instead of erroring.
    for (const value of ['0', '99999', '-3', 'abc']) expect((await api(`/usage?days=${value}`)).status).toBe(200);
    expect((await api('/usage?days=99999')).body.totals.requests).toBe(1);
  });
  it('an empty ledger reports honest empties', async () => {
    const { status, body } = await api('/usage');
    expect(status).toBe(200);
    expect(body).toEqual({ days: [], totals: { inputTokens: 0, outputTokens: 0, requests: 0 } });
    expect(body.totals.cachedTokens).toBeUndefined();
  });
});
