import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { boundedReview } from '../server/providers.js';
import type { Provider } from '../shared/types.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const isEvaluator = (body: any) => JSON.stringify(body).includes('You review whether a coding-session goal is met');
const isChild = (body: any) => body.messages.find((m: any) => m.role === 'user')?.content?.startsWith('CHILD');

// One mock provider serves BOTH models: the executor pair is the session's
// providerId/model ('exec-model'); the planner pair names 'plan-model'. Every
// assertion reads the request body's `model` — the honest record of which
// brain ran the turn.
describe('planner + executor dual-model routing', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const setPlanner = async (id: string) => expect((await api(`/sessions/${id}`, { planner: { providerId: 'test', model: 'plan-model' } }, 'PATCH')).status).toBe(200);
  const run = async (id: string, content = 'Do the work') => { runner.start(id, content); await runner.whenIdle(); };
  const lastContext = (id: string) => store.messages(id).filter(m => m.role === 'assistant').at(-1)?.context;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-planner-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'exec-model', maxSteps: 12 });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('routes Plan-mode turns to the planner and Build turns to the executor, attributing context honestly', async () => {
    const session = await create({ mode: 'plan' });
    await setPlanner(session.id);
    await run(session.id, 'Plan the feature');
    expect(calls.at(-1).model).toBe('plan-model');
    // The context snapshot (usage attribution, budget) records the RESOLVED turn model.
    expect(lastContext(session.id)).toMatchObject({ model: 'plan-model', providerId: 'test' });
    expect((await api(`/sessions/${session.id}`, { mode: 'build' }, 'PATCH')).status).toBe(200);
    await run(session.id, 'Build the feature');
    expect(calls.at(-1).model).toBe('exec-model');
    expect(lastContext(session.id)).toMatchObject({ model: 'exec-model' });
  });

  it('runs Plan-mode turns on the executor when no planner is set', async () => {
    const session = await create({ mode: 'plan' });
    await run(session.id, 'Plan without a planner');
    expect(calls.at(-1).model).toBe('exec-model');
    expect(lastContext(session.id)).toMatchObject({ model: 'exec-model' });
  });

  it('validates the planner PATCH: unknown provider 400, empty fields 400, null clears, idle-only', async () => {
    const session = await create();
    expect((await api(`/sessions/${session.id}`, { planner: { providerId: 'missing', model: 'plan-model' } }, 'PATCH')).status).toBe(400);
    expect((await api(`/sessions/${session.id}`, { planner: { providerId: 'test', model: '' } }, 'PATCH')).status).toBe(400);
    expect((await api(`/sessions/${session.id}`, { planner: { providerId: '', model: 'plan-model' } }, 'PATCH')).status).toBe(400);
    await setPlanner(session.id);
    expect(store.session(session.id).planner).toEqual({ providerId: 'test', model: 'plan-model' });
    const cleared = await api(`/sessions/${session.id}`, { planner: null }, 'PATCH');
    expect(cleared.status).toBe(200);
    expect(cleared.body.planner).toBeUndefined();
    expect(store.session(session.id).planner).toBeUndefined();
    // Idle-only: the planner is a model configuration change, so a running
    // response rejects it exactly like a model change would.
    let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
    respond = (_body, res) => { void gate.then(() => text(res)); };
    const running = (async () => { runner.start(session.id, 'Busy'); await runner.whenIdle(); })();
    while ((await api(`/sessions/${session.id}`)).body.session.status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    expect((await api(`/sessions/${session.id}`, { planner: { providerId: 'test', model: 'plan-model' } }, 'PATCH')).status).toBe(409);
    runner.cancel(session.id); released!(); await running;
  });

  it('bumps the config revision and holds the queue when the planner changes', async () => {
    const session = await create();
    await run(session.id, 'Establish a turn');
    runner.enqueue(session.id, 'Queued for later');
    const before = store.session(session.id).configRevision ?? 0;
    await setPlanner(session.id);
    expect(store.session(session.id).configRevision).toBe(before + 1);
    expect(store.queue(session.id).paused).toBe(true);
    // Re-sending the identical planner is not a change.
    await setPlanner(session.id);
    expect(store.session(session.id).configRevision).toBe(before + 1);
  });

  it('a researcher launched from a planner-routed Plan turn inherits the planner (one captured pair per turn)', async () => {
    await writeFile(join(directory, 'evidence.txt'), 'workspace evidence');
    const session = await create({ mode: 'plan' });
    await setPlanner(session.id);
    respond = (body, res) => {
      if (isChild(body)) return body.messages.at(-1)?.role === 'tool' ? text(res, 'Child report') : tools(res, [{ name: 'read_file', args: { path: 'evidence.txt' } }]);
      return body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect' } }]);
    };
    await run(session.id, 'Research then plan');
    const childCalls = calls.filter(isChild);
    expect(childCalls.length).toBeGreaterThan(0);
    // Children inherit the captured turn policy verbatim: the planner pair.
    for (const call of childCalls) expect(call.model).toBe('plan-model');
    expect(runner.delegations.list(session.id)[0].status).toBe('completed');
  });

  it('the goal evaluator reviews on the planner when one is set (a reviewer is a planning-shaped task)', async () => {
    const session = await create();
    await setPlanner(session.id);
    await api(`/sessions/${session.id}/goal`, { text: 'Judge me done' });
    respond = (body, res) => isEvaluator(body) ? text(res, 'complete') : text(res, 'All finished, no report.');
    await run(session.id, 'Work the goal');
    const evaluator = calls.filter(isEvaluator);
    expect(evaluator).toHaveLength(1);
    expect(evaluator[0].model).toBe('plan-model');
    expect(evaluator[0].tools).toBeUndefined();
    // The Build turn itself still ran on the executor.
    expect(calls.find(body => !isEvaluator(body))!.model).toBe('exec-model');
    expect(store.session(session.id).goal!.status).toBe('completed');
  });

  it('the goal evaluator falls back to the session model without a planner', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'No planner here' });
    respond = (body, res) => isEvaluator(body) ? text(res, 'complete') : text(res, 'Finished, no report.');
    await run(session.id, 'Work the goal');
    expect(calls.filter(isEvaluator)[0].model).toBe('exec-model');
  });
});

