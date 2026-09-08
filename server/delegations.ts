import { randomUUID } from 'node:crypto';
import type { DelegationStatus, DelegationSummary } from '../shared/delegation.js';
import type { Message, Session, ToolCall } from '../shared/types.js';
import { History } from './history.js';
import type { ProfileSnapshot } from './profiles.js';
import { validateProfileSnapshot } from './profiles.js';
import { Store } from './store.js';

export const DELEGATION_LIMITS = { perTurn: 4, promptBytes: 16 * 1024, outputBytes: 32 * 1024, description: 200, transcriptBytes: 4 * 1024 * 1024 } as const;
type TerminalStatus = Exclude<DelegationStatus, 'running'>;
type Terminal = { assistant: Message; result: Message; session: Session; messages: Message[] };
type RecordData = { summary: DelegationSummary; userId: string; profileRevision: string | null; terminal?: Terminal };
type Row = { id: string; parent_session_id: string; parent_turn_id: string; parent_message_id: string; tool_call_id: string; child_session_id: string; status: DelegationStatus; data: string };
export interface CreateDelegation {
  parentSessionId: string;
  parentTurnId: string;
  parentMessageId: string;
  toolCallId: string;
  description: string;
  prompt: string;
  childSession: Pick<Session, 'workspace' | 'providerId' | 'model' | 'mode' | 'permissionMode'>;
  profile: ProfileSnapshot | null;
}
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const missing = () => Object.assign(new Error('Researcher delegation not found in the current parent transcript.'), { status: 404 });
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
const clone = <T>(value: T): T => structuredClone(value);
const statuses = new Set<DelegationStatus>(['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);
function bounded(text: string, max: number): string {
  const bytes = Buffer.from(text); if (bytes.length <= max) return text;
  let end = max; while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
const recovered = new WeakSet<Store>();
const failures: Record<TerminalStatus, string> = {
  completed: '', failed: 'Researcher failed.', cancelled: 'Researcher cancelled.',
  timed_out: 'Researcher timed out.', interrupted: 'Researcher interrupted. No provider or tool request was replayed.',
};

/** A foreground research record, not a scheduler. This service performs only
 * synchronous durable transitions; Runner owns authority, execution and cleanup. */
export class Delegations {
  constructor(readonly store: Store, readonly history: History) {
    // Construct once after History and before accepting new work. No provider,
    // tool, filesystem, or manifest call occurs during restart reconciliation.
    if (!recovered.has(store)) {
      for (const row of this.rows("WHERE status='running'")) this.recover(row);
      recovered.add(store);
    }
  }
  private transaction<T>(operation: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.store.db.exec('COMMIT'); return value; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private rows(where = '', ...params: string[]): Row[] {
    return this.store.db.prepare(`SELECT * FROM delegations ${where}`).all(...params) as unknown as Row[];
  }
  private row(id: string): Row {
    const row = this.rows('WHERE id=?', id)[0]; if (!row) throw missing(); return row;
  }
  private data(row: Row): RecordData {
    let data: RecordData;
    try { data = JSON.parse(row.data); } catch { throw conflict('The private researcher record is invalid.'); }
    const summary = data?.summary;
    if (!summary || summary.id !== row.id || summary.parentSessionId !== row.parent_session_id || summary.parentTurnId !== row.parent_turn_id || summary.parentMessageId !== row.parent_message_id || summary.toolCallId !== row.tool_call_id || summary.childSessionId !== row.child_session_id || summary.status !== row.status || !statuses.has(row.status) || typeof summary.description !== 'string' || summary.description.length > DELEGATION_LIMITS.description || typeof data.userId !== 'string') throw conflict('The private researcher binding is invalid.');
    return data;
  }
  private save(row: Row, data: RecordData): void {
    this.store.db.prepare('UPDATE delegations SET status=?,data=? WHERE id=?').run(data.summary.status, JSON.stringify(data), row.id);
  }
  isChild(id: string): boolean { return this.store.isChild(id); }
  private origin(summary: DelegationSummary, linked: boolean): { assistant: Message; call: ToolCall; results: Message[] } {
    if (this.isChild(summary.parentSessionId)) throw missing();
    const messages = this.store.messages(summary.parentSessionId);
    const userIndex = messages.findIndex(message => message.id === summary.parentTurnId && message.role === 'user');
    const assistantIndex = messages.findIndex(message => message.id === summary.parentMessageId && message.role === 'assistant');
    if (userIndex < 0 || assistantIndex <= userIndex || messages.slice(userIndex + 1, assistantIndex).some(message => message.role === 'user')) throw missing();
    const assistant = messages[assistantIndex], matches = assistant.toolCalls?.filter(call => call.id === summary.toolCallId) ?? [];
    if (matches.length !== 1 || matches[0].name !== 'task' || (linked && matches[0].delegationId !== summary.id)) throw missing();
    let end = assistantIndex + 1;
    while (end < messages.length && messages[end].role !== 'assistant' && messages[end].role !== 'user') end++;
    const results = messages.slice(assistantIndex + 1, end).filter(message => message.role === 'tool' && message.toolCallId === summary.toolCallId);
    return { assistant, call: matches[0], results };
  }
  private assertPin(row: Row, data: RecordData): void {
    const snapshot = this.store.profileSnapshot(row.child_session_id);
    if ((snapshot?.active.revision ?? null) !== data.profileRevision || snapshot?.active.profileId) throw conflict('The private researcher instruction snapshot is inconsistent.');
  }
  list(parentId: string): DelegationSummary[] {
    this.store.session(parentId);
    if (this.isChild(parentId)) return [];
    const result: DelegationSummary[] = [];
    for (const row of this.rows('WHERE parent_session_id=? ORDER BY rowid', parentId)) {
      const data = this.data(row);
      try { this.origin(data.summary, true); } catch (error) { if ((error as { status?: number }).status === 404) continue; throw error; }
      result.push(clone(data.summary));
    }
    return result;
  }
  get(parentId: string, id: string): DelegationSummary {
    const row = this.row(id); if (row.parent_session_id !== parentId) throw missing();
    const data = this.data(row); this.origin(data.summary, true); this.assertPin(row, data);
    return clone(data.summary);
  }
  transcript(parentId: string, id: string): { delegation: DelegationSummary; session: Session; messages: Message[]; readOnly: true; lastEventId: number } {
    const delegation = this.get(parentId, id), row = this.row(id), data = this.data(row);
    if (delegation.status !== 'running' && !data.terminal) throw conflict('The interrupted researcher transcript is unavailable.');
    return {
      delegation, session: clone(data.terminal?.session ?? this.store.session(row.child_session_id)),
      messages: clone(data.terminal?.messages ?? this.store.messages(row.child_session_id)),
      readOnly: true, lastEventId: this.store.latestEventId(row.child_session_id),
    };
  }
  create(input: CreateDelegation): { delegation: DelegationSummary; child: Session; user: Message } {
    const now = Date.now(), childId = randomUUID(), id = randomUUID();
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > DELEGATION_LIMITS.promptBytes || input.prompt.includes('\0')) throw invalid('Researcher prompt must be nonempty and at most 16 KiB.');
    if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > DELEGATION_LIMITS.description || /[\p{Cc}\p{Cf}]/u.test(input.description)) throw invalid('Researcher description must be a short single-line label.');
    const profile = input.profile === null ? null : validateProfileSnapshot(input.profile);
    if (profile && (profile.active.profileId !== null || profile.active.tools !== null)) throw conflict('Named project profiles cannot delegate research.');
    const user: Message = { id: randomUUID(), sessionId: childId, role: 'user', content: input.prompt, createdAt: now };
    const summary: DelegationSummary = {
      id, parentSessionId: input.parentSessionId, parentTurnId: input.parentTurnId, parentMessageId: input.parentMessageId,
      toolCallId: input.toolCallId, childSessionId: childId, description: input.description, status: 'running', createdAt: now,
    };
    let child!: Session;
    this.history.acceptPrepared(childId, user, () => {
      const parent = this.store.session(input.parentSessionId);
      if (this.isChild(parent.id) || parent.archived || parent.profile?.profileId) throw conflict('This session cannot delegate research.');
      this.history.assertAcceptedTurn(parent.id, input.parentTurnId);
      const { assistant, call, results } = this.origin(summary, false);
      if (call.delegationId || results.length || !['pending', 'running'].includes(call.status)) throw conflict('This task call was already settled or delegated.');
      if (this.rows('WHERE parent_session_id=? AND parent_turn_id=? AND parent_message_id=? AND tool_call_id=?', parent.id, input.parentTurnId, input.parentMessageId, input.toolCallId).length) throw conflict('This task call already has a durable researcher.');
      const existing = this.rows('WHERE parent_session_id=? AND parent_turn_id=?', parent.id, input.parentTurnId);
      if (existing.length >= DELEGATION_LIMITS.perTurn || this.rows("WHERE parent_session_id=? AND status='running'", parent.id).length) throw conflict('The parent researcher limit has been reached.');
      const selected = input.childSession;
      if (!selected || ['workspace', 'providerId', 'model'].some(key => typeof selected[key as keyof typeof selected] !== 'string' || !selected[key as keyof typeof selected]) || !['plan', 'build'].includes(selected.mode) || !['ask', 'auto'].includes(selected.permissionMode)) throw invalid('Researcher configuration is incomplete.');
      // Explicitly select persisted fields; never spread provider credentials or
      // runtime/system authority into the child session's durable JSON.
      child = this.store.createSession({ id: childId, title: input.description, workspace: selected.workspace, providerId: selected.providerId, model: selected.model, mode: selected.mode, permissionMode: selected.permissionMode, parentId: parent.id }, profile ? { workspace: selected.workspace, catalogRevision: profile.active.revision, snapshot: profile } : undefined);
      const data: RecordData = { summary, userId: user.id, profileRevision: profile?.active.revision ?? null };
      this.store.db.prepare('INSERT INTO delegations(id,parent_session_id,parent_turn_id,parent_message_id,tool_call_id,child_session_id,status,data) VALUES(?,?,?,?,?,?,?,?)').run(id, parent.id, input.parentTurnId, input.parentMessageId, input.toolCallId, childId, 'running', JSON.stringify(data));
      call.delegationId = id; call.status = 'running'; call.startedAt ??= now;
      this.store.saveMessage(assistant);
    });
    return { delegation: clone(summary), child, user };
  }
  settle(id: string, status: TerminalStatus, output: string): { delegation: DelegationSummary; assistant: Message; result: Message } {
    if ((status as DelegationStatus) === 'running' || !statuses.has(status) || typeof output !== 'string') throw invalid('Invalid researcher terminal result.');
    return this.transaction(() => this.settleInside(this.row(id), status, output));
  }
  private settleInside(row: Row, status: TerminalStatus, output: string) {
    const data = this.data(row), origin = this.origin(data.summary, true);
    if (data.summary.status !== 'running') {
      if (!data.terminal) throw conflict('The researcher record is interrupted and cannot be resumed.');
      if (origin.results.length !== 1 || origin.results[0].id !== data.terminal.result.id) throw conflict('The durable researcher result no longer matches the parent transcript.');
      return { delegation: clone(data.summary), assistant: clone(origin.assistant), result: clone(data.terminal.result) };
    }
    this.assertPin(row, data);
    if (origin.results.length) throw conflict('This task call already has a result.');
    const child = this.store.session(row.child_session_id), messages = this.store.messages(child.id);
    if (child.status === 'running' || child.status === 'waiting') throw conflict('Wait for researcher cleanup before settling its result.');
    if (this.store.db.prepare("SELECT 1 FROM history_checkpoints WHERE session_id=? AND status='open'").get(child.id)) throw conflict('Seal the researcher checkpoint before settling its result.');
    if (Buffer.byteLength(JSON.stringify(messages)) > DELEGATION_LIMITS.transcriptBytes) throw conflict('The researcher transcript exceeds its 4 MiB limit.');
    const prefix = failures[status];
    let content = status === 'completed' ? output : `${prefix}${output ? '\n\n' + output : ''}`;
    if (Buffer.byteLength(content) > DELEGATION_LIMITS.outputBytes) {
      const note = '\n[Researcher report truncated.]';
      content = bounded(content, DELEGATION_LIMITS.outputBytes - Buffer.byteLength(note)) + note;
    }
    const now = Date.now(), result: Message = { id: randomUUID(), sessionId: row.parent_session_id, role: 'tool', toolCallId: row.tool_call_id, content, createdAt: now };
    const call = origin.call; call.status = status === 'completed' ? 'completed' : 'error'; call.output = content; call.endedAt = now;
    data.summary = { ...data.summary, status, finishedAt: now, ...(prefix ? { error: prefix } : {}) };
    data.terminal = { assistant: clone(origin.assistant), result, session: child, messages };
    // The terminal row and exactly one parent result are one commit. Events are
    // emitted by the caller only afterwards, so failed subscribers cannot replay.
    this.store.saveMessage(origin.assistant); this.store.saveMessage(result); this.save(row, data);
    return { delegation: clone(data.summary), assistant: clone(origin.assistant), result: clone(result) };
  }
  private recover(row: Row): void {
    let data: RecordData | undefined, authorized = true;
    try { data = this.data(row); this.origin(data.summary, true); this.assertPin(row, data); }
    catch { authorized = false; }
    this.transaction(() => {
      const child = this.store.session(row.child_session_id);
      this.store.updateSession(child.id, { status: 'idle' });
      const queue = this.store.queue(child.id); this.store.saveQueue(child.id, { ...queue, paused: true, reason: 'Interrupted researcher sessions cannot be resumed.' });
      this.history.interruptChild(child.id);
      if (authorized && data) { this.settleInside(row, 'interrupted', 'The previous process ended before a durable researcher result was committed.'); return; }
      // Broken provenance is quarantined without inventing a result in another
      // assistant group and without making the hidden child independently usable.
      const fallback: RecordData = { summary: { id: row.id, parentSessionId: row.parent_session_id, parentTurnId: row.parent_turn_id, parentMessageId: row.parent_message_id, toolCallId: row.tool_call_id, childSessionId: row.child_session_id, description: 'Interrupted researcher', status: 'interrupted', createdAt: Date.now(), finishedAt: Date.now(), error: 'The private researcher origin or instruction snapshot is unavailable.' }, userId: data?.userId ?? '', profileRevision: data?.profileRevision ?? null };
      this.save(row, fallback);
    });
  }
}
