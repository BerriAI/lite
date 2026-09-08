import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { Runner } from '../server/runner.js';
import { compactionLimits, estimateRequest, modelCatalog, resolveContextBudget } from '../server/budget.js';
import * as providers from '../server/providers.js';
import type { Message, Provider, ToolDefinition } from '../shared/types.js';

const until = async (check: () => boolean) => { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for context test'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const delta = (res: ServerResponse, value: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value }] })}\n\n`);
const text = (res: ServerResponse, content: string, done = true) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { content }); if (done) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n'); } };
const tool = (res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'todo_read', arguments: '{}' } }] }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`); res.end('data: [DONE]\n\n'); };
const overflow = (res: ServerResponse) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"context_length_exceeded"}}'); };
const summaryRequest = (body: any) => body.messages?.[0]?.content?.startsWith('Summarize the supplied conversation');

describe('context budget Runner and API integration', () => {
  let directory: string, store: Store, runner: Runner, server: Server, providerServer: Server, url: string, provider: Provider;
  let calls: any[], catalogs: number, respond: (body: any, res: ServerResponse) => void;
  const extraTools: ToolDefinition[] = [];
  beforeEach(async () => {
    modelCatalog.clear(); directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-context-runner-'))); store = new Store(join(directory, 'state')); calls = []; catalogs = 0; extraTools.length = 0;
    respond = (body, res) => text(res, summaryRequest(body) ? 'Earlier work summarized faithfully.' : 'Finished');
    providerServer = createServer(async (req, res) => {
      if (req.method === 'GET') { catalogs++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'budget-model', context_window: 16384 }, { id: 'invalid-model', context_window: -1 }] })); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res);
    });
    provider = { id: 'budget', name: 'Budget', kind: 'openai', baseUrl: await listen(providerServer), contextWindows: { 'budget-model': 16384 } };
    store.saveSettings({ workspace: directory, providers: [provider], defaultProvider: provider.id, defaultModel: 'budget-model' });
    const app = createApp({ store, external: { definitions: async () => extraTools, execute: async () => 'unused' } }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); vi.restoreAllMocks(); modelCatalog.clear(); await close(server); await close(providerServer); store.close(); await rm(directory, { recursive: true, force: true }); });
  const api = async (path: string, method = 'GET', data?: unknown) => { const response = await fetch(url + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const seed = (size = 60000) => {
    const s = store.createSession(), messages: Message[] = [
      { id: randomUUID(), sessionId: s.id, role: 'user', content: 'Old request ' + 'x'.repeat(size / 2), attachments: [{ name: 'old', content: 'Old attachment' }], createdAt: 1 },
      { id: randomUUID(), sessionId: s.id, role: 'assistant', content: 'Old answer ' + 'y'.repeat(size / 2), createdAt: 2 },
    ]; messages.forEach(message => store.saveMessage(message)); return { s, before: messages };
  };
  const run = async (id: string, input = 'Latest task') => { runner.start(id, input); await runner.whenIdle(); };
  const snapshots = (id: string) => store.messages(id).filter(message => message.context).map(message => message.context!);
  const exactHistory = async (id: string, before: Message[]) => { const after = store.messages(id), count = calls.length; await runner.exclusive(id, () => runner.history.undo(id, runner.history.state(id).undoId!)); expect(store.messages(id)).toEqual(before); await runner.exclusive(id, () => runner.history.redo(id, runner.history.state(id).redoId!)); expect(store.messages(id)).toEqual(after); expect(calls).toHaveLength(count); };

  it('proactively compacts before completion, retains latest attachment snapshot and restores exact undo/redo', async () => {
    const { s, before } = seed(); const latest = { name: 'latest.txt', content: 'Keep these exact bytes', path: 'never-reread.txt' };
    runner.start(s.id, 'Latest task', [latest]); await runner.whenIdle();
    expect(calls).toHaveLength(2); expect(summaryRequest(calls[0])).toBe(true); expect(summaryRequest(calls[1])).toBe(false); expect(catalogs).toBe(0);
    expect(calls[0].messages[1].content.length).toBeLessThanOrEqual(compactionLimits(provider, s.model)!.maxSourceChars);
    expect(store.sessions('', true)).toHaveLength(1); const messages = store.messages(s.id);
    expect(store.messages(store.sessions('', true)[0].id).map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant']); expect(messages[1].attachments).toEqual([latest]);
    const sent=calls[1], expected=estimateRequest({provider,model:s.model,system:sent.messages[0].content,messages:sent.messages.slice(1),tools:sent.tools});
    expect(snapshots(s.id).at(-1)).toMatchObject({ providerId: provider.id, model: s.model, contextWindow: 16384, limitSource: 'override', action: 'continue', estimatedInputTokens:expected.estimatedInputTokens });
    expect(snapshots(s.id).at(-1)?.reason).toContain('was compacted');
    await exactHistory(s.id, before);
  });

  it('snapshots the exact outbound messages, system prompt, attachment parts and external tool schemas', async () => {
    extraTools.push({ type: 'function', function: { name: 'mcp_example', description: 'Schema '.repeat(80), parameters: { type: 'object', properties: { value: { type: 'string', description: 'Value '.repeat(80) } } } } });
    const s = store.createSession(); runner.start(s.id, 'Inspect image', [{ name: 'image.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]); await runner.whenIdle();
    const body = calls[0], expected = estimateRequest({ system: body.messages[0].content, messages: body.messages.slice(1), tools: body.tools });
    expect(snapshots(s.id)[0]).toMatchObject({ estimatedInputTokens: expected.estimatedInputTokens, uncertain: true }); expect(catalogs).toBe(0);
  });

  it.each(['unknown', 'huge-latest', 'huge-schema'])('%s context remains advisory and never trims or blocks generation', async kind => {
    if (kind === 'unknown') store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] });
    if (kind === 'huge-schema') extraTools.push({ type: 'function', function: { name: 'mcp_huge', description: 'Schema'.repeat(20000), parameters: { type: 'object' } } });
    const { s, before } = seed(); const latest = kind === 'huge-latest' ? 'Latest '.repeat(12000) : 'Latest task'; await run(s.id, latest);
    expect(calls).toHaveLength(1); expect(summaryRequest(calls[0])).toBe(false); expect(store.sessions('', true)).toHaveLength(0);
    expect(store.messages(s.id).slice(0, before.length)).toEqual(before); expect(store.messages(s.id).find(message => message.role === 'user' && message.content === latest)).toBeTruthy();
    expect(snapshots(s.id).at(-1)?.action).toBe('continue'); expect(snapshots(s.id).at(-1)?.reason).toBeTruthy();
    if (kind === 'unknown') expect(snapshots(s.id).at(-1)).toMatchObject({ limitSource: 'unknown' });
  });

  it.each(['empty', 'oversized', 'nonimproving', 'provider', 'sql'])('failed proactive summary (%s) preserves original and sends normal completion once', async failure => {
    const { s, before } = seed();
    if (failure === 'nonimproving') vi.spyOn(runner as any, 'providerMessages').mockImplementation((...args: unknown[]) => {
      // Candidate mapping is deliberately inflated to exercise the post-summary check.
      const id=args[0] as string, messages=(args[1] as Message[]|undefined) ?? store.messages(id);
      const mapped = messages.map(message => ({ role: message.role, content: message.content }));
      if (messages[0]?.role === 'system') mapped[0].content = 'inflated '.repeat(15000);
      return mapped;
    });
    if (failure === 'sql') store.db.exec("CREATE TRIGGER fail_context BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'compaction SQL failed'); END;");
    respond = (body, res) => {
      if (!summaryRequest(body)) return text(res, 'Original request completed');
      if (failure === 'provider') { res.writeHead(401); res.end('{}'); }
      else text(res, failure === 'empty' ? '' : failure === 'oversized' ? 'x'.repeat(24001) : 'Summary');
    };
    try { await run(s.id); } finally { if (failure === 'sql') store.db.exec('DROP TRIGGER fail_context'); }
    expect(calls).toHaveLength(2); expect(calls.filter(summaryRequest)).toHaveLength(1); expect(store.sessions('', true)).toHaveLength(0);
    expect(store.messages(s.id).slice(0, before.length)).toEqual(before); expect(snapshots(s.id).at(-1)?.reason).toContain('failed'); expect(store.session(s.id).status).toBe('idle');
    await exactHistory(s.id, before);
  });

  it('a failed reset event after committed compaction never resends stale original history', async () => {
    const { s, before } = seed(); vi.spyOn(console, 'error').mockImplementation(() => {});
    store.db.exec("CREATE TRIGGER fail_context_reset BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.type')='reset' BEGIN SELECT RAISE(ABORT,'reset failed'); END;");
    try { await run(s.id); } finally { store.db.exec('DROP TRIGGER fail_context_reset'); }
    expect(calls).toHaveLength(2); expect(calls.filter(summaryRequest)).toHaveLength(1);
    expect(calls[1].messages.some((message: any) => message.content === before[0].content)).toBe(false);
    expect(store.sessions('', true)).toHaveLength(1); expect(snapshots(s.id).at(-1)?.reason).toContain('compacted');
    await exactHistory(s.id, before);
  });

  it('progress uses one ephemeral assistant ID, reload reports running, and reset removes it before completion', async () => {
    const { s } = seed(); let finishSummary!: () => void;
    respond = (body, res) => { if (summaryRequest(body)) finishSummary = () => text(res, 'Summary'); else text(res, 'Done'); };
    runner.start(s.id, 'Latest task'); await until(() => Boolean(finishSummary));
    const progress = store.events(s.id, 0).find(event => event.type === 'message' && event.data.activity?.includes('Making room'))!;
    expect(progress).toBeTruthy();
    const detail = (await api(`/sessions/${s.id}`)).body;
    expect(detail.session.status).toBe('running'); expect(detail.lastEventId).toBeGreaterThanOrEqual(progress.id!);
    expect(detail.messages.filter((message: Message) => message.id === progress.data.id)).toEqual([progress.data]);
    expect(store.messages(s.id).some(message => message.id === progress.data.id)).toBe(false);
    const emit = runner.bus.emit.bind(runner.bus);
    vi.spyOn(runner.bus, 'emit').mockImplementation((id, type, data) => {
      if (type === 'reset') expect(runner.messages(id).some(message => message.id === progress.data.id)).toBe(false);
      return emit(id, type, data);
    });
    finishSummary(); await runner.whenIdle();
    const events = store.events(s.id, 0), reset = events.findIndex(event => event.type === 'reset');
    expect(reset).toBeGreaterThan(0); expect(events[reset].data.messages.some((message: Message) => message.id === progress.data.id)).toBe(false);
    expect(events.slice(reset + 1).some(event => event.type === 'message' && event.data.id === progress.data.id)).toBe(true);
    expect(store.messages(s.id).filter(message => message.id === progress.data.id)).toHaveLength(1);
    expect((await api(`/sessions/${s.id}`)).body.messages).toEqual(store.messages(s.id));
    expect(store.messages(store.sessions('', true)[0].id).some(message => message.id === progress.data.id)).toBe(false);
  });

  it('cancel during proactive summary preserves history and never sends original completion', async () => {
    const { s, before } = seed(); respond = (_body, res) => text(res, 'Partial summary', false);
    runner.start(s.id, 'Latest task'); await until(() => calls.length === 1);
    const progressId=runner.messages(s.id).at(-1)!.id;
    expect(store.messages(s.id).some(message=>message.id===progressId)).toBe(false);
    runner.enqueue(s.id, 'Held queue'); runner.cancel(s.id);
    expect(runner.messages(s.id).some(message=>message.id===progressId)).toBe(false);
    await runner.whenIdle(); expect(runner.messages(s.id)).toEqual(store.messages(s.id));
    expect(calls).toHaveLength(1); expect(store.sessions('', true)).toHaveLength(0); expect(store.messages(s.id).slice(0, before.length)).toEqual(before);
    expect(store.queue(s.id).paused).toBe(true); expect(runner.history.state(s.id).pendingRecovery).toBeUndefined(); await exactHistory(s.id, before);
  });

  it.each([false, true])('proactive and reactive recovery share one attempt even after summary failure=%s', async fails => {
    const { s } = seed(); respond = (body, res) => { if (summaryRequest(body)) { if (fails) { res.writeHead(401); res.end('{}'); } else text(res, 'Summary'); } else overflow(res); };
    await run(s.id); expect(calls).toHaveLength(2); expect(calls.filter(summaryRequest)).toHaveLength(1); expect(store.session(s.id).status).toBe('error');
  });

  it('later complete tool groups re-estimate without spending a second automatic summary', async () => {
    const { s } = seed(); let completions = 0;
    respond = (body, res) => { if (summaryRequest(body)) text(res, 'Summary'); else if (++completions === 1) tool(res); else text(res, 'Done after tool'); };
    await run(s.id); expect(calls).toHaveLength(3); expect(calls.filter(summaryRequest)).toHaveLength(1);
    expect(calls[2].messages.at(-1).role).toBe('tool'); expect(snapshots(s.id)).toHaveLength(2);
    expect(store.messages(s.id).filter(message => message.role === 'tool')).toHaveLength(1); expect(runner.history.state(s.id).canUndo).toBe(true);
  });

  it('explicit overflow still recovers tiny unknown history once, but partial response is never replayed', async () => {
    store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] }); const { s, before } = seed(30); let completed = 0;
    respond = (body, res) => { if (summaryRequest(body)) text(res, 'Summary longer than the old history is allowed for explicit overflow recovery'); else if (++completed === 1) overflow(res); else text(res, 'Done'); };
    await run(s.id); expect(calls).toHaveLength(3); expect(store.sessions('', true)).toHaveLength(1); await exactHistory(s.id, before);
    const other = store.createSession(); const count = calls.length;
    respond = (_body, res) => { text(res, 'Partial paid output', false); res.end(); };
    await run(other.id); expect(calls).toHaveLength(count + 1); expect(store.session(other.id).status).toBe('error');
  });

  it.each(['/models?providerId=budget', '/providers/test'])('only explicit %s catalog discovery populates identity cache', async endpoint => {
    store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] });
    const result = await api(endpoint, endpoint.startsWith('/models') ? 'GET' : 'POST', endpoint.startsWith('/models') ? undefined : { providerId: provider.id }); expect(result.status).toBe(200); expect(catalogs).toBe(1);
    const s = store.createSession(); await run(s.id); expect(snapshots(s.id).at(-1)).toMatchObject({ limitSource: 'catalog', contextWindow: 16384 }); expect(catalogs).toBe(1);
    store.saveSettings({ providers: [{ ...provider, contextWindows: {}, apiKey: 'different-test-identity' }] }); const changed = store.createSession(); await run(changed.id); expect(snapshots(changed.id).at(-1)?.limitSource).toBe('unknown'); expect(catalogs).toBe(1);
  });

  it.each(['/models?providerId=budget', '/providers/test'])('Codex %s discovery clears account-unscoped catalog limits but preserves exact overrides', async endpoint => {
    const codex: Provider = { ...provider, kind: 'codex', contextWindows: {} };
    store.saveSettings({ providers: [codex] });
    const discovered = [{ id: 'budget-model', name: 'Budget model', providerId: codex.id, contextWindow: 32768 }];
    const discovery = vi.spyOn(providers, 'listModels').mockResolvedValue(discovered);
    modelCatalog.remember(codex, discovered); expect(resolveContextBudget(codex, 'budget-model').limitSource).toBe('catalog');
    const result = await api(endpoint, endpoint.startsWith('/models') ? 'GET' : 'POST', endpoint.startsWith('/models') ? undefined : { providerId: codex.id });
    expect(result.status).toBe(200); expect(discovery).toHaveBeenCalledOnce();
    expect(resolveContextBudget(codex, 'budget-model').limitSource).toBe('unknown'); expect(resolveContextBudget(codex, 'budget-model').contextWindow).toBeUndefined();
    expect(resolveContextBudget({ ...codex, contextWindows: { 'budget-model': 65536 } }, 'budget-model')).toMatchObject({ limitSource: 'override', contextWindow: 65536 });
    expect(catalogs).toBe(0); expect(calls).toHaveLength(0);
  });

  it('expired model catalog stays unknown until explicit discovery instead of generating a hidden fetch', async () => {
    store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] }); await api('/models?providerId=budget');
    const cached = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(cached + 600001);
    const s = store.createSession(); await run(s.id);
    expect(catalogs).toBe(1); expect(snapshots(s.id).at(-1)?.limitSource).toBe('unknown'); expect(calls).toHaveLength(1);
  });

  it('settings validates overrides, preserves an omitted API key, and exposes no secret', async () => {
    store.saveSettings({ providers: [{ ...provider, apiKey: 'sentinel-test-key' }] });
    const response = await api('/settings', 'PATCH', { providers: [{ ...provider, contextWindows: { 'exact/model': 50000 } }] });
    expect(response.status).toBe(200); expect(response.body.providers[0].contextWindows).toEqual({ 'exact/model': 50000 }); expect(JSON.stringify(response.body)).not.toContain('sentinel-test-key'); expect(store.settings().providers[0].apiKey).toBe('sentinel-test-key');
    for (const contextWindows of [{ model: 1023 }, { model: 10000001 }, { model: 1024.5 }, { model: '16384' }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), 4096]))]) {
      expect((await api('/settings', 'PATCH', { providers: [{ ...provider, contextWindows }] })).status).toBe(400);
    }
    expect(store.settings().providers[0].contextWindows).toEqual({ 'exact/model': 50000 });
  });
});