describe('boundedReview', () => {
  let server: Server, url: string, bodies: any[], respond: (res: ServerResponse) => void;
  const provider = (): Provider => ({ id: 'p', name: 'P', kind: 'openai', baseUrl: url, apiKey: 'k' });
  beforeEach(async () => {
    bodies = [];
    respond = res => stream(res, { content: '  a considered verdict \n' });
    server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); bodies.push(JSON.parse(Buffer.concat(chunks).toString())); respond(res); });
    url = await listen(server);
  });
  afterEach(async () => { await close(server); });

  it('sends one tool-less user message and returns the trimmed text', async () => {
    const result = await boundedReview({ provider: provider(), model: 'review-model', system: 'Review it.', prompt: 'The material.' });
    expect(result).toBe('a considered verdict');
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.model).toBe('review-model');
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.messages.filter((m: any) => m.role === 'user')).toEqual([{ role: 'user', content: 'The material.' }]);
    expect(JSON.stringify(body)).toContain('Review it.');
  });

  it('times out honestly: a silent provider makes it throw, never hang or fabricate', async () => {
    respond = res => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\n\n'); /* never completes */ };
    await expect(boundedReview({ provider: provider(), model: 'review-model', system: 's', prompt: 'p', timeoutMs: 100 })).rejects.toThrow();
  });

  it('propagates provider errors to the caller (the caller owns the fallback)', async () => {
    respond = res => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"invalid api key"}}'); };
    await expect(boundedReview({ provider: provider(), model: 'review-model', system: 's', prompt: 'p', timeoutMs: 3000 })).rejects.toThrow(/Provider/);
  });
});
