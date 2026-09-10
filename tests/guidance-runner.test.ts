import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');

describe('storm breaker, no-progress guidance and mid-turn steering', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-guidance-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model', maxSteps: 12 });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('answers the 4th identical failing call without executing it and resets on a different success', async () => {
    const session = await create();
    respond = (body, res) => {
      const results = body.messages.filter((m: any) => m.role === 'tool').length;
      // Batches DIFFER each round (second read has a unique path) while one
      // failing read repeats and nothing succeeds: the per-call storm breaker
      // must fire where the identical-batch guard cannot. Then a glob success
      // clears every streak, so the once-broken call executes again.
      if (results < 6) return tools(res, [{ name: 'read_file', args: { path: 'missing-file.txt' } }, { name: 'read_file', args: { path: `unique-${results}.txt` } }]);
      // Round 4 pairs the (now broken) call with a success: the breaker answers
      // the repeat without executing, the success clears streaks AND keeps the
      // round evidence-bearing so the no-progress hard stop stays out of the way.
      if (results === 6) return tools(res, [{ name: 'read_file', args: { path: 'missing-file.txt' } }, { name: 'glob', args: { pattern: '*.md' } }]);
      if (results === 8) return tools(res, [{ name: 'read_file', args: { path: 'missing-file.txt' } }]);
      return text(res, 'Recovered.');
    };
    await run(session.id, 'Storm test');
    const toolMessages = store.messages(session.id).filter(m => m.role === 'tool').map(m => m.content);
    expect(toolMessages.filter(content => content.includes('failed 3 times in a row'))).toHaveLength(1);
    const callRecords = store.messages(session.id).flatMap(m => m.toolCalls ?? []);
    const constant = callRecords.filter(call => call.name === 'read_file' && (call.args as { path?: string }).path === 'missing-file.txt');
    // 3 real failures, the 4th answered without executing, and after the glob
    // success cleared streaks the same call executed (and failed) again.
    expect(constant.filter(call => call.status === 'denied')).toHaveLength(1);
    expect(constant.filter(call => call.status === 'error')).toHaveLength(4);
    expect(callRecords.filter(call => call.name === 'glob' && call.status === 'completed')).toHaveLength(1);
  });

  it('nudges after 2 evidence-free rounds and hard-stops honestly after 4', async () => {
    const session = await create();
    respond = (body, res) => {
      const rounds = body.messages.filter((m: any) => m.role === 'tool').length;
      // Same failing signature forever: every round is evidence-free.
      if (rounds < 8) return tools(res, [{ name: 'read_file', args: { path: `nope-${rounds % 2}.txt` } }]);
      return text(res);
    };
    await run(session.id, 'Dead rounds test');
    const nudged = calls.some(body => JSON.stringify(body.messages).includes('produced no new information'));
    expect(nudged).toBe(true);
    const finalAssistant = store.messages(session.id).filter(m => m.role === 'assistant').at(-1)!;
    expect(finalAssistant.content).toContain('[Stopped: several rounds produced no new information.');
    expect(store.session(session.id).status).toBe('idle');
  });

  it('rejects steering while idle and accepts it during a run, delivering exactly once', async () => {
    const session = await create();
    expect((await api(`/sessions/${session.id}/steer`, { content: 'Focus on the README.' })).status).toBe(409);
    let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
    let steered = false;
    respond = (body, res) => {
      const rounds = body.messages.filter((m: any) => m.role === 'tool').length;
      if (rounds === 0 && !steered) { steered = true; void gate.then(() => tools(res, [{ name: 'glob', args: { pattern: '*.txt' } }])); return; }
      if (rounds <= 1) return tools(res, [{ name: 'glob', args: { pattern: `x-${rounds}.md` } }]);
      return text(res);
    };
    const running = (async () => { runner.start(session.id, 'Steer test'); await runner.whenIdle(); })();
    // Wait until the run is active, steer, then release the held provider response.
    while ((await api(`/sessions/${session.id}`)).body.session.status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    expect((await api(`/sessions/${session.id}/steer`, { content: 'Focus on the README.' })).status).toBe(202);
    released!();
    await running;
    // Delivery is the persisted, host-attributed [Steering] message: it reaches
    // the provider as ordinary history, placed after the work already done.
    const markers = store.messages(session.id).filter(m => m.role === 'system' && m.content.includes('[Steering]'));
    expect(markers).toHaveLength(1);
    expect(markers[0].content).toContain('The user sent this note to the running response.');
    expect(markers[0].content).toContain('Focus on the README.');
    const carrying = calls.map(body => JSON.stringify(body.messages)).filter(m => m.includes('Focus on the README.'));
    expect(carrying.length).toBeGreaterThanOrEqual(1);
  });

  it('seals history and releases the turn even if usage persistence fails during completion', async () => {
    const session = await create();
    const usage = vi.spyOn(runner.usage, 'turn').mockImplementationOnce(() => { throw new Error('Simulated usage storage failure'); });
    await run(session.id);
    usage.mockRestore();
    expect(runner.active(session.id)).toBe(false);
    expect(runner.history.state(session.id)).toMatchObject({ canUndo: true });
    expect(runner.history.state(session.id).pendingRecovery).toBeUndefined();
    await run(session.id, 'Continue after storage recovered');
    expect(store.session(session.id).status).toBe('idle');
  });

  it('caps steering notes per response and preserves accepted notes on cancel', async () => {
    const session = await create();
    let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
    respond = (_body, res) => { void gate.then(() => text(res)); };
    const running = (async () => { runner.start(session.id, 'Cap test'); await runner.whenIdle(); })();
    while ((await api(`/sessions/${session.id}`)).body.session.status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    for (let index = 0; index < 5; index++) expect((await api(`/sessions/${session.id}/steer`, { content: `Note ${index}` })).status).toBe(202);
    expect((await api(`/sessions/${session.id}/steer`, { content: 'One too many' })).status).toBe(409);
    await runner.cancel(session.id); released!(); await running;
    // Accepted notes survive cancellation as pending continuation context, rather than being lost.
    expect(store.messages(session.id).filter(m => m.role === 'system' && m.content.includes('[Steering]'))).toHaveLength(5);
    // A later explicit user turn sees the accepted notes in saved context.
    respond = (_body, res) => text(res);
    await run(session.id, 'After cancel');
    expect(calls.map(body => JSON.stringify(body.messages)).filter(m => m.includes('Note 0')).length).toBeGreaterThan(0);
  });
});
