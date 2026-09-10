import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { EventBus } from '../server/events.js';
import { History } from '../server/history.js';
import { Questions } from '../server/questions.js';
import type { Message } from '../shared/types.js';

let directory: string, store: Store, bus: EventBus, history: History, questions: Questions;
const controllers = new Set<AbortController>();
const tracked: Promise<unknown>[] = [];
const answer = { kind: 'text', text: 'Audit answer' } as const;
function begin() {
  const session = store.createSession();
  const user: Message = { id: randomUUID(), sessionId: session.id, role: 'user', content: 'Ask before continuing', createdAt: 1 };
  history.accept(session.id, user);
  const assistant: Message = { id: randomUUID(), sessionId: session.id, role: 'assistant', content: '', createdAt: 2,
    providerMetadata: { opaque: 'unchanged' }, toolCalls: [{ id: randomUUID(), name: 'ask_user', args: { question: 'Proceed?' }, status: 'pending' }] };
  store.saveMessage(assistant);
  const controller = new AbortController(); controllers.add(controller);
  const ask = () => {
    const waiting = questions.ask(session.id, user.id, assistant.id, assistant.toolCalls![0].id, assistant.toolCalls![0].args, controller.signal);
    tracked.push(waiting.catch(() => undefined));
    return { waiting, request: questions.pending(session.id)[0] };
  };
  return { id: session.id, user, assistant, controller, ask };
}
const row = (id: string) => store.db.prepare('SELECT status,answer FROM questions WHERE id=?').get(id);
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-questions-audit-')));
  store = new Store(join(directory, 'state')); bus = new EventBus(store); history = new History(store); questions = new Questions(store, bus);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const controller of controllers) controller.abort(); controllers.clear();
  tracked.splice(0); store.close(); await rm(directory, { recursive: true, force: true });
});

