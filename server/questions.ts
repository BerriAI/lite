import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { EventBus } from './events.js';
import type { Message, ToolDefinition } from '../shared/types.js';
import type { AnswerReceipt, QuestionAnswer, QuestionRequest, QuestionResolution } from '../shared/questions.js';

const nonblank = (max: number) => z.string().min(1).max(max).refine(value => Boolean(value.trim()), 'Must not be blank');
export const questionArgsSchema = z.object({
  question: nonblank(2000),
  options: z.array(z.object({ id: nonblank(64), label: nonblank(200), description: z.string().max(500).optional() }).strict()).max(8).default([]),
}).strict().refine(value => new Set(value.options.map(option => option.id)).size === value.options.length, 'Option IDs must be unique');
const answerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('option'), optionId: nonblank(64) }).strict(),
  z.object({ kind: z.literal('text'), text: nonblank(8000).transform(text => text.trim()) }).strict(),
]);
export const questionTool: ToolDefinition = { type: 'function', function: {
  name: 'ask_user',
  description: 'Ask the user one question and wait for their answer. Offer up to eight choices; custom text is always allowed. This is not tool approval. Available in Plan and Build; never use it to request credentials or bypass denied permissions.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    question: { type: 'string', minLength: 1, maxLength: 2000 },
    options: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, label: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 500 } }, required: ['id', 'label'] } },
  }, required: ['question'] },
} };

type Status = 'pending' | QuestionResolution['status'];
type Row = { id: string; session_id: string; status: Status; request: string; answer: string | null };
export interface QuestionSettlement { status: 'answered' | 'cancelled'; assistant: Message; result: Message; }
type Waiter = { signal: AbortSignal; resolve: (value: QuestionSettlement) => void; reject: (error: unknown) => void; cleanup: () => void };
const initialized = new WeakSet<Store>();
const conflict = (message = 'This question is no longer pending in the active turn.') => Object.assign(new Error(message), { status: 409 });
const resultId = (id: string) => `question-result:${id}`;

/** Only rows created by a live accepted turn can have a resolver. History copies
 * are inert. Settlement is durable before any event or process-local wake-up. */
