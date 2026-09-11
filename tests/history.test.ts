import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { History, HISTORY_LIMITS } from '../server/history.js';
import { executeTool } from '../server/tools.js';
import type { FileChange, Message } from '../shared/types.js';

let directory: string, workspace: string, store: Store, history: History, id: string;
const user = (content = 'Task'): Message => ({ id: randomUUID(), sessionId: id, role: 'user', content, attachments: [], createdAt: Date.now() });
const answer = (content = 'Done'): Message => ({ id: randomUUID(), sessionId: id, role: 'assistant', content, createdAt: Date.now() });
const current = () => history.state(id);
async function edit(path: string, content: string) {
  return executeTool('write_file', { path, content }, {
    workspace, sessionId: id, signal: new AbortController().signal,
    prepareChange: change => history.prepareChange(id, change), onChange: change => history.commitChange(id, change),
    getTodos: () => store.todos(id), onTodos: todos => { store.saveTodos(id, todos); },
  });
}
async function turn(content: string, file?: string) { history.accept(id, user(content)); if (file !== undefined) await edit('file.txt', file); store.saveMessage(answer(content)); history.seal(id); }
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-history-')));
  workspace = join(directory, 'workspace'); await mkdir(workspace);
  store = new Store(join(directory, 'data'));
  store.saveSettings({ workspace });
  id = store.createSession().id;
  history = new History(store);
});
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(directory, { recursive: true, force: true }); });