describe('independent question durability audit', () => {
  it('refuses ambiguous tool IDs instead of overwriting another tool outcome during question settlement', () => {
    const f = begin(), question = f.assistant.toolCalls![0];
    f.assistant.toolCalls!.unshift({ id: question.id, name: 'todo_read', args: {}, status: 'completed', output: 'Actual todo output' });
    store.saveMessage(f.assistant);
    const before = store.messages(f.id);
    expect(() => {
      const waiting = questions.ask(f.id, f.user.id, f.assistant.id, question.id, question.args, f.controller.signal);
      tracked.push(waiting.catch(() => undefined));
    }).toThrow();
    expect(store.messages(f.id)).toEqual(before);
    expect(questions.pending(f.id)).toEqual([]);
  });
  it.each(['ask', 'answer'] as const)('rolls back real SQLite COMMIT failure during %s and allows one subsequent answer', async phase => {
    const f = begin();
    const waiting = phase === 'answer' ? f.ask() : undefined;
    const before = store.messages(f.id), eventId = store.latestEventId(f.id);
    store.db.exec(`CREATE TABLE audit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE audit_commit(parent_id INTEGER REFERENCES audit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_question_commit AFTER ${phase === 'ask' ? 'INSERT' : 'UPDATE'} ON questions
      BEGIN INSERT INTO audit_commit(parent_id) VALUES(1); END;`);
    let awakened = false;
    if (waiting) void waiting.waiting.then(() => { awakened = true; });
    expect(() => phase === 'ask' ? f.ask() : questions.answer(f.id, waiting!.request.id, answer)).toThrow(/FOREIGN KEY/);
    expect(store.messages(f.id)).toEqual(before);
    expect(store.latestEventId(f.id)).toBe(eventId);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM audit_commit').get()).toMatchObject({ count: 0 });
    if (waiting) expect(row(waiting.request.id)).toMatchObject({ status: 'pending', answer: null });
    else expect(questions.pending(f.id)).toEqual([]);
    await Promise.resolve(); expect(awakened).toBe(false);
    store.db.exec('DROP TRIGGER fail_question_commit; DROP TABLE audit_commit; DROP TABLE audit_parent;');
    const active = waiting ?? f.ask();
    questions.answer(f.id, active.request.id, answer);
    expect((await active.waiting).status).toBe('answered');
    expect(store.messages(f.id).filter(message => message.role === 'tool')).toHaveLength(1);
    expect(questions.answer(f.id, active.request.id, answer)).toMatchObject({ status: 'answered', answer });
  });

  it('keeps a committed answer durable across a crash before its process-local waiter wakes', async () => {
    const f = begin(), active = f.ask();
    const wake = vi.spyOn(questions as any, 'wake').mockImplementation(() => { throw new Error('Crash before waiter notification'); });
    expect(() => questions.answer(f.id, active.request.id, answer)).toThrow('Crash before waiter notification');
    const committed = store.messages(f.id);
    expect(row(active.request.id)).toMatchObject({ status: 'answered', answer: JSON.stringify(answer) });
    expect(committed.filter(message => message.role === 'tool')).toHaveLength(1);
    // Simulate process loss: this waiter and abort listener cannot survive restart.
    (questions as any).detach(active.request.id); controllers.delete(f.controller); wake.mockRestore();
    store.close(); store = new Store(join(directory, 'state')); bus = new EventBus(store); history = new History(store); questions = new Questions(store, bus);
    expect(store.messages(f.id)).toEqual(committed);
    expect(questions.pending(f.id)).toEqual([]);
    expect(history.state(f.id).pendingRecovery).toBeTruthy();
    const latest = store.latestEventId(f.id);
    expect(questions.answer(f.id, active.request.id, answer)).toMatchObject({ status: 'answered', answer });
    expect(store.latestEventId(f.id)).toBe(latest);
    await history.recover(f.id);
    expect(store.messages(f.id)).toEqual(committed);
    await history.undo(f.id, history.state(f.id).undoId!);
    expect(() => questions.answer(f.id, active.request.id, answer)).toThrow(/no longer pending/);
    await history.redo(f.id, history.state(f.id).redoId!);
    expect(store.messages(f.id)).toEqual(committed);
    expect(questions.pending(f.id)).toEqual([]);
    expect(questions.answer(f.id, active.request.id, answer)).toMatchObject({ status: 'answered' });
    const fork = store.fork(f.id);
    expect(questions.pending(fork.id)).toEqual([]);
    expect(() => questions.answer(fork.id, active.request.id, answer)).toThrow(/not found/);
  });

  it('settles every abort waiter even when another session cannot persist cancellation', async () => {
    const first = begin(), second = begin();
    const a = first.ask(), b = second.ask();
    // Simulate one shared shutdown signal firing every active run controller.
    store.db.exec(`CREATE TRIGGER fail_one_cancel BEFORE UPDATE ON questions
      WHEN OLD.id = '${a.request.id}' AND NEW.status = 'cancelled'
      BEGIN SELECT RAISE(ABORT, 'First cancellation failed'); END;`);
    const outcomes = Promise.allSettled([a.waiting, b.waiting]);
    first.controller.abort(); second.controller.abort();
    const settled = await outcomes;
    expect(settled[0]).toMatchObject({ status: 'rejected', reason: { message: 'First cancellation failed' } });
    expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { status: 'cancelled' } });
    expect(questions.pending(first.id)).toEqual([]); expect(questions.pending(second.id)).toEqual([]);
    expect(store.messages(first.id).filter(message => message.role === 'tool')).toHaveLength(0);
    expect(store.messages(second.id).filter(message => message.role === 'tool')).toHaveLength(1);
    expect(() => questions.answer(first.id, a.request.id, answer)).toThrow(/no longer pending/);
    store.db.exec('DROP TRIGGER fail_one_cancel');
    history.seal(first.id); history.seal(second.id);
    expect(history.state(first.id).pendingRecovery).toBeTruthy();
    expect(history.state(second.id).canUndo).toBe(true);
    await history.recover(first.id);
    expect(store.messages(first.id).some(message => message.role === 'tool')).toBe(false);
  });

  it('restarts with an unanswered question after recovery startup transaction fails and is retried', async () => {
    const f = begin(), active = f.ask();
    const before = store.messages(f.id);
    (questions as any).detach(active.request.id); controllers.delete(f.controller);
    store.db.exec(`CREATE TRIGGER fail_startup_queue BEFORE INSERT ON queues
      BEGIN SELECT RAISE(ABORT, 'Startup queue failure'); END;`);
    store.close(); store = new Store(join(directory, 'state')); bus = new EventBus(store); history = new History(store);
    expect(() => new Questions(store, bus)).toThrow('Startup queue failure');
    expect(row(active.request.id)).toMatchObject({ status: 'pending' });
    expect(store.messages(f.id)).toEqual(before);
    store.db.exec('DROP TRIGGER fail_startup_queue');
    questions = new Questions(store, bus);
    expect(row(active.request.id)).toMatchObject({ status: 'interrupted' });
    expect(questions.pending(f.id)).toEqual([]);
    expect(() => questions.answer(f.id, active.request.id, answer)).toThrow(/no longer pending/);
    await history.recover(f.id);
    expect(store.messages(f.id).some(message => message.role === 'tool')).toBe(false);
  });
});