export class Questions {
  private waiters = new Map<string, Waiter>();
  constructor(readonly store: Store, private bus: EventBus) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL, request TEXT NOT NULL, answer TEXT);
      CREATE INDEX IF NOT EXISTS questions_session ON questions(session_id,status);`);
    if (!initialized.has(store)) {
      const interrupted = this.transaction(() => {
        const pending = store.db.prepare("SELECT id,session_id FROM questions WHERE status='pending'").all() as { id: string; session_id: string }[];
        store.db.prepare("UPDATE questions SET status='interrupted' WHERE status='pending'").run();
        for (const { session_id: sessionId } of pending) store.saveQueue(sessionId, { ...store.queue(sessionId), paused: true, reason: 'An unanswered question was interrupted. Recover history before continuing.' });
        return pending;
      });
      initialized.add(store);
      for (const { id, session_id: sessionId } of interrupted) this.emit(sessionId, 'question_resolved', { id, status: 'interrupted' } satisfies QuestionResolution);
    }
  }
  private transaction<T>(work: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.store.db.exec('COMMIT'); return value; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private row(sessionId: string, id: string): Row {
    this.store.session(sessionId);
    const row = this.store.db.prepare('SELECT * FROM questions WHERE id=? AND session_id=?').get(id, sessionId) as Row | undefined;
    if (!row) throw Object.assign(new Error('Question not found.'), { status: 404 });
    return row;
  }
  private origin(request: QuestionRequest, pending: boolean): Message {
    const messages = this.store.messages(request.sessionId);
    const turn = messages.find(message => message.id === request.turnId && message.role === 'user');
    const assistant = messages.find(message => message.id === request.messageId && message.role === 'assistant');
    const calls = assistant?.toolCalls?.filter(call => call.id === request.toolCallId);
    const checkpoint = this.store.db.prepare("SELECT status FROM history_checkpoints WHERE session_id=? AND json_extract(data,'$.userId')=?").get(request.sessionId, request.turnId) as { status: string } | undefined;
    if (!turn || !assistant || calls?.length !== 1 || calls[0].name !== 'ask_user' || !checkpoint || (pending ? checkpoint.status !== 'open' : !['open', 'applied', 'interrupted'].includes(checkpoint.status))) throw conflict();
    if (pending && !['pending', 'running'].includes(calls[0].status)) throw conflict();
    return assistant;
  }
  pending(sessionId: string): QuestionRequest[] {
    this.store.session(sessionId);
    const rows = this.store.db.prepare("SELECT * FROM questions WHERE session_id=? AND status='pending' ORDER BY rowid").all(sessionId) as unknown as Row[];
    return rows.filter(row => { const waiter = this.waiters.get(row.id); return waiter && !waiter.signal.aborted; }).map(row => JSON.parse(row.request));
  }
  private emit(sessionId: string, type: 'question' | 'question_resolved' | 'message', data: unknown): void {
    try { this.bus.emit(sessionId, type, data); }
    catch { console.error('Could not publish question progress. Refresh the session to inspect durable state.'); }
  }
  ask(sessionId: string, turnId: string, messageId: string, toolCallId: string, args: unknown, signal: AbortSignal): Promise<QuestionSettlement> {
    const input = questionArgsSchema.parse(args);
    signal.throwIfAborted();
    const request: QuestionRequest = { id: randomUUID(), sessionId, turnId, messageId, toolCallId, ...input, createdAt: Date.now() };
    const assistant = this.transaction(() => {
      const assistant = this.origin(request, true), call = assistant.toolCalls!.find(call => call.id === toolCallId)!;
      if (this.pending(sessionId).length) throw conflict('The previous question must finish first.');
      // A failed cancellation write may leave an orphan row until storage recovers.
      // It has no resolver and must never block a later explicitly accepted turn.
      this.store.db.prepare("UPDATE questions SET status='interrupted' WHERE session_id=? AND status='pending'").run(sessionId);
      call.status = 'running'; call.startedAt = Date.now();
      this.store.saveMessage(assistant);
      this.store.db.prepare("INSERT INTO questions(id,session_id,status,request) VALUES(?,?,'pending',?)").run(request.id, sessionId, JSON.stringify(request));
      return assistant;
    });
    const promise = new Promise<QuestionSettlement>((resolve, reject) => {
      const abort = () => {
        try { this.cancel(sessionId, request.id); }
        catch (error) { this.detach(request.id)?.reject(error); }
      };
      this.waiters.set(request.id, { signal, resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) });
      signal.addEventListener('abort', abort, { once: true });
    });
    this.emit(sessionId, 'message', assistant);
    this.emit(sessionId, 'question', request);
    return promise;
  }
  private detach(id: string): Waiter | undefined {
    const waiter = this.waiters.get(id); this.waiters.delete(id); waiter?.cleanup(); return waiter;
  }
  private settle(row: Row, status: 'answered' | 'cancelled', answer?: QuestionAnswer): QuestionSettlement {
    const request: QuestionRequest = JSON.parse(row.request);
    return this.transaction(() => {
      const current = this.row(row.session_id, row.id);
      if (current.status !== 'pending') throw conflict();
      const assistant = this.origin(request, true), call = assistant.toolCalls!.find(call => call.id === request.toolCallId)!;
      const content = JSON.stringify({ questionId: row.id, status, ...(answer ? { answer } : {}) });
      const result: Message = { id: resultId(row.id), sessionId: row.session_id, role: 'tool', toolCallId: request.toolCallId, content, createdAt: Date.now() };
      if (this.store.db.prepare('SELECT id FROM messages WHERE id=?').get(result.id)) throw conflict('The question result already exists.');
      const claim = this.store.db.prepare("UPDATE questions SET status=?,answer=? WHERE id=? AND status='pending'").run(status, answer ? JSON.stringify(answer) : null, row.id);
      if (Number(claim.changes) !== 1) throw conflict();
      call.status = status === 'answered' ? 'completed' : 'denied'; call.output = content; call.endedAt = result.createdAt;
      this.store.saveMessage(assistant); this.store.saveMessage(result);
      return { status, assistant, result };
    });
  }
  private wake(row: Row, settlement: QuestionSettlement): void {
    const waiter = this.detach(row.id);
    this.emit(row.session_id, 'message', settlement.assistant); this.emit(row.session_id, 'message', settlement.result);
    this.emit(row.session_id, 'question_resolved', { id: row.id, status: settlement.status } satisfies QuestionResolution);
    waiter?.resolve(settlement);
  }
  answer(sessionId: string, id: string, value: unknown): AnswerReceipt {
    const row = this.row(sessionId, id), request: QuestionRequest = JSON.parse(row.request);
    const answer: QuestionAnswer = answerSchema.parse(value);
    if (answer.kind === 'option' && !request.options.some(option => option.id === answer.optionId)) throw Object.assign(new Error('Choose one of the offered options or send custom text.'), { status: 400 });
    if (row.status === 'answered') {
      this.origin(request, false);
      if (row.answer !== JSON.stringify(answer) || !this.store.messages(sessionId).some(message => message.id === resultId(id) && message.content === JSON.stringify({ questionId: id, status: 'answered', answer }))) throw conflict('This question already has a different answer or belongs to stale history.');
      return { id, status: 'answered', answer };
    }
    const waiter = this.waiters.get(id);
    if (row.status !== 'pending' || !waiter || waiter.signal.aborted) throw conflict();
    const settlement = this.settle(row, 'answered', answer);
    this.wake(row, settlement);
    return { id, status: 'answered', answer };
  }
  private cancel(sessionId: string, id: string): void {
    const row = this.row(sessionId, id);
    if (row.status !== 'pending') return;
    this.wake(row, this.settle(row, 'cancelled'));
  }
}
