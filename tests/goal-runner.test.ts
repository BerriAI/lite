import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
// The no-report evaluator carries this fixed system text and nothing else.
const isEvaluator = (body: any) => JSON.stringify(body).includes('You review whether a coding-session goal is met');
const users = (body: any) => body.messages.filter((m: any) => m.role === 'user').length;
const toolResults = (body: any) => body.messages.filter((m: any) => m.role === 'tool').length;

describe('goal mode: envelope, update_goal, host continuation and API', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Work the goal') => { runner.start(id, content); await runner.whenIdle(); };
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-goal-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model', maxSteps: 12 });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('appends a goal envelope block with the turn counter and advertises update_goal', async () => {
    const session = await create();
    expect((await api(`/sessions/${session.id}/goal`, { text: 'Ship the widget' })).status).toBe(200);
    respond = (body, res) => body.messages.some((m: any) => m.role === 'tool') ? text(res) : tools(res, [{ name: 'update_goal', args: { status: 'complete', note: 'Shipped.' } }]);
    await run(session.id);
    const first = calls[0];
    const serialized = JSON.stringify(first.messages);
    expect(serialized).toContain('## Session goal');
    expect(serialized).toContain('Ship the widget');
    expect(serialized).toContain('Turn 1 of 10. Report progress with update_goal before finishing.');
    expect(first.tools.some((t: any) => t.function.name === 'update_goal')).toBe(true);
  });

  it('continues to the next turn on update_goal continue and stops on complete', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Finish the migration' });
    respond = (body, res) => {
      expect(isEvaluator(body)).toBe(false); // Every turn reports; the evaluator must never fire.
      if (users(body) === 1) return toolResults(body) === 0 ? tools(res, [{ name: 'update_goal', args: { status: 'continue', note: 'Halfway.' } }]) : text(res, 'Turn one summary');
      return toolResults(body) === 1 ? tools(res, [{ name: 'update_goal', args: { status: 'complete', note: 'Migration done.' } }]) : text(res, 'Goal achieved');
    };
    await run(session.id);
    expect(calls).toHaveLength(4);
    // The continuation turn is host-authored through the normal acceptance path.
    const turnTwo = JSON.stringify(calls[2].messages);
    expect(turnTwo).toContain('Continue working toward the session goal. Turn 2 of 10.');
    expect(turnTwo).toContain('Turn 2 of 10. Report progress with update_goal before finishing.');
    const goal = store.session(session.id).goal!;
    expect(goal.status).toBe('completed');
    expect(goal.turns).toBe(2);
    expect(goal.lastReport).toEqual({ status: 'complete', note: 'Migration done.' });
    // The host-continued user message is persisted like any accepted turn.
    expect(store.messages(session.id).filter(m => m.role === 'user').map(m => m.content).at(-1)).toContain('Continue working toward the session goal. Turn 2 of 10.');
  });

  it('stops without continuation when the first report is complete or blocked', async () => {
    for (const settled of ['complete', 'blocked'] as const) {
      calls = [];
      const session = await create();
      await api(`/sessions/${session.id}/goal`, { text: `Settle as ${settled}` });
      respond = (body, res) => toolResults(body) === 0 ? tools(res, [{ name: 'update_goal', args: { status: settled, note: settled === 'complete' ? 'Genuinely met.' : 'Missing credentials.' } }]) : text(res);
      await run(session.id);
      expect(calls).toHaveLength(2); // One turn: the report plus its final text; no third request.
      const goal = store.session(session.id).goal!;
      expect(goal.status).toBe(settled === 'complete' ? 'completed' : 'blocked');
      expect(goal.turns).toBe(1);
    }
  });

  it('blocks the goal with a limit note at maxTurns and starts no further turn', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Endless polishing', maxTurns: 2 });
    // The model always says continue: only the host turn ceiling can stop it.
    // Each turn is (update_goal continue, then text): the Nth turn's report is
    // its Nth tool result, so report while results lag the user turn count.
    respond = (body, res) => toolResults(body) < users(body) ? tools(res, [{ name: 'update_goal', args: { status: 'continue', note: 'More polish.' } }]) : text(res, `Turn ${users(body)} done`);
    await run(session.id);
    expect(calls).toHaveLength(4); // Two turns of (report, text); no fifth request.
    const goal = store.session(session.id).goal!;
    expect(goal.status).toBe('blocked');
    expect(goal.turns).toBe(2);
    expect(goal.lastReport?.note).toContain('[Goal paused: reached the 2-turn limit.');
    expect(store.messages(session.id).filter(m => m.role === 'user')).toHaveLength(2);
  });

  it('runs the bounded evaluator on a report-less turn and continues on its verdict', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Investigate the flake' });
    respond = (body, res) => {
      if (isEvaluator(body)) return text(res, 'continue');
      if (users(body) === 1) return text(res, 'Looked around, forgot to report.');
      return toolResults(body) === 0 ? tools(res, [{ name: 'update_goal', args: { status: 'complete', note: 'Found it.' } }]) : text(res, 'Flake fixed');
    };
    await run(session.id);
    const evaluator = calls.filter(isEvaluator);
    expect(evaluator).toHaveLength(1);
    // Tool-less, history-less: exactly the review system text plus one user message.
    expect(evaluator[0].tools).toBeUndefined();
    expect(evaluator[0].messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(evaluator[0].messages)).toContain('Investigate the flake');
    const turnTwo = calls.filter(body => !isEvaluator(body) && JSON.stringify(body.messages).includes('Continue working toward the session goal. Turn 2 of 10.'));
    expect(turnTwo.length).toBeGreaterThan(0);
    const goal = store.session(session.id).goal!;
    expect(goal.status).toBe('completed');
    expect(goal.turns).toBe(2);
  });

  it('treats an evaluator failure as continue and never crashes the sealed turn', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Resilient goal' });
    respond = (body, res) => {
      // Non-SSE response makes streamCompletion throw without a slow retry loop.
      if (isEvaluator(body)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return void res.end('{}'); }
      if (users(body) === 1) return text(res, 'No report, and the evaluator will fail.');
      return toolResults(body) === 0 ? tools(res, [{ name: 'update_goal', args: { status: 'blocked', note: 'Stopping here.' } }]) : text(res);
    };
    await run(session.id);
    expect(calls.filter(isEvaluator)).toHaveLength(1);
    const goal = store.session(session.id).goal!;
    expect(goal.turns).toBe(2); // The failed evaluator counted as continue and turn 2 ran.
    expect(goal.status).toBe('blocked');
    expect(goal.lastReport).toEqual({ status: 'blocked', note: 'Stopping here.' });
    expect(store.session(session.id).status).toBe('idle');
  });

  it('applies the evaluator verdict with a host note when it settles the goal', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Judge me done' });
    respond = (body, res) => isEvaluator(body) ? text(res, 'complete') : text(res, 'All finished, no report.');
    await run(session.id);
    const goal = store.session(session.id).goal!;
    expect(goal.status).toBe('completed');
    expect(goal.turns).toBe(1);
    expect(goal.lastReport?.status).toBe('complete');
    expect(goal.lastReport?.note).toContain('host evaluator judged the goal met');
  });

  it('pauses continuation when the user cancels a goal turn; the goal stays active', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Interruptible work' });
    let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
    respond = (_body, res) => { void gate.then(() => text(res)); };
    const running = (async () => { runner.start(session.id, 'Start the goal'); await runner.whenIdle(); })();
    // Wait for the request to REACH the provider, not merely for status
    // 'running' (set before dispatch): cancelling in that gap aborts the fetch
    // and the mock never records a call, flaking the assertion below.
    while (calls.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    runner.cancel(session.id); released!(); await running;
    expect(calls).toHaveLength(1); // No evaluator, no continuation after a cancel.
    const goal = store.session(session.id).goal!;
    expect(goal.status).toBe('active');
    expect(goal.turns).toBe(1); // The cancelled turn was spent.
    expect(store.messages(session.id).filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('enforces the goal API contract: 409 on active run or active goal, DELETE clears, replace allowed', async () => {
    const session = await create();
    expect((await api(`/sessions/${session.id}/goal`, { text: 'First goal' })).status).toBe(200);
    expect((await api(`/sessions/${session.id}/goal`, { text: 'Second goal' })).status).toBe(409);
    const cleared = await api(`/sessions/${session.id}/goal`, undefined, 'DELETE');
    expect(cleared.status).toBe(200);
    expect(cleared.body.goal.status).toBe('cleared');
    expect((await api(`/sessions/${session.id}/goal`, { text: 'Replacement goal', maxTurns: 5 })).status).toBe(200);
    expect(store.session(session.id).goal).toMatchObject({ text: 'Replacement goal', status: 'active', turns: 0, maxTurns: 5 });
    // Idle-only: a running response rejects goal changes.
    let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
    respond = (_body, res) => { void gate.then(() => text(res)); };
    const running = (async () => { runner.start(session.id, 'Busy'); await runner.whenIdle(); })();
    while ((await api(`/sessions/${session.id}`)).body.session.status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    expect((await api(`/sessions/${session.id}/goal`, undefined, 'DELETE')).status).toBe(409);
    runner.cancel(session.id); released!(); await running;
    expect((await api(`/sessions/${session.id}/goal`, { text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await api(`/sessions/${session.id}/goal`, { text: 'ok', maxTurns: 26 })).status).toBe(400);
    expect((await api(`/sessions/${session.id.replace(/./g, '0')}/goal`, undefined, 'DELETE')).status).toBe(404);
  });

  it('persists the goal across a store reopen; continuation does not auto-resume', async () => {
    const session = await create();
    await api(`/sessions/${session.id}/goal`, { text: 'Durable goal', maxTurns: 7 });
    const reopened = new Store(join(directory, 'state'));
    try {
      expect(reopened.session(session.id).goal).toMatchObject({ text: 'Durable goal', status: 'active', turns: 0, maxTurns: 7 });
    } finally { reopened.close(); }
  });
});
