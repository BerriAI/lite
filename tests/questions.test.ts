import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { questionArgsSchema } from '../server/questions.js';
import { EventBus } from '../server/events.js';
import { Runner } from '../server/runner.js';
import type { QuestionAnswer, QuestionRequest } from '../shared/questions.js';
import type { Message, ToolCall } from '../shared/types.js';

const until = async (predicate: () => boolean) => { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const question = { question: 'Which approach?', options: [{ id: 'small', label: 'Small patch', description: 'Keep it focused' }, { id: 'large', label: 'Larger change' }] };
const call = (id = 'ask-1', name = 'ask_user', args: Record<string, unknown> = question): ToolCall => ({ id, name, args, status: 'pending' });
const stream = (res: ServerResponse, calls?: ToolCall[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = calls ? { tool_calls: calls.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : { content: 'Finished' };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};

describe('durable structured questions', () => {
  let directory: string, store: Store, runner: Runner, bus: EventBus, server: Server, provider: Server, url: string;
  let requests: any[], respond: (res: ServerResponse, index: number) => void;
  const controllers = new Set<AbortController>();
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-questions-'))); store = new Store(join(directory, 'state')); requests = [];
    respond = (res, index) => stream(res, index === 1 ? [call()] : undefined);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); requests.push(JSON.parse(Buffer.concat(chunks).toString())); respond(res, requests.length); });
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: await listen(provider) }], defaultProvider: 'test', defaultModel: 'test-model' });
    const app = createApp({ store }); runner = app.runner; bus = app.bus; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => {
    for (const controller of controllers) controller.abort(); controllers.clear(); runner.stopAll(); await runner.whenIdle();
    vi.restoreAllMocks(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true });
  });
  const api = async (path: string, body?: unknown) => { const response = await fetch(url + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const pending = async (id: string) => { await until(() => runner.questions.pending(id).length > 0); return runner.questions.pending(id)[0]; };
  const answer = (q: QuestionRequest, value: QuestionAnswer) => api(`/sessions/${q.sessionId}/questions/${q.id}/answer`, value);
  const rows = (id: string) => store.db.prepare('SELECT status,answer FROM questions WHERE session_id=? ORDER BY rowid').all(id) as { status: string; answer: string | null }[];
  const begin = (tools = [call()]) => {
    const session = store.createSession(), user: Message = { id: randomUUID(), sessionId: session.id, role: 'user', content: 'Ask a question', createdAt: 1 };
    runner.history.accept(session.id, user);
    const assistant: Message = { id: randomUUID(), sessionId: session.id, role: 'assistant', content: '', toolCalls: tools, providerMetadata: { opaque: 'preserve-exactly' }, createdAt: 2 };
    store.saveMessage(assistant); const controller = new AbortController(); controllers.add(controller);
    const waiting = runner.questions.ask(session.id, user.id, assistant.id, tools[0].id, tools[0].args, controller.signal);
    return { session, user, assistant, controller, waiting, request: runner.questions.pending(session.id)[0] };
  };

  it.each([
    { question: '' }, { question: ' '.repeat(2) }, { question: 'a'.repeat(2001) },
    { ...question, options: Array.from({ length: 9 }, (_, index) => ({ id: String(index), label: 'Choice' })) },
    { ...question, options: [{ id: 'dup', label: 'One' }, { id: 'dup', label: 'Two' }] },
    { ...question, options: [{ id: '', label: 'Choice' }] }, { ...question, options: [{ id: 'x'.repeat(65), label: 'Choice' }] },
    { ...question, options: [{ id: 'x', label: 'a'.repeat(201) }] }, { ...question, options: [{ id: 'x', label: 'One', description: 'a'.repeat(501) }] },
    { ...question, allowCustom: false },
  ])('validates question bounds and unique option IDs (%j)', args => { expect(() => questionArgsSchema.parse(args)).toThrow(); });

  it('allows zero options and all boundary-length fields', () => {
    expect(questionArgsSchema.parse({ question: 'Open question' }).options).toEqual([]);
    expect(questionArgsSchema.parse({ question: 'a'.repeat(2000), options: Array.from({ length: 8 }, (_, index) => ({ id: String(index).padEnd(64, 'x'), label: 'a'.repeat(200), description: 'a'.repeat(500) })) }).options).toHaveLength(8);
  });

  it('commits normalized answer, assistant outcome and one deterministic tool result before waking', async () => {
    const f = begin(); let awakened = false; const waiter = f.waiting.then(value => { awakened = true; return value; });
    const receipt = runner.questions.answer(f.session.id, f.request.id, { kind: 'text', text: '  custom answer  ' });
    expect(receipt).toEqual({ id: f.request.id, status: 'answered', answer: { kind: 'text', text: 'custom answer' } }); expect(awakened).toBe(false);
    const messages = store.messages(f.session.id), result = messages.at(-1)!;
    expect(result).toMatchObject({ id: `question-result:${f.request.id}`, role: 'tool', toolCallId: 'ask-1' });
    expect(JSON.parse(result.content)).toEqual({ questionId: f.request.id, status: 'answered', answer: receipt.answer });
    expect(messages[1]).toMatchObject({ providerMetadata: f.assistant.providerMetadata, toolCalls: [{ status: 'completed', output: result.content }] });
    expect(rows(f.session.id)).toEqual([{ status: 'answered', answer: JSON.stringify(receipt.answer) }]);
    await waiter; expect(awakened).toBe(true); expect(runner.questions.pending(f.session.id)).toEqual([]);
    const lastEvent = store.latestEventId(f.session.id);
    expect(runner.questions.answer(f.session.id, f.request.id, { kind: 'text', text: 'custom answer' })).toEqual(receipt);
    expect(store.latestEventId(f.session.id)).toBe(lastEvent); expect(store.messages(f.session.id)).toEqual(messages);
    expect(() => runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'large' })).toThrow('different answer');
  });

  it.each(['claim', 'assistant', 'result'])('rolls back %s failure and keeps the same question answerable', async failure => {
    const f = begin(); let awakened = false; void f.waiting.then(() => { awakened = true; });
    const before = store.messages(f.session.id);
    const sql = failure === 'claim' ? "CREATE TRIGGER reject_question BEFORE UPDATE ON questions BEGIN SELECT RAISE(ABORT,'settlement failed'); END;" : failure === 'assistant' ? "CREATE TRIGGER reject_question BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'settlement failed'); END;" : "CREATE TRIGGER reject_question BEFORE INSERT ON messages WHEN json_extract(NEW.data,'$.role')='tool' BEGIN SELECT RAISE(ABORT,'settlement failed'); END;";
    store.db.exec(sql);
    try { expect(() => runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' })).toThrow('settlement failed'); expect(store.messages(f.session.id)).toEqual(before); expect(rows(f.session.id)[0].status).toBe('pending'); await Promise.resolve(); expect(awakened).toBe(false); }
    finally { store.db.exec('DROP TRIGGER reject_question'); }
    runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' }); await f.waiting;
    expect(store.messages(f.session.id).filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it('committed settlement survives persistent event failure and a lost HTTP response retry', async () => {
    const f = begin(); vi.spyOn(console, 'error').mockImplementation(() => {});
    store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'events failed'); END;");
    try { expect(runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' }).status).toBe('answered'); await f.waiting; expect(runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' }).status).toBe('answered'); }
    finally { store.db.exec('DROP TRIGGER reject_event'); }
    expect(store.messages(f.session.id).filter(message => message.role === 'tool')).toHaveLength(1); expect(requests).toHaveLength(0);
  });

  it.each(['plan', 'build'] as const)('asks explicitly in %s auto mode without granting permission', async mode => {
    const s = store.createSession({ mode, permissionMode: 'auto' }), start = await api(`/sessions/${s.id}/messages`, { content: 'Need a decision' });
    expect(start.status).toBe(202); const q = await pending(s.id);
    expect(q.turnId).toBe(start.body.messageId); expect(q.options).toEqual(question.options);
    expect((await api(`/sessions/${s.id}`)).body.questions).toEqual([q]); expect((await api(`/sessions/${s.id}/questions`)).body).toEqual({ questions: [q] });
    expect(store.session(s.id).status).toBe('waiting'); expect(runner.permissions(s.id)).toEqual([]); expect(store.toolGrants(s.id)).toEqual([]);
    expect(store.events(s.id, 0).filter(event => event.type === 'message' && event.data.id === q.messageId).at(-1)?.data.toolCalls[0].status).toBe('running');
    expect(requests[0].tools.some((tool: any) => tool.function.name === 'ask_user')).toBe(true); expect(requests).toHaveLength(1);
    expect((await answer(q, { kind: 'option', optionId: 'small' })).body).toEqual({ id: q.id, status: 'answered', answer: { kind: 'option', optionId: 'small' } });
    await runner.whenIdle(); expect(requests).toHaveLength(2); expect(runner.history.state(s.id).canUndo).toBe(true);
    expect(store.events(s.id, 0).filter(event => event.type === 'question').map(event => event.data)).toEqual([q]);
    expect(store.events(s.id, 0).filter(event => event.type === 'question_resolved').map(event => event.data)).toEqual([{ id: q.id, status: 'answered' }]);
  });

  it('multiple questions and tools in one batch keep all settled outcomes and IDs without duplicate results', async () => {
    const s = store.createSession({ permissionMode: 'ask' });
    respond = (res, index) => stream(res, index === 1 ? [call(), call('read', 'todo_read', {}), call('ask-2', 'ask_user', { question: 'Anything else?' })] : undefined);
    runner.start(s.id, 'Several questions'); const first = await pending(s.id); await answer(first, { kind: 'option', optionId: 'large' });
    await until(() => runner.questions.pending(s.id)[0]?.toolCallId === 'ask-2'); const second = runner.questions.pending(s.id)[0];
    expect((await answer(first, { kind: 'option', optionId: 'large' })).status).toBe(200);
    await answer(second, { kind: 'text', text: 'Continue carefully' }); await runner.whenIdle();
    const messages = store.messages(s.id), assistant = messages.find(message => message.toolCalls?.length === 3)!;
    expect(assistant.toolCalls?.map(tool => tool.status)).toEqual(['completed', 'completed', 'completed']);
    expect(messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['ask-1', 'read', 'ask-2']);
    expect(new Set(messages.map(message => message.id)).size).toBe(messages.length); expect(requests).toHaveLength(2); expect(store.toolGrants(s.id)).toEqual([]);
    await runner.exclusive(s.id, () => runner.history.undo(s.id, runner.history.state(s.id).undoId!));
    expect((await answer(first, { kind: 'option', optionId: 'large' })).status).toBe(409); expect(runner.questions.pending(s.id)).toEqual([]);
    await runner.exclusive(s.id, () => runner.history.redo(s.id, runner.history.state(s.id).redoId!));
    expect(store.messages(s.id)).toEqual(messages); expect(runner.questions.pending(s.id)).toEqual([]); expect(requests).toHaveLength(2);
    const fork = store.fork(s.id); expect(runner.questions.pending(fork.id)).toEqual([]); expect((await api(`/sessions/${fork.id}/questions/${first.id}/answer`, { kind: 'option', optionId: 'large' })).status).toBe(404);
  });

  it('rejects duplicate provider tool IDs before any mutable tool executes or question becomes actionable', async () => {
    const s = store.createSession({ permissionMode: 'auto' });
    respond = res => {
      runner.enqueue(s.id, 'Held after malformed response');
      stream(res, [call('duplicate', 'write_file', { path: 'duplicate.txt', content: 'Must not be written' }), call('duplicate')]);
    };
    runner.start(s.id, 'Ambiguous provider IDs'); await runner.whenIdle();
    expect(store.session(s.id).status).toBe('error'); expect(runner.active(s.id)).toBe(false); expect(requests).toHaveLength(1);
    expect(store.messages(s.id).find(message => message.toolCalls?.length)?.error).toContain('duplicate tool call IDs');
    expect(store.messages(s.id).filter(message => message.role === 'tool')).toEqual([]);
    expect(rows(s.id)).toEqual([]); expect(runner.questions.pending(s.id)).toEqual([]); expect(runner.permissions(s.id)).toEqual([]); expect(store.changes(s.id)).toEqual([]);
    expect(store.db.prepare('SELECT path FROM history_intents WHERE session_id=?').all(s.id)).toEqual([]);
    expect(runner.history.state(s.id).pendingRecovery).toBeTruthy(); expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Held after malformed response' }] });
    await expect(readFile(join(directory, 'duplicate.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => runner.resumeQueue(s.id)).toThrow();
    const rejected = store.messages(s.id); await runner.exclusive(s.id, () => runner.history.recover(s.id));
    const archive = store.sessions('', true)[0]; expect(archive).toBeTruthy(); expect(store.messages(archive.id).map(({ id: _id, sessionId: _sessionId, ...message }) => message)).toEqual(rejected.map(({ id: _id, sessionId: _sessionId, ...message }) => message));
    expect(store.messages(s.id).some(message => message.role === 'tool')).toBe(false); expect(runner.history.state(s.id).pendingRecovery).toBeUndefined();
    await runner.exclusive(s.id, () => runner.history.undo(s.id, runner.history.state(s.id).undoId!)); await runner.exclusive(s.id, () => runner.history.redo(s.id, runner.history.state(s.id).redoId!));
    expect(requests).toHaveLength(1); expect(runner.questions.pending(s.id)).toEqual([]); await expect(readFile(join(directory, 'duplicate.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('answer is not permission for the following mutable tool', async () => {
    const s = store.createSession({ permissionMode: 'ask' });
    respond = (res, index) => stream(res, index === 1 ? [call(), call('write', 'write_file', { path: 'result.txt', content: 'not authorized yet' })] : undefined);
    runner.start(s.id, 'Ask then write'); const q = await pending(s.id); await answer(q, { kind: 'text', text: 'Yes' });
    await until(() => runner.permissions(s.id).length === 1); expect(runner.permissions(s.id)[0].tool).toBe('write_file'); expect(store.toolGrants(s.id)).toEqual([]);
    await expect(readFile(join(directory, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); runner.cancel(s.id); await runner.whenIdle();
  });

  it.each(['cancel', 'stopAll'])('%s settles unanswered question as cancelled, aborts the rest of batch and holds queue', async action => {
    const s = store.createSession({ permissionMode: 'auto' });
    respond = res => stream(res, [call(), call('write', 'write_file', { path: 'result.txt', content: 'never' }), call('ask-2')]);
    runner.start(s.id, 'Ask then stop'); const q = await pending(s.id); runner.enqueue(s.id, 'Do not replay');
    if (action === 'cancel') runner.cancel(s.id); else runner.stopAll(); await runner.whenIdle();
    expect(runner.questions.pending(s.id)).toEqual([]); expect(rows(s.id)).toEqual([{ status: 'cancelled', answer: null }]);
    expect(store.messages(s.id).flatMap(message => message.toolCalls ?? []).map(tool => tool.status)).toEqual(['denied', 'denied', 'denied']);
    expect(store.messages(s.id).filter(message => message.role === 'tool')).toHaveLength(3); expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Do not replay' }] });
    expect((await answer(q, { kind: 'text', text: 'Late' })).status).toBe(409); expect(requests).toHaveLength(1); expect(runner.history.state(s.id).canUndo).toBe(true);
    await expect(readFile(join(directory, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancellation storage failure does not fabricate a result and exposes explicit history recovery', async () => {
    const s = store.createSession(); runner.start(s.id, 'Cancel while database rejects settlement'); const q = await pending(s.id);
    store.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON questions BEGIN SELECT RAISE(ABORT,'cancel failed'); END;");
    try { runner.cancel(s.id); await runner.whenIdle(); expect(store.messages(s.id).filter(message => message.role === 'tool')).toEqual([]); expect(runner.questions.pending(s.id)).toEqual([]); expect(runner.history.state(s.id).pendingRecovery).toBeTruthy(); expect((await answer(q, { kind: 'text', text: 'Too late' })).status).toBe(409); }
    finally { store.db.exec('DROP TRIGGER reject_cancel'); }
    await runner.exclusive(s.id, () => runner.history.recover(s.id)); expect(requests).toHaveLength(1); expect(runner.history.state(s.id).pendingRecovery).toBeUndefined();
  });

  it.each([
    { kind: 'text', text: '' }, { kind: 'text', text: '   ' }, { kind: 'text', text: 'a'.repeat(8001) },
    { kind: 'option', optionId: 'unknown' }, { kind: 'option', optionId: ['small'] }, { kind: 'text', text: 'ok', always: true },
  ])('API rejects malformed answer without consuming pending request (%j)', async value => {
    const s = store.createSession(); runner.start(s.id, 'Validate answer'); const q = await pending(s.id);
    expect((await api(`/sessions/${s.id}/questions/${q.id}/answer`, value)).status).toBe(400); expect(runner.questions.pending(s.id)).toEqual([q]); expect(requests).toHaveLength(1); runner.cancel(s.id); await runner.whenIdle();
  });

  it('wrong-session answers are 404, identical retries 200, different answers 409 and retries do not wake', async () => {
    const s = store.createSession(), other = store.createSession(); runner.start(s.id, 'Answer once'); const q = await pending(s.id);
    expect((await api(`/sessions/${other.id}/questions/${q.id}/answer`, { kind: 'option', optionId: 'small' })).status).toBe(404);
    const same = { kind: 'option', optionId: 'small' } as const;
    const results = await Promise.all([answer(q, same), answer(q, same), answer(q, { kind: 'text', text: 'Different' })]);
    expect(results.map(result => result.status)).toEqual([200, 200, 409]); await runner.whenIdle();
    expect((await answer(q, same)).status).toBe(200); expect(store.messages(s.id).filter(message => message.role === 'tool')).toHaveLength(1); expect(requests).toHaveLength(2);
  });

  it.each([false, true])('restart interrupts unanswered questions and retains committed answers (answered=%s)', async answered => {
    const f = begin();
    if (answered) { runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' }); await f.waiting; }
    controllers.delete(f.controller); const before = store.messages(f.session.id), restarted = new Store(store.directory);
    try {
      const restored = new Runner(restarted, new EventBus(restarted));
      expect(restored.questions.pending(f.session.id)).toEqual([]); expect(restarted.messages(f.session.id)).toEqual(before); expect(requests).toHaveLength(0);
      expect(restored.history.state(f.session.id).pendingRecovery).toBeTruthy();
      expect(restarted.events(f.session.id, 0).filter(event => event.type === 'question_resolved').at(-1)?.data).toEqual({ id: f.request.id, status: answered ? 'answered' : 'interrupted' });
      if (answered) expect(restored.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' }).status).toBe('answered');
      else expect(() => restored.questions.answer(f.session.id, f.request.id, { kind: 'text', text: 'Late' })).toThrow('no longer pending');
      await restored.exclusive(f.session.id, () => restored.history.recover(f.session.id));
      expect(restored.history.state(f.session.id).canUndo).toBe(true);
      expect(restarted.sessions('', true)).toHaveLength(answered ? 0 : 1); expect(requests).toHaveLength(0);
      if (answered) expect(restarted.messages(f.session.id)).toEqual(before);
      else expect(restarted.messages(f.session.id).some(message => message.role === 'tool')).toBe(false);
    } finally { restarted.close(); }
  });

  it('streams raw question and resolution events to a connected SSE client', async () => {
    const s = store.createSession(), controller = new AbortController();
    const response = await fetch(`${url}/api/sessions/${s.id}/events`, { signal: controller.signal });
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let received = '';
    const pump = (async () => { try { for (;;) { const chunk = await reader.read(); if (chunk.done) return; received += decoder.decode(chunk.value); } } catch { /* Expected reader cancellation. */ } })();
    try {
      runner.start(s.id, 'SSE question'); const q = await pending(s.id); await until(() => received.includes('"type":"question"'));
      await answer(q, { kind: 'text', text: 'Answer over HTTP' }); await runner.whenIdle(); await until(() => received.includes('"type":"question_resolved"'));
      const events = received.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      expect(events.find(event => event.type === 'question').data).toEqual(q);
      expect(events.find(event => event.type === 'question_resolved').data).toEqual({ id: q.id, status: 'answered' });
    } finally { controller.abort(); await reader.cancel().catch(() => {}); await pump; }
  });

  it('accepts maximum custom-text length and malformed ask_user arguments create no actionable row', async () => {
    const f = begin([call('ask-1', 'ask_user', { question: 'Custom only', options: [] })]);
    expect(runner.questions.answer(f.session.id, f.request.id, { kind: 'text', text: 'x'.repeat(8000) }).answer).toEqual({ kind: 'text', text: 'x'.repeat(8000) }); await f.waiting;
    const s = store.createSession(); respond = (res, index) => stream(res, index === 1 ? [call('invalid', 'ask_user', { question: 'x', options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] })] : undefined);
    runner.start(s.id, 'Invalid args'); await runner.whenIdle();
    expect(rows(s.id)).toEqual([]); expect(runner.questions.pending(s.id)).toEqual([]); expect(runner.permissions(s.id)).toEqual([]);
    expect(store.messages(s.id).flatMap(message => message.toolCalls ?? []).map(tool => tool.status)).toEqual(['error']); expect(runner.history.state(s.id).canUndo).toBe(true);
  });

  it.each(['answer-first', 'cancel-first'] as const)('answer/cancel race has one durable outcome (%s)', async order => {
    const f = begin();
    if (order === 'answer-first') { runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' }); f.controller.abort(); }
    else { f.controller.abort(); expect(() => runner.questions.answer(f.session.id, f.request.id, { kind: 'option', optionId: 'small' })).toThrow('no longer pending'); }
    const result = await f.waiting;
    expect(result.status).toBe(order === 'answer-first' ? 'answered' : 'cancelled');
    expect(store.messages(f.session.id).filter(message => message.role === 'tool')).toHaveLength(1);
    expect(store.events(f.session.id, 0).filter(event => event.type === 'question_resolved')).toHaveLength(1);
  });

  it('pending questions cascade on session deletion and never reappear in a fork', async () => {
    const f = begin(); f.controller.abort(); await f.waiting; runner.history.seal(f.session.id);
    const fork = store.fork(f.session.id); expect(rows(fork.id)).toEqual([]); expect(runner.questions.pending(fork.id)).toEqual([]);
    store.deleteSession(f.session.id);
    expect(store.db.prepare('SELECT id FROM questions WHERE id=?').get(f.request.id)).toBeUndefined();
  });

  it('imported question tool names and foreign IDs are inert and need truthful history recovery', async () => {
    const imported = await api('/sessions/import', { session: { title: 'Imported' }, messages: [{ id: 'u', role: 'user', content: 'Old question', createdAt: 1 }, { id: 'a', role: 'assistant', content: '', createdAt: 2, toolCalls: [call()] }] });
    expect(imported.status).toBe(201); const id = imported.body.id;
    expect((await api(`/sessions/${id}/questions`)).body).toEqual({ questions: [] });
    expect((await api(`/sessions/${id}/questions/ask-1/answer`, { kind: 'text', text: 'Not actionable' })).status).toBe(404);
    expect(runner.history.state(id).pendingRecovery).toBeTruthy(); expect(requests).toHaveLength(0);
    await runner.exclusive(id, () => runner.history.recover(id)); expect(store.messages(id).some(message => message.role === 'tool')).toBe(false); expect(requests).toHaveLength(0);
  });
});