describe('turn checkpoint history', () => {
  it('round-trips multiple turns, exact file bytes, todos, metadata and aggregate changes', async () => {
    await writeFile(join(workspace, 'file.txt'), 'original\r\n');
    history.accept(id, user('First'));
    await edit('file.txt', 'first\n');
    store.saveTodos(id, [{ id: 't', content: 'Test', status: 'pending' }]);
    store.saveMessage({ ...answer(), providerMetadata: { signature: 'opaque' }, reasoning: 'reasoning' });
    history.seal(id);
    const firstMessages = store.messages(id), firstChanges = store.changes(id), firstTodos = store.todos(id);
    await turn('Second', 'second\n');
    const secondMessages = store.messages(id);
    const secondId = current().undoId!;
    expect(current().canUndo).toBe(true);
    await history.undo(id, secondId);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('first\r\n');
    expect(store.messages(id)).toEqual(firstMessages);
    expect(store.changes(id)).toEqual(firstChanges);
    expect(store.todos(id)).toEqual(firstTodos);
    await history.undo(id, current().undoId!);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('original\r\n');
    expect(store.messages(id)).toEqual([]);
    await history.redo(id, current().redoId!);
    expect(store.messages(id)).toEqual(firstMessages);
    await history.redo(id, current().redoId!);
    expect(store.messages(id)).toEqual(secondMessages);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('second\r\n');
    expect(store.queue(id).paused).toBe(true);
  });
  it('restores full compaction-safe snapshots and intact tool groups without executing tools', async () => {
    await turn('Previous');
    const before = store.messages(id);
    history.accept(id, user('Work'));
    const callId = 'call-original';
    const call = { id: callId, name: 'bash', args: { command: 'irreversible' }, status: 'completed' as const };
    const assistant = { ...answer(''), toolCalls: [call], providerMetadata: { signed: 'preserve' } };
    const result: Message = { id: randomUUID(), sessionId: id, role: 'tool', content: 'shell output', toolCallId: callId, createdAt: Date.now() };
    history.compact(id, [{ ...answer('summary'), role: 'system' }, user('Work'), assistant, result, answer()]);
    history.seal(id);
    const after = store.messages(id);
    await history.undo(id, current().undoId!);
    expect(store.messages(id)).toEqual(before);
    await history.redo(id, current().redoId!);
    expect(store.messages(id)).toEqual(after);
    expect(store.messages(id).find(message => message.toolCalls)?.toolCalls?.[0].id).toBe(callId);
  });
  it('preserves the entire two-turn undo/redo chain after manual compaction', async () => {
    await writeFile(join(workspace, 'file.txt'), 'original\r\n');
    const snapshot = async () => ({ messages: store.messages(id), todos: store.todos(id), changes: store.changes(id), file: await readFile(join(workspace, 'file.txt'), 'utf8') });
    const before = await snapshot();
    expect(current().hasCheckpoints).toBe(false);
    history.accept(id, user('First'));
    await edit('file.txt', 'first\n');
    store.saveTodos(id, [{ id: 'todo', content: 'Keep exact todos', status: 'pending' }]);
    store.saveMessage({ ...answer('First'), providerMetadata: { signed: 'opaque-first' } });
    history.seal(id);
    const first = await snapshot();
    history.accept(id, user('Second'));
    await edit('file.txt', 'second\n');
    store.saveTodos(id, [{ id: 'todo', content: 'Keep exact todos', status: 'completed' }]);
    store.saveMessage(answer('Second')); history.seal(id);
    history.compact(id, [{ ...answer('manual summary'), role: 'system' }]);
    const compacted = await snapshot();
    await history.undo(id, current().undoId!);
    expect(await snapshot()).toEqual(first);
    await history.undo(id, current().undoId!);
    expect(await snapshot()).toEqual(before);
    expect(current()).toMatchObject({ hasCheckpoints: true, canUndo: false, canRedo: true });
    await history.redo(id, current().redoId!);
    expect(await snapshot()).toEqual(first);
    await history.redo(id, current().redoId!);
    expect(await snapshot()).toEqual(compacted);
  });
  it('rolls back archive, messages and checkpoint together when manual compaction persistence fails', async () => {
    await turn('First', 'first');
    const first = store.messages(id);
    await turn('Second', 'second');
    const before = { messages: store.messages(id), todos: store.todos(id), changes: store.changes(id), archives: store.sessions('', true), state: current() };
    const checkpoint = store.db.prepare('SELECT data FROM history_checkpoints WHERE id=?').get(current().undoId!) as { data: string };
    store.db.exec(`CREATE TRIGGER reject_compaction_checkpoint BEFORE UPDATE OF data ON history_checkpoints
      WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'Simulated SQLite compaction failure'); END;`);
    expect(() => history.compact(id, [{ ...answer('summary that must not commit'), role: 'system' }])).toThrow(/SQLite compaction failure/);
    expect({ messages: store.messages(id), todos: store.todos(id), changes: store.changes(id), archives: store.sessions('', true), state: current() }).toEqual(before);
    expect(store.db.prepare('SELECT data FROM history_checkpoints WHERE id=?').get(current().undoId!)).toEqual(checkpoint);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('second');
    store.db.exec('DROP TRIGGER reject_compaction_checkpoint');
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect({ messages: store.messages(id), todos: store.todos(id), changes: store.changes(id), archives: store.sessions('', true), state: current() }).toEqual(before);
    await history.undo(id, current().undoId!);
    expect(store.messages(id)).toEqual(first);
    await history.redo(id, current().redoId!);
    const archive = history.compact(id, [{ ...answer('valid summary'), role: 'system' }]);
    expect(store.sessions('', true).map(session => session.id)).toEqual([archive.id]);
    expect(store.messages(archive.id).map(message => message.content)).toEqual(before.messages.map(message => message.content));
    const compacted = store.messages(id);
    await history.undo(id, current().undoId!);
    expect(store.messages(id)).toEqual(first);
    await history.redo(id, current().redoId!);
    expect(store.messages(id)).toEqual(compacted);
  });
  it('rejects invalid compaction and rolls back failed message replacement without an archive', async () => {
    await turn('First');
    const before = store.messages(id);
    const orphan = { ...answer(), toolCalls: [{ id: 'orphan', name: 'bash', args: {}, status: 'running' as const }] };
    expect(() => history.compact(id, [orphan])).toThrow(/incomplete tool group/);
    expect(() => history.compact(id, [{ ...answer(), sessionId: 'different-session' }])).toThrow(/mismatched messages/);
    const summary = { ...answer('summary'), role: 'system' as const };
    store.db.exec(`CREATE TRIGGER reject_summary BEFORE INSERT ON messages
      WHEN json_extract(NEW.data, '$.content') = 'summary'
      BEGIN SELECT RAISE(ABORT, 'Simulated summary write failure'); END;`);
    expect(() => history.compact(id, [summary])).toThrow(/summary write failure/);
    expect(store.messages(id)).toEqual(before);
    expect(store.sessions('', true)).toEqual([]);
    expect(current().canUndo).toBe(true);
    store.db.exec('DROP TRIGGER reject_summary');
    await history.undo(id, current().undoId!);
    expect(() => history.compact(id, [summary])).toThrow(/Redo history/);
    expect(store.messages(id)).toEqual([]);
    expect(store.sessions('', true)).toEqual([]);
  });
  it('offers retryable recovery when SQLite fails sealing a no-longer-live turn', async () => {
    history.accept(id, user());
    expect(current().pendingRecovery).toBeUndefined();
    await expect(history.recover(id)).rejects.toThrow(/Wait for the accepted turn/);
    await edit('file.txt', 'written'); store.saveMessage(answer());
    const messages = store.messages(id);
    store.db.exec(`CREATE TRIGGER reject_history_seal BEFORE UPDATE OF status ON history_checkpoints
      WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'Simulated SQLite seal failure'); END;`);
    expect(() => history.seal(id)).toThrow(/SQLite seal failure/);
    expect(current()).toMatchObject({ hasCheckpoints: true, canUndo: false, canRedo: false, pendingRecovery: { paths: [] } });
    expect(() => history.accept(id, user('Must recover first'))).toThrow(/recovery/);
    await expect(history.recover(id)).rejects.toThrow(/SQLite seal failure/);
    expect(current().pendingRecovery).toBeTruthy();
    expect(store.messages(id)).toEqual(messages);
    store.db.exec('DROP TRIGGER reject_history_seal');
    await history.recover(id);
    expect(current()).toMatchObject({ canUndo: true, canRedo: false });
    expect(current().pendingRecovery).toBeUndefined();
    expect(store.messages(id)).toEqual(messages);
    await history.undo(id, current().undoId!);
    expect(store.messages(id)).toEqual([]);
    await expect(readFile(join(workspace, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await history.redo(id, current().redoId!);
    expect(store.messages(id)).toEqual(messages);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('written');
  });
  it('archives incomplete crash history and repairs its boundary only during explicit recovery', async () => {
    history.accept(id, user());
    store.saveMessage({ ...answer('started'), toolCalls: [{ id: 'unresolved', name: 'bash', args: { command: 'unknown outcome' }, status: 'running' }] });
    const original = store.messages(id);
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect(store.messages(id)).toEqual(original);
    expect(current().pendingRecovery).toBeTruthy();
    await history.recover(id);
    const recovered = store.messages(id);
    expect(recovered.map(message => message.role)).toEqual(['user', 'system']);
    expect(recovered.at(-1)?.content).toContain('No tool success was inferred');
    expect(current().canUndo).toBe(true);
    const archive = store.sessions('', true)[0];
    expect(store.messages(archive.id).map(message => message.content)).toEqual(original.map(message => message.content));
    await history.undo(id, current().undoId!);
    await history.redo(id, current().redoId!);
    expect(store.messages(id)).toEqual(recovered);
  });
  it('clears redo only on atomically accepted turns, including queue acceptance', async () => {
    await turn('First'); await history.undo(id, current().undoId!);
    const redoId = current().redoId;
    expect(() => history.accept(id, { ...user(), role: 'assistant' })).toThrow();
    expect(current().redoId).toBe(redoId);
    store.enqueue(id, 'Queued', [], false);
    expect(current().redoId).toBe(redoId);
    const queue = store.queue(id), message = user('Queued');
    expect(() => history.accept(id, message, queue.items[0].id)).toThrow(/Queue/);
    expect(current().redoId).toBe(redoId);
    store.saveQueue(id, { ...queue, paused: false });
    history.accept(id, message, queue.items[0].id);
    expect(store.queue(id).items).toHaveLength(0);
    expect(store.messages(id)).toEqual([message]);
    expect(current().redoId).toBeUndefined();
    history.seal(id);
  });
  it('rejects stale IDs, snapshot drift, and compaction while redo remains', async () => {
    await turn('First');
    await expect(history.undo(id, 'stale')).rejects.toMatchObject({ status: 409 });
    await history.undo(id, current().undoId!);
    expect(() => history.assertCanCompact(id)).toThrow(/Redo/);
    store.saveTodos(id, [{ id: 'external', content: 'changed', status: 'pending' }]);
    await expect(history.redo(id, current().redoId!)).rejects.toMatchObject({ status: 409 });
  });
  it('preflights all paths before changing files or transcript and rejects symlink aliases', async () => {
    history.accept(id, user()); await edit('first', 'one'); await edit('second', 'two'); store.saveMessage(answer()); history.seal(id);
    const messages = store.messages(id);
    await writeFile(join(workspace, 'second'), 'external');
    await expect(history.undo(id, current().undoId!)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(workspace, 'first'), 'utf8')).toBe('one');
    expect(store.messages(id)).toEqual(messages);
    expect(current().pendingRecovery).toBeUndefined();
    await rm(join(workspace, 'second'));
    await symlink(join(workspace, 'first'), join(workspace, 'second'));
    await expect(history.undo(id, current().undoId!)).rejects.toThrow(/Symlink/);
  });
  it('retains partial undo progress and recovers without overwriting an external change', async () => {
    history.accept(id, user()); await edit('first', 'one'); await edit('second', 'two'); store.saveMessage(answer()); history.seal(id);
    const messages = store.messages(id);
    const save = (history as any).saveOperation.bind(history);
    vi.spyOn(history as any, 'saveOperation').mockImplementation((...args: any[]) => {
      save(...args);
      if (args[1].completed.includes('first')) throw new Error('Simulated interruption after first progress');
    });
    await expect(history.undo(id, current().undoId!)).rejects.toThrow(/Simulated/);
    expect(current().pendingRecovery?.paths).toEqual(['first', 'second']);
    expect(() => history.assertReady(id)).toThrow(/interrupted/);
    expect(store.messages(id)).toEqual(messages);
    await expect(readFile(join(workspace, 'first'))).rejects.toThrow();
    vi.restoreAllMocks();
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    await writeFile(join(workspace, 'second'), 'external');
    await expect(history.recover(id)).rejects.toMatchObject({ status: 409 });
    await writeFile(join(workspace, 'second'), 'two');
    await history.recover(id);
    expect(store.messages(id)).toEqual([]);
    expect(current().canRedo).toBe(true);
  });
  it('reconciles a mutation completed before its durable progress callback', async () => {
    await turn('First', 'new');
    const save = (history as any).saveOperation.bind(history);
    let calls = 0;
    vi.spyOn(history as any, 'saveOperation').mockImplementation((...args: any[]) => { if (++calls === 3) throw new Error('Crash before progress persisted'); save(...args); });
    await expect(history.undo(id, current().undoId!)).rejects.toThrow(/Crash/);
    vi.restoreAllMocks();
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect(current().pendingRecovery).toBeTruthy();
    await history.recover(id);
    expect(current().canRedo).toBe(true);
    expect(store.messages(id)).toEqual([]);
  });
  it.each(['undo', 'redo'] as const)('recovers %s after SQLite rejects the first file progress update', async direction => {
    await writeFile(join(workspace, 'first'), 'before-first');
    await writeFile(join(workspace, 'second'), 'before-second');
    history.accept(id, user()); await edit('first', 'after-first'); await edit('second', 'after-second'); store.saveMessage(answer()); history.seal(id);
    const applied = { messages: store.messages(id), changes: store.changes(id) };
    if (direction === 'redo') await history.undo(id, current().undoId!);
    const sourceMessages = store.messages(id);
    store.db.exec(`CREATE TRIGGER reject_history_progress BEFORE UPDATE OF data ON history_operations
      WHEN json_array_length(json_extract(NEW.data, '$.completed')) > 0
      BEGIN SELECT RAISE(ABORT, 'Simulated SQLite progress failure'); END;`);
    const checkpointId = direction === 'undo' ? current().undoId! : current().redoId!;
    await expect(history[direction](id, checkpointId)).rejects.toThrow(/SQLite progress failure/);
    expect(store.messages(id)).toEqual(sourceMessages);
    expect(await readFile(join(workspace, 'first'), 'utf8')).toBe(direction === 'undo' ? 'before-first' : 'after-first');
    expect(await readFile(join(workspace, 'second'), 'utf8')).toBe(direction === 'undo' ? 'after-second' : 'before-second');
    const pending = store.db.prepare('SELECT data FROM history_operations WHERE session_id=?').get(id) as { data: string };
    expect(JSON.parse(pending.data).completed).toEqual([]);
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect(current().pendingRecovery?.paths).toEqual(['first', 'second']);
    store.db.exec('DROP TRIGGER reject_history_progress');
    await history.recover(id);
    expect(current().pendingRecovery).toBeUndefined();
    expect(store.messages(id)).toEqual(direction === 'undo' ? [] : applied.messages);
    expect(store.changes(id)).toEqual(direction === 'undo' ? [] : applied.changes);
    expect(await readFile(join(workspace, 'first'), 'utf8')).toBe(direction === 'undo' ? 'before-first' : 'after-first');
    expect(await readFile(join(workspace, 'second'), 'utf8')).toBe(direction === 'undo' ? 'before-second' : 'after-second');
  });
  it.each([null, 'unchanged'] as const)('discards an unstarted original file intent after cancellation and restart (%s)', async before => {
    if (before !== null) await writeFile(join(workspace, 'file.txt'), before);
    history.accept(id, user());
    const controller = new AbortController();
    await expect(executeTool('write_file', { path: 'file.txt', content: 'never written' }, {
      workspace, sessionId: id, signal: controller.signal,
      prepareChange: change => { history.prepareChange(id, change); controller.abort(); },
      onChange: change => history.commitChange(id, change), getTodos: () => [], onTodos: () => {},
    })).rejects.toThrow();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM history_intents WHERE session_id=?').get(id)).toMatchObject({ count: 1 });
    history.seal(id);
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect(current().pendingRecovery?.paths).toEqual(['file.txt']);
    await history.recover(id);
    expect(current().pendingRecovery).toBeUndefined();
    expect(store.changes(id)).toEqual([]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM history_intents WHERE session_id=?').get(id)).toMatchObject({ count: 0 });
    await history.undo(id, current().undoId!);
    if (before === null) await expect(readFile(join(workspace, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe(before);
  });
  it('keeps the original intent when post-intent validation detects an external edit', async () => {
    await writeFile(join(workspace, 'file.txt'), 'source');
    history.accept(id, user());
    await expect(executeTool('write_file', { path: 'file.txt', content: 'intended' }, {
      workspace, sessionId: id, signal: new AbortController().signal,
      prepareChange: async change => { history.prepareChange(id, change); await writeFile(join(workspace, 'file.txt'), 'external'); },
      onChange: change => history.commitChange(id, change), getTodos: () => [], onTodos: () => {},
    })).rejects.toThrow(/File changed while preparing/);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('external');
    history.seal(id);
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    await expect(history.recover(id)).rejects.toMatchObject({ status: 409 });
    expect(current().pendingRecovery?.paths).toEqual(['file.txt']);
    expect(store.changes(id)).toEqual([]);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('external');
    await writeFile(join(workspace, 'file.txt'), 'source');
    await history.recover(id);
    expect(current().pendingRecovery).toBeUndefined();
    expect(store.changes(id)).toEqual([]);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('source');
  });
  it('preserves external bytes between turns and stops older undo at the conflict', async () => {
    await writeFile(join(workspace, 'file.txt'), 'original');
    await turn('First', 'first');
    const first = { messages: store.messages(id), changes: store.changes(id) };
    await writeFile(join(workspace, 'file.txt'), 'external');
    await turn('Second', 'second');
    const second = { messages: store.messages(id), changes: store.changes(id) };
    await history.undo(id, current().undoId!);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('external');
    expect({ messages: store.messages(id), changes: store.changes(id) }).toEqual(first);
    await expect(history.undo(id, current().undoId!)).rejects.toThrow(/outside this turn/);
    expect(current().pendingRecovery).toBeUndefined();
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('external');
    expect({ messages: store.messages(id), changes: store.changes(id) }).toEqual(first);
    await history.redo(id, current().redoId!);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('second');
    expect({ messages: store.messages(id), changes: store.changes(id) }).toEqual(second);
  });
  it('holds unsealed turns after restart and recovers file intents by source/target comparison', async () => {
    history.accept(id, user());
    const change: FileChange = { path: 'file.txt', before: null, after: 'written' };
    history.prepareChange(id, change);
    expect(() => new History(store).assertReady(id)).not.toThrow();
    await writeFile(join(workspace, 'file.txt'), 'written');
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect(current().pendingRecovery?.paths).toContain('file.txt');
    expect(() => history.accept(id, user('new'))).toThrow(/recovery/);
    await history.recover(id);
    expect(store.changes(id)).toEqual([change]);
    expect(current().canUndo).toBe(true);
    await history.undo(id, current().undoId!);
    await expect(readFile(join(workspace, 'file.txt'))).rejects.toThrow();
  });
  it('does not claim torn writes were completed and rolls back unapplied intents on recovery', async () => {
    history.accept(id, user());
    history.prepareChange(id, { path: 'file.txt', before: null, after: 'complete' });
    await writeFile(join(workspace, 'file.txt'), 'partial');
    history.seal(id);
    await expect(history.recover(id)).rejects.toMatchObject({ status: 409 });
    await rm(join(workspace, 'file.txt'));
    await history.recover(id);
    expect(store.changes(id)).toEqual([]);
    expect(current().pendingRecovery).toBeUndefined();
  });
  it('preserves legacy change baseline, grants, and grants no history to forks', async () => {
    store.recordChange(id, { path: 'legacy', before: 'old', after: 'new' });
    store.grantTool(id, 'bash', 'scope');
    await turn('New');
    const fork = store.fork(id);
    expect(history.hasCheckpoints(fork.id)).toBe(false);
    await history.undo(id, current().undoId!);
    expect(store.changes(id)).toEqual([{ path: 'legacy', before: 'old', after: 'new' }]);
    expect(store.toolGrants(id)).toEqual([{ tool: 'bash', scope: 'scope' }]);
  });
  it('bounds depth and reports incomplete tool history as unavailable', async () => {
    for (let count = 0; count < HISTORY_LIMITS.depth + 2; count++) await turn(String(count));
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM history_checkpoints WHERE session_id=?').get(id) as { count: number }).count).toBe(HISTORY_LIMITS.depth);
    history.accept(id, user());
    store.saveMessage({ ...answer(), toolCalls: [{ id: 'unresolved', name: 'bash', args: {}, status: 'running' }] });
    history.seal(id);
    expect(current().canUndo).toBe(false);
    expect(current().pendingRecovery).toBeTruthy();
    expect(() => history.assertReady(id)).toThrow();
    await history.recover(id);
    expect(current().canUndo).toBe(true);
  });
  it('reports a retention floor and bounds oversized checkpoint data', async () => {
    for (let count = 0; count < HISTORY_LIMITS.depth + 1; count++) await turn(String(count));
    for (let count = 0; count < HISTORY_LIMITS.depth; count++) await history.undo(id, current().undoId!);
    expect(current().canUndo).toBe(false);
    expect(current().unavailableReason).toContain('pruned');
    const large = 'x'.repeat(HISTORY_LIMITS.bytes / 2 + 100);
    store.saveMessage(answer(large));
    history.accept(id, user('oversized history'));
    store.saveMessage(answer()); history.seal(id);
    expect(current().canUndo).toBe(false);
    expect(current().unavailableReason).toContain('budget');
    const bytes = store.db.prepare('SELECT SUM(length(data)) AS bytes FROM history_checkpoints WHERE session_id=?').get(id) as { bytes: number };
    expect(bytes.bytes).toBeLessThanOrEqual(HISTORY_LIMITS.bytes);
  });
  it('repairs incomplete imported history without creating file ownership checkpoints', async () => {
    store.saveMessage({ ...answer(), toolCalls: [{ id: 'orphan', name: 'bash', args: {}, status: 'running' }] });
    expect(current().pendingRecovery).toBeTruthy();
    await history.recover(id);
    expect(current().pendingRecovery).toBeUndefined();
    expect(history.hasCheckpoints(id)).toBe(false);
    expect(store.messages(id)[0].role).toBe('system');
  });
  it('persists an intent before the file tool writes, and refuses ambiguous repeated writes', async () => {
    history.accept(id, user());
    await edit('file.txt', 'first');
    await writeFile(join(workspace, 'file.txt'), 'external');
    await expect(edit('file.txt', 'second')).rejects.toThrow(/outside the recorded/);
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('external');
  });
});
