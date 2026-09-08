import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { History } from '../server/history.js';
import { Delegations } from '../server/delegations.js';
import { TerminalManager, attachTerminals } from '../server/terminal.js';
import { resolveProfileChoice } from '../server/profiles.js';
import type { Message, Session, ToolCall } from '../shared/types.js';
import type { ProfileSnapshot } from '../server/profiles.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean | Promise<boolean>) => { await expect.poll(check, { timeout: 5000, interval: 10 }).toBe(true); };
const task = (id = 'research-call', prompt = 'Inspect the test fixture without changing anything.'): ToolCall => ({ id, name: 'task', args: { description: 'Independent audit', prompt }, status: 'pending' });
const stream = (res: ServerResponse, value: string | ToolCall[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const delta = typeof value === 'string' ? { content: value } : { tool_calls: value.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) };
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: typeof value === 'string' ? 'stop' : 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
type Request = { model: string; messages: { role: string; content: any }[]; tools?: { function: { name: string } }[] };

describe('independent researcher delegation seam audit', () => {
  let directory: string, store: Store, server: Server, provider: Server, base: string;
  let app: ReturnType<typeof createApp>, requests: Request[], respond: (request: Request, res: ServerResponse) => void;
  const extras: Server[] = [];
  const sockets: WebSocket[] = [];
  let terminalTransport: ReturnType<typeof attachTerminals> | undefined;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-delegation-audit-')));
    store = new Store(join(directory, 'state')); requests = [];
    respond = (_request, res) => stream(res, 'Unconfigured audit provider.');
    provider = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request: Request = JSON.parse(Buffer.concat(chunks).toString()); requests.push(request); respond(request, res);
    });
    store.saveSettings({ workspace: directory, providers: [{ id: 'audit', name: 'Audit loopback', kind: 'openai', baseUrl: await listen(provider), apiKey: 'synthetic-delegation-original-key' }], defaultProvider: 'audit', defaultModel: 'audit-model' });
    app = createApp({ store }); server = createServer(app.app); base = await listen(server);
  });
  afterEach(async () => {
    app.runner.stopAll(); await app.runner.whenIdle();
    for (const socket of sockets.splice(0)) socket.terminate();
    await terminalTransport?.close(); terminalTransport = undefined;
    await Promise.all([close(server), close(provider), ...extras.splice(0).map(close)]);
    vi.restoreAllMocks(); store.close(); await rm(directory, { recursive: true, force: true });
  });
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const rawState = () => Object.fromEntries(['sessions', 'messages', 'delegations', 'history_checkpoints', 'session_profiles', 'queues', 'tool_grants', 'events'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const begin = (calls = [task()], mode: Session['mode'] = 'build') => {
    const parent = store.createSession({ mode, permissionMode: 'auto' });
    const user: Message = { id: randomUUID(), sessionId: parent.id, role: 'user', content: 'Parent accepted audit task.', createdAt: 1 };
    app.runner.history.accept(parent.id, user);
    const assistant: Message = { id: randomUUID(), sessionId: parent.id, role: 'assistant', content: '', toolCalls: calls, providerMetadata: { opaque: 'parent-only-provider-state' }, createdAt: 2 };
    store.saveMessage(assistant);
    const create = (call = calls[0], profile: ProfileSnapshot | null = null) => app.runner.delegations.create({ parentSessionId: parent.id, parentTurnId: user.id, parentMessageId: assistant.id, toolCallId: call.id, description: String(call.args.description), prompt: String(call.args.prompt), childSession: parent, profile });
    return { parent, user, assistant, create };
  };
  const complete = (created: ReturnType<Delegations['create']>, output = 'Bounded independent findings.') => {
    store.saveMessage({ id: randomUUID(), sessionId: created.child.id, role: 'assistant', content: output, createdAt: Date.now() });
    app.runner.history.seal(created.child.id);
    return app.runner.delegations.settle(created.delegation.id, 'completed', output);
  };

  it('launches a real private Plan child only after a matching accepted parent turn exists', () => {
    const f = begin([task()], 'plan'), before = rawState();
    expect(() => app.runner.delegations.create({ parentSessionId: f.parent.id, parentTurnId: randomUUID(), parentMessageId: f.assistant.id, toolCallId: 'research-call', description: 'Forged origin', prompt: 'Never start.', childSession: f.parent, profile: null })).toThrow();
    expect(rawState()).toEqual(before);
    const child = f.create();
    expect(child.child).toMatchObject({ mode: 'plan', permissionMode: 'auto' });
    expect(store.isChild(child.child.id)).toBe(true);
    expect(store.sessions().map(session => session.id)).toEqual([f.parent.id]);
    expect(store.messages(child.child.id)).toEqual([child.user]);
    expect(child.user.attachments).toBeUndefined(); expect(child.user.providerMetadata).toBeUndefined();
    expect(app.runner.history.state(child.child.id)).toMatchObject({ hasCheckpoints: true, canUndo: false, canRedo: false });
    expect(requests).toEqual([]);
  });

  it.each(['child', 'pin', 'link', 'parent', 'checkpoint', 'prompt'])('atomically rolls back rejected child acceptance at the %s boundary', async boundary => {
    await mkdir(join(directory, '.lite/skills/audit'), { recursive: true });
    await writeFile(join(directory, '.lite/profiles.json'), JSON.stringify({ version: 1, profiles: [], skills: [{ id: 'audit', name: 'Audit', description: 'Pinned audit instructions' }] }));
    await writeFile(join(directory, '.lite/skills/audit/SKILL.md'), 'PRIVATE_AUDIT_SKILL — exact UTF-8\r\nno final newline');
    const resolved = await resolveProfileChoice(directory, { profileId: null, skillIds: ['audit'] });
    const f = begin(), before = rawState();
    const rule = {
      child: 'BEFORE INSERT ON sessions', pin: 'BEFORE INSERT ON session_profiles', link: 'BEFORE INSERT ON delegations',
      parent: 'BEFORE UPDATE ON messages', checkpoint: 'BEFORE INSERT ON history_checkpoints',
      prompt: "BEFORE INSERT ON messages WHEN json_extract(NEW.data,'$.role')='user'",
    }[boundary];
    store.db.exec(`CREATE TRIGGER audit_reject ${rule} BEGIN SELECT RAISE(ABORT,'atomic audit rejection'); END;`);
    try { expect(() => f.create(undefined, resolved.snapshot)).toThrow('atomic audit rejection'); expect(rawState()).toEqual(before); }
    finally { store.db.exec('DROP TRIGGER audit_reject'); }
    const created = f.create(undefined, resolved.snapshot);
    expect(store.profileSnapshot(created.child.id)).toEqual(resolved.snapshot);
    expect(store.messages(created.child.id)).toEqual([created.user]);
    expect(app.runner.delegations.list(f.parent.id)).toHaveLength(1); expect(requests).toEqual([]);
  });

  it('keeps reused provider call IDs separate across assistant groups and retains mixed batch outcomes', () => {
    const first = task('reused'), second = task('other');
    const f = begin([first, second]), child = f.create(first);
    const one = complete(child, 'First group report.');
    const childTwo = f.create(second); complete(childTwo, 'Second report in first group.');
    const saved = store.messages(f.parent.id).find(message => message.id === f.assistant.id)!;
    expect(saved.providerMetadata).toEqual(f.assistant.providerMetadata);
    expect(saved.toolCalls?.map(call => ({ id: call.id, status: call.status, delegationId: call.delegationId }))).toEqual([
      { id: 'reused', status: 'completed', delegationId: child.delegation.id }, { id: 'other', status: 'completed', delegationId: childTwo.delegation.id },
    ]);
    const next: Message = { id: randomUUID(), sessionId: f.parent.id, role: 'assistant', content: '', toolCalls: [task('reused')], createdAt: Date.now() };
    store.saveMessage(next);
    const later = app.runner.delegations.create({ parentSessionId: f.parent.id, parentTurnId: f.user.id, parentMessageId: next.id, toolCallId: 'reused', description: 'Later same provider ID', prompt: 'Independent new research.', childSession: f.parent, profile: null });
    const two = complete(later, 'Later group report.');
    expect(one.result.id).not.toBe(two.result.id);
    expect(store.messages(f.parent.id).filter(message => message.role === 'tool' && message.toolCallId === 'reused').map(message => message.content)).toEqual(['First group report.', 'Later group report.']);
    expect(app.runner.delegations.settle(child.delegation.id, 'failed', 'late overwrite')).toMatchObject({ delegation: { status: 'completed' }, result: one.result });
    expect(app.runner.delegations.list(f.parent.id)).toHaveLength(3); expect(requests).toEqual([]);
  });

  it('binds access to the current parent transcript through undo/redo and strips copied fork/archive links', async () => {
    const f = begin(), child = f.create(); complete(child); app.runner.history.seal(f.parent.id);
    const checkpoint = app.runner.history.state(f.parent.id).undoId!;
    const transcript = app.runner.delegations.transcript(f.parent.id, child.delegation.id);
    const fork = store.fork(f.parent.id);
    expect(store.isChild(fork.id)).toBe(false);
    expect(store.messages(fork.id).flatMap(message => message.toolCalls ?? []).every(call => call.delegationId === undefined)).toBe(true);
    expect(app.runner.delegations.list(fork.id)).toEqual([]);
    expect(() => app.runner.delegations.transcript(fork.id, child.delegation.id)).toThrow();
    const copied = store.messages(fork.id).find(message => message.toolCalls?.length)!;
    copied.toolCalls![0].delegationId = child.delegation.id; store.saveMessage(copied);
    expect(app.runner.delegations.list(fork.id)).toEqual([]);
    expect(() => app.runner.delegations.get(fork.id, child.delegation.id)).toThrow();
    await app.runner.history.undo(f.parent.id, checkpoint);
    expect(app.runner.delegations.list(f.parent.id)).toEqual([]);
    expect(() => app.runner.delegations.transcript(f.parent.id, child.delegation.id)).toThrow();
    await app.runner.history.redo(f.parent.id, checkpoint);
    expect(app.runner.delegations.transcript(f.parent.id, child.delegation.id)).toEqual(transcript);
    const archive = app.runner.history.compact(f.parent.id, [{ id: randomUUID(), sessionId: f.parent.id, role: 'system', content: 'Archived audit context.', createdAt: Date.now() }]);
    expect(app.runner.delegations.list(archive.id)).toEqual([]);
    expect(store.messages(archive.id).flatMap(message => message.toolCalls ?? []).every(call => call.delegationId === undefined)).toBe(true);
    expect(() => app.runner.delegations.transcript(archive.id, child.delegation.id)).toThrow();
    expect(requests).toEqual([]);
  });

  it.each(['assistant', 'result', 'terminal'])('rolls back %s settlement failure without duplicating a later retry', boundary => {
    const f = begin(), child = f.create();
    store.saveMessage({ id: randomUUID(), sessionId: child.child.id, role: 'assistant', content: 'Finished child.', createdAt: 3 });
    app.runner.history.seal(child.child.id); const before = rawState();
    const rule = { assistant: 'BEFORE UPDATE ON messages', result: "BEFORE INSERT ON messages WHEN json_extract(NEW.data,'$.role')='tool'", terminal: 'BEFORE UPDATE ON delegations' }[boundary];
    store.db.exec(`CREATE TRIGGER audit_reject ${rule} BEGIN SELECT RAISE(ABORT,'settlement audit rejection'); END;`);
    try { expect(() => app.runner.delegations.settle(child.delegation.id, 'completed', 'Original report.')).toThrow('settlement audit rejection'); expect(rawState()).toEqual(before); }
    finally { store.db.exec('DROP TRIGGER audit_reject'); }
    const settled = app.runner.delegations.settle(child.delegation.id, 'completed', 'Original report.');
    expect(app.runner.delegations.settle(child.delegation.id, 'cancelled', 'Late cancellation.')).toEqual(settled);
    expect(store.messages(f.parent.id).filter(message => message.role === 'tool')).toEqual([settled.result]);
    expect(requests).toEqual([]);
  });

  it.each([false, true])('reopens unfinished child with malformed origin=%s without replay or duplicate result', malformed => {
    const f = begin(), child = f.create();
    store.updateSession(child.child.id, { status: 'running' });
    if (malformed) { const assistant = store.messages(f.parent.id).find(message => message.id === f.assistant.id)!; assistant.toolCalls![0].delegationId = randomUUID(); store.saveMessage(assistant); }
    store.close(); store = new Store(join(directory, 'state'));
    let history = new History(store), delegations = new Delegations(store, history);
    expect(store.session(child.child.id).status).toBe('idle'); expect(store.queue(child.child.id).paused).toBe(true);
    expect(store.isChild(child.child.id)).toBe(true);
    const results = store.messages(f.parent.id).filter(message => message.role === 'tool');
    expect(results).toHaveLength(malformed ? 0 : 1);
    if (!malformed) expect(delegations.get(f.parent.id, child.delegation.id).status).toBe('interrupted');
    const after = rawState();
    store.close(); store = new Store(join(directory, 'state')); history = new History(store); delegations = new Delegations(store, history);
    expect(rawState()).toEqual(after);
    expect(store.messages(f.parent.id).filter(message => message.role === 'tool')).toEqual(results);
    expect(requests).toEqual([]);
  });

  it('blocks native terminal access using the actual private child link, not public ancestry', async () => {
    const f = begin(), child = f.create(), factory = vi.fn();
    const manager = new TerminalManager(store, factory);
    expect(() => manager.validate(child.child.id)).toThrow('read-only'); expect(factory).not.toHaveBeenCalled(); await manager.close();
    terminalTransport = attachTerminals(server, store);
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + `/api/sessions/${child.child.id}/terminal`, { origin: base }); sockets.push(socket);
      socket.on('unexpected-response', (_req, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.on('open', () => { socket.terminate(); reject(new Error('Child terminal unexpectedly opened.')); }); socket.on('error', () => {});
    });
    expect(status).toBe(409); expect(requests).toEqual([]);
  });

  const isResearch = (request: Request) => typeof request.messages[0]?.content === 'string' && request.messages[0].content.includes('foreground read-only researcher');

  it('inherits accepted provider, project guidance and private skill bytes despite drift before launch', async () => {
    await writeFile(join(directory, 'AGENTS.md'), 'ORIGINAL_ACCEPTED_GUIDANCE');
    await mkdir(join(directory, '.lite/skills/audit'), { recursive: true });
    await writeFile(join(directory, '.lite/profiles.json'), JSON.stringify({ version: 1, profiles: [], skills: [{ id: 'audit', name: 'Audit', description: 'Pinned skill' }] }));
    await writeFile(join(directory, '.lite/skills/audit/SKILL.md'), 'ORIGINAL_PINNED_SKILL\r\nexact ending');
    const resolved = await resolveProfileChoice(directory, { profileId: null, skillIds: ['audit'] });
    const parent = store.createSession({ permissionMode: 'auto' }, resolved);
    let held: ServerResponse | undefined;
    respond = (request, res) => {
      if (isResearch(request)) stream(res, 'Research using captured policy.');
      else if (request.messages.at(-1)?.role === 'tool') stream(res, 'Parent complete.');
      else held = res;
    };
    app.runner.start(parent.id, 'Accepted parent text not implicitly copied to child.', [{ name: 'parent-only', content: 'PARENT_ATTACHMENT_NOT_COPIED' }]);
    await until(() => Boolean(held));
    let replacementCalls = 0;
    const replacement = createServer((_req, res) => { replacementCalls++; stream(res, 'Wrong endpoint.'); }); extras.push(replacement);
    const replacementUrl = await listen(replacement);
    const patch = await api('/settings', { providers: [{ id: 'audit', name: 'Changed endpoint', kind: 'openai', baseUrl: replacementUrl, apiKey: 'synthetic-replacement-key' }], maxSteps: 1 }, 'PATCH');
    expect(patch.status).toBe(200);
    await writeFile(join(directory, 'AGENTS.md'), 'CHANGED_UNACCEPTED_GUIDANCE');
    await rm(join(directory, '.lite'), { recursive: true });
    expect((await api(`/sessions/${parent.id}`, { model: 'unaccepted-model', permissionMode: 'ask' }, 'PATCH')).status).toBe(409);
    stream(held!, [task('capture-policy', 'Independent researcher prompt only.')]);
    await app.runner.whenIdle();
    expect(replacementCalls).toBe(0); expect(requests).toHaveLength(3);
    const research = requests.find(isResearch)!;
    expect(research.model).toBe('audit-model');
    expect(research.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Independent researcher prompt only.']);
    const serialized = JSON.stringify(research);
    expect(serialized).toContain('ORIGINAL_ACCEPTED_GUIDANCE'); expect(serialized).toContain('ORIGINAL_PINNED_SKILL');
    expect(serialized).not.toContain('CHANGED_UNACCEPTED_GUIDANCE'); expect(serialized).not.toContain('PARENT_ATTACHMENT_NOT_COPIED');
    expect(serialized).not.toContain('synthetic-delegation-original-key'); expect(serialized).not.toContain('synthetic-replacement-key');
    expect(research.tools?.map(tool => tool.function.name).sort()).toEqual(['glob', 'grep', 'history_search', 'read_file', 'todo_read', 'tool_output_page', 'web_fetch']);
    const delegation = app.runner.delegations.list(parent.id)[0];
    expect(delegation.status).toBe('completed'); expect(store.profileSnapshot(delegation.childSessionId)).toEqual(resolved.snapshot);
  });

  it.each(['build', 'plan'] as const)('enforces the child tool ceiling under %s Auto against mutable, nested, question and MCP calls', async mode => {
    await writeFile(join(directory, 'unchanged.txt'), 'ORIGINAL_WORKSPACE_BYTES');
    const forbidden: ToolCall[] = [
      { id: 'write', name: 'write_file', args: { path: 'unchanged.txt', content: 'mutated' }, status: 'pending' },
      { id: 'edit', name: 'edit_file', args: { path: 'unchanged.txt', old_string: 'ORIGINAL', new_string: 'mutated' }, status: 'pending' },
      { id: 'shell', name: 'bash', args: { command: 'printf escaped > shell-escape.txt' }, status: 'pending' },
      { id: 'todos', name: 'todo_write', args: { todos: [{ content: 'Mutate parent', status: 'completed' }] }, status: 'pending' },
      { id: 'question', name: 'ask_user', args: { question: 'Grant mutation?' }, status: 'pending' },
      task('nested', 'Delegate forbidden nested research.'),
      { id: 'external', name: 'mcp_hallucinated_mutate', args: {}, status: 'pending' },
    ];
    const read: ToolCall = { id: 'read', name: 'read_file', args: { path: 'unchanged.txt' }, status: 'pending' };
    respond = (request, res) => {
      if (isResearch(request)) stream(res, request.messages.at(-1)?.role === 'tool' ? 'Read-only findings.' : [...forbidden, read]);
      else stream(res, request.messages.at(-1)?.role === 'tool' ? 'Parent complete.' : [task()]);
    };
    const parent = store.createSession({ permissionMode: 'auto', mode });
    store.saveTodos(parent.id, [{ id: 'parent-todo', content: 'Unchanged parent todo', status: 'pending' }]);
    app.runner.start(parent.id, 'Run isolated researcher.'); await app.runner.whenIdle();
    const [delegation] = app.runner.delegations.list(parent.id);
    expect(app.runner.delegations.list(parent.id)).toHaveLength(1); expect(delegation.status).toBe('failed');
    const calls = store.messages(delegation.childSessionId).flatMap(message => message.toolCalls ?? []);
    expect(calls.filter(call => call.id !== 'read').map(call => call.status)).toEqual(forbidden.map(() => 'denied'));
    expect(calls.find(call => call.id === 'read')).toMatchObject({ status: 'completed', output: expect.stringContaining('ORIGINAL_WORKSPACE_BYTES') });
    expect(await readFile(join(directory, 'unchanged.txt'), 'utf8')).toBe('ORIGINAL_WORKSPACE_BYTES');
    await expect(readFile(join(directory, 'shell-escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.todos(parent.id)).toEqual([{ id: 'parent-todo', content: 'Unchanged parent todo', status: 'pending' }]);
    expect(store.todos(delegation.childSessionId)).toEqual([]); expect(store.toolGrants(delegation.childSessionId)).toEqual([]);
    expect(app.runner.permissions(delegation.childSessionId)).toEqual([]); expect(app.runner.questions.pending(delegation.childSessionId)).toEqual([]);
    expect(requests).toHaveLength(4);
  });

  it('requires Plan Ask approval without widening child authority when a grant or explicit Auto authorizes launch', async () => {
    respond = (request, res) => {
      if (isResearch(request)) stream(res, 'Approved read-only report.');
      else stream(res, request.messages.at(-1)?.role === 'tool' ? 'Parent complete.' : [task()]);
    };
    const parent = store.createSession({ mode: 'plan', permissionMode: 'ask' });
    app.runner.start(parent.id, 'Approve Plan researcher once.');
    await until(() => app.runner.permissions(parent.id).length === 1);
    expect(requests).toHaveLength(1); expect(app.runner.delegations.list(parent.id)).toEqual([]);
    const pending = app.runner.permissions(parent.id)[0]; expect(pending.tool).toBe('task');
    app.runner.decide(parent.id, pending.id, 'always'); await app.runner.whenIdle();
    expect(requests).toHaveLength(3);
    app.runner.start(parent.id, 'Use explicitly remembered Plan grant.'); await app.runner.whenIdle();
    expect(requests).toHaveLength(6); expect(app.runner.permissions(parent.id)).toEqual([]);
    const auto = store.createSession({ mode: 'plan', permissionMode: 'auto' });
    app.runner.start(auto.id, 'Use explicit Plan Auto.'); await app.runner.whenIdle();
    expect(requests).toHaveLength(9); expect(app.runner.permissions(auto.id)).toEqual([]);
    for (const research of requests.filter(isResearch)) expect(research.tools?.map(tool => tool.function.name).sort()).toEqual(['glob', 'grep', 'history_search', 'read_file', 'todo_read', 'tool_output_page', 'web_fetch']);
    expect(app.runner.delegations.list(parent.id).map(delegation => delegation.status)).toEqual(['completed', 'completed']);
  });

  it('never persists oversized child output when a near-limit response is followed by a multibyte read', async () => {
    await writeFile(join(directory, 'large-read.txt'), '界'.repeat(32768));
    respond = (request, res) => {
      if (!isResearch(request)) { stream(res, request.messages.at(-1)?.role === 'tool' ? 'Parent received bounded failure.' : [task()]); return; }
      if (request.messages.at(-1)?.role === 'tool') { stream(res, 'Unexpected extra child model step.'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      emit({ content: 'x'.repeat(4 * 1024 * 1024 - 80000) });
      emit({ tool_calls: [{ index: 0, id: 'large-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'large-read.txt' }) } }] });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`); res.end('data: [DONE]\n\n');
    };
    const parent = store.createSession({ permissionMode: 'auto' }); app.runner.start(parent.id, 'Bound huge researcher transcript.'); await app.runner.whenIdle();
    const [delegation] = app.runner.delegations.list(parent.id);
    expect(Buffer.byteLength(JSON.stringify(store.messages(delegation.childSessionId)))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(delegation.status).not.toBe('running');
    expect(store.messages(parent.id).filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it('child-only cancellation settles once, aborts live provider work and holds the parent queue', async () => {
    let childResponse: ServerResponse | undefined, closed = false;
    respond = (request, res) => {
      if (isResearch(request)) { childResponse = res; res.on('close', () => { closed = true; }); }
      else stream(res, request.messages.at(-1)?.role === 'tool' ? 'Parent explains cancelled research.' : [task()]);
    };
    const parent = store.createSession({ permissionMode: 'auto' }); app.runner.start(parent.id, 'Cancel isolated research.');
    await until(() => Boolean(childResponse));
    const [delegation] = app.runner.delegations.list(parent.id);
    app.runner.enqueue(parent.id, 'Must remain queued after cancelled research.');
    const first = await api(`/sessions/${parent.id}/delegations/${delegation.id}/cancel`, {});
    const second = await api(`/sessions/${parent.id}/delegations/${delegation.id}/cancel`, {});
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    await app.runner.whenIdle(); await until(() => closed);
    expect(app.runner.delegations.get(parent.id, delegation.id).status).toBe('cancelled');
    expect(store.messages(parent.id).filter(message => message.role === 'tool')).toHaveLength(1);
    expect(store.queue(parent.id)).toMatchObject({ paused: true, items: [{ content: 'Must remain queued after cancelled research.' }] });
    expect(requests).toHaveLength(3);
    const transcript = app.runner.delegations.transcript(parent.id, delegation.id);
    childResponse!.end('data: [DONE]\n\n');
    expect(app.runner.delegations.transcript(parent.id, delegation.id)).toEqual(transcript);
  });

  const mutations: [string, string, unknown][] = [
    ['POST', '/messages', { content: 'Bypass', attachments: [{ name: 'unreadable', path: 'must-not-read', mimeType: 'text/plain' }] }],
    ['POST', '/queue', { content: 'Bypass', attachments: [{ name: 'unreadable', path: 'must-not-read', mimeType: 'text/plain' }] }],
    ['DELETE', '/queue/foreign', undefined], ['POST', '/queue/pause', {}], ['POST', '/queue/resume', {}],
    ['PATCH', '', { mode: 'build', permissionMode: 'auto', title: 'Mutable child', model: 'other' }],
    ['POST', '/profile', { expectedConfigRevision: 0, choice: { profileId: null, skillIds: [] } }],
    ['DELETE', '', undefined], ['POST', '/fork', {}], ['POST', '/compact', {}], ['POST', '/cancel', {}],
    ['POST', '/permissions/foreign', { decision: 'always' }], ['POST', '/questions/foreign/answer', { kind: 'text', text: 'Bypass' }],
    ['DELETE', '/tool-grants', undefined], ['POST', '/history/undo', { checkpointId: 'foreign' }],
    ['POST', '/history/redo', { checkpointId: 'foreign' }], ['POST', '/history/recover', {}], ['POST', '/undo', {}],
  ];
  it.each(mutations)('rejects child %s %s without changing state or reading attachments', async (method, suffix, body) => {
    const f = begin(), child = f.create(), before = rawState();
    const response = await api(`/sessions/${child.child.id}${suffix}`, body, method);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(rawState()).toEqual(before); expect(requests).toEqual([]);
  });

  it.each(['', '/events', '/profile', '/queue', '/questions', '/tool-grants', '/export', '/changes', '/history'])('hides generic child GET %s while permitting the bound read-only transcript', async suffix => {
    const f = begin(), child = f.create();
    const response = await api(`/sessions/${child.child.id}${suffix}`);
    expect(response.status).toBe(404);
    const detail = await api(`/sessions/${f.parent.id}/delegations/${child.delegation.id}`);
    expect(detail.status).toBe(200); expect(detail.body).toMatchObject({ readOnly: true, delegation: { id: child.delegation.id }, session: { id: child.child.id } });
    expect(requests).toEqual([]);
  });
});
