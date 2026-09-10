import { snapshotWorkspace, snapshotChanges, type WorkspaceSnapshot } from './workspace-snapshot.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Store } from './store.js';
import { completeToolBoundary } from './context.js';
import { readRestoreTarget, restoreChanges } from './tools.js';
import type { FileChange, Message, Session, Todo } from '../shared/types.js';
import type { HistoryState } from '../shared/history.js';

export const HISTORY_LIMITS = { depth: 20, bytes: 32 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 } as const;
type Snapshot = { messages: Message[]; todos: Todo[]; changes: FileChange[] };
type Checkpoint = { id: string; userId: string; workspace?: string; before: Snapshot | null; after: Snapshot | null; changes: FileChange[]; unavailableReason?: string; floorReason?: string; effectsNotice?: string };
type Row = { id: string; sequence: number; status: 'open' | 'applied' | 'undone' | 'interrupted'; data: string };
type Operation = { checkpointId: string; direction: 'undo' | 'redo'; plan: FileChange[]; completed: string[] };
const initialized = new WeakSet<Store>();
const liveTurns = new WeakMap<Store, Set<string>>();
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Caller holds runner.exclusive for undo/redo/recover. No filesystem work occurs
 * in construction; recovery is explicit and never replays provider or shell calls. */
export class History {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS history_checkpoints (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_session ON history_checkpoints(session_id,sequence);
      CREATE TABLE IF NOT EXISTS history_intents (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      path TEXT NOT NULL, checkpoint_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(session_id,path));
      CREATE TABLE IF NOT EXISTS history_operations (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS command_snapshots (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, checkpoint_id TEXT NOT NULL, workspace TEXT NOT NULL, data TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS steering_notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, turn_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);');
    if (!initialized.has(store)) {
      store.db.prepare("UPDATE history_checkpoints SET status='interrupted' WHERE status='open'").run();
      initialized.add(store);
      liveTurns.set(store, new Set());
    }
  }
  private transaction<T>(fn: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private rows(id: string): Row[] {
    this.store.session(id);
    return this.store.db.prepare('SELECT id,sequence,status,data FROM history_checkpoints WHERE session_id=? ORDER BY sequence').all(id) as unknown as Row[];
  }
  private read(row: Row): Checkpoint { return JSON.parse(row.data); }
  private save(row: Row, checkpoint: Checkpoint, status = row.status): void {
    this.store.db.prepare('UPDATE history_checkpoints SET status=?,data=? WHERE id=?').run(status, JSON.stringify(checkpoint), row.id);
  }
  private snapshot(id: string): Snapshot { return clone({ messages: this.store.messages(id), todos: this.store.todos(id), changes: this.store.changes(id) }); }
  private intents(id: string): { path: string; checkpoint_id: string; data: string }[] {
    return this.store.db.prepare('SELECT path,checkpoint_id,data FROM history_intents WHERE session_id=? ORDER BY rowid').all(id) as unknown as { path: string; checkpoint_id: string; data: string }[];
  }
  private operation(id: string): Operation | undefined {
    const row = this.store.db.prepare('SELECT data FROM history_operations WHERE session_id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  private saveOperation(id: string, operation: Operation): void {
    this.store.db.prepare('INSERT INTO history_operations(session_id,data) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(operation));
  }
  private pause(id: string): void { this.store.saveQueue(id, { ...this.store.queue(id), paused: true, reason: 'History changed or needs recovery. Review before explicitly resuming queued messages.' }); }
  hasCheckpoints(id: string): boolean { return this.rows(id).length > 0; }
  state(id: string): HistoryState {
    const rows = this.rows(id), operation = this.operation(id), intents = this.intents(id);
    const live = liveTurns.get(this.store)?.has(id) ?? false;
    const interrupted = rows.some(row => row.status === 'interrupted' || (row.status === 'open' && !live));
    const messages = this.store.messages(id);
    const incomplete = !live && completeToolBoundary(messages) !== messages.length;
    const commands=this.store.db.prepare('SELECT 1 FROM command_snapshots WHERE session_id=? LIMIT 1').get(id);
    const pendingRecovery = operation || (commands&&!live) || (intents.length && !live) || interrupted || incomplete ? {
      reason: operation ? `Finish interrupted ${operation.direction} before continuing.` : 'An interrupted file edit or accepted turn needs recovery before continuing.',
      paths: [...new Set([...(operation?.plan.map(change => change.path) ?? []), ...intents.map(intent => intent.path)])],
    } : undefined;
    const undo = rows.findLast(row => row.status === 'applied');
    const redo = rows.find(row => row.status === 'undone');
    const open = rows.some(row => row.status === 'open');
    const reason = (undo && this.read(undo).unavailableReason) || (redo && this.read(redo).unavailableReason) || (!undo && rows[0] && this.read(rows[0]).floorReason);
    return {
      hasCheckpoints: rows.length > 0,
      canUndo: !!undo && !pendingRecovery && !open && !this.read(undo).unavailableReason,
      canRedo: !!redo && !pendingRecovery && !open && !this.read(redo).unavailableReason,
      ...(undo ? { undoId: undo.id } : {}), ...(redo ? { redoId: redo.id } : {}),
      ...((undo||redo)&&this.read((undo??redo)!).effectsNotice?{effectsNotice:this.read((undo??redo)!).effectsNotice}:{}),
      ...(reason ? { unavailableReason: reason } : {}), ...(pendingRecovery ? { pendingRecovery } : {}),
    };
  }
  assertReady(id: string): void { const state = this.state(id); if (state.pendingRecovery) throw conflict(state.pendingRecovery.reason); }
  assertCanCompact(id: string): void {
    this.assertReady(id);
    if (this.rows(id).some(row => row.status === 'undone')) throw conflict('Redo history is retained. Redo it or accept a new turn before compacting.');
  }
  /** Atomically archive and replace messages with the matching undo checkpoint.
   * Caller holds the runner's manual operation or active-turn lock. */
  compact(id: string, messages: Message[]): Session {
    return this.transaction(() => {
      this.assertCanCompact(id);
      if (messages.some(message => message.sessionId !== id) || completeToolBoundary(messages) !== messages.length) throw conflict('Compacted history contains mismatched messages or an incomplete tool group.');
      const archive = this.store.compactHistory(id, messages);
      this.advanceRevision(id);
      this.refreshAfterCompaction(id);
      return archive;
    });
  }
  private advanceRevision(id: string): void {
    this.store.updateSession(id, { historyRevision: (this.store.session(id).historyRevision ?? 0) + 1 });
  }
  private refreshAfterCompaction(id: string): void {
    if (this.rows(id).some(row => row.status === 'open')) return; // Automatic in-turn compaction is captured by seal.
    const row = this.rows(id).findLast(row => row.status === 'applied');
    if (!row) return;
    const checkpoint = this.read(row);
    checkpoint.after = this.snapshot(id);
    if (completeToolBoundary(checkpoint.after.messages) !== checkpoint.after.messages.length) throw conflict('Compacted history contains an incomplete tool group.');
    if (size(checkpoint) > HISTORY_LIMITS.bytes) { checkpoint.before = null; checkpoint.after = null; checkpoint.changes = []; checkpoint.unavailableReason = 'Compacted checkpoint exceeds the 32 MiB history budget.'; }
    this.save(row, checkpoint); this.prune(id);
  }
  accept(id: string, message: Message, queuedId?: string): void {
    this.acceptPrepared(id, message, () => {}, queuedId);
  }
  /** The preparation and accepted checkpoint share one outer transaction. Used
   * only for child creation; no live-turn registration survives a failed commit. */
  acceptPrepared<T>(id: string, message: Message, prepare: () => T, queuedId?: string): T {
    const prepared = this.transaction(() => {
      const result = prepare();
      this.assertReady(id);
      if (message.sessionId !== id || message.role !== 'user' || !message.id) throw invalid('A checkpoint requires a matching user message.');
      const messages = this.store.messages(id);
      if (completeToolBoundary(messages) !== messages.length) throw conflict('Existing history contains an incomplete tool group. Explicitly recover it before accepting another turn.');
      if (this.rows(id).some(row => row.status === 'open')) throw conflict('The previous turn has not finished.');
      if (this.store.db.prepare('SELECT id FROM messages WHERE id=?').get(message.id)) throw conflict('This user message was already accepted.');
      const queue = this.store.queue(id);
      if (queuedId) {
        const item = queue.items[0];
        if (queue.paused || item?.id !== queuedId || item.content !== message.content || JSON.stringify(item.attachments) !== JSON.stringify(message.attachments ?? [])) throw conflict('Queued message changed before acceptance.');
        this.store.saveQueue(id, { ...queue, items: queue.items.slice(1) });
      } else if (queue.items.length) throw conflict('Resume or remove queued messages before sending a new turn.');
      const before = this.snapshot(id);
      const checkpoint: Checkpoint = { id: randomUUID(), userId: message.id, workspace: this.store.session(id).workspace, before, after: null, changes: [] };
      if (size(checkpoint) > HISTORY_LIMITS.bytes / 2) { checkpoint.before = null; checkpoint.unavailableReason = 'Conversation exceeds the 32 MiB checkpoint budget. This turn will not support undo.'; }
      this.store.db.prepare("DELETE FROM history_checkpoints WHERE session_id=? AND status='undone'").run(id);
      this.store.db.prepare('INSERT INTO history_checkpoints(id,session_id,status,data) VALUES(?,?,?,?)').run(checkpoint.id, id, 'open', JSON.stringify(checkpoint));
      this.store.saveMessage(message);
      this.prune(id);
      return result;
    });
    liveTurns.get(this.store)!.add(id);
    return prepared;
  }
  /** Verify the task origin belongs to the currently live accepted user turn. */
  assertAcceptedTurn(id: string, userId: string): void {
    const row = this.rows(id).findLast(row => row.status === 'open');
    if (!row || !liveTurns.get(this.store)?.has(id) || this.read(row).userId !== userId) throw conflict('Delegation requires its matching live accepted parent turn.');
  }
  /** Child research cannot mutate the workspace; interrupted checkpoints need
   * no family file recovery and remain inert rather than being replayed. */
  interruptChild(id: string): void {
    if (!this.store.isChild(id)) throw conflict('Only a private researcher child can be interrupted this way.');
    liveTurns.get(this.store)?.delete(id);
    this.store.db.prepare("UPDATE history_checkpoints SET status='interrupted' WHERE session_id=? AND status='open'").run(id);
  }
  private prune(id: string): void {
    const rows = this.rows(id);
    let bytes = rows.reduce((total, row) => total + Buffer.byteLength(row.data), 0);
    let pruned = false;
    while (rows.length > 1 && (rows.length > HISTORY_LIMITS.depth || bytes > HISTORY_LIMITS.bytes)) {
      pruned = true;
      const row = rows.shift()!;
      bytes -= Buffer.byteLength(row.data);
      this.store.db.prepare('DELETE FROM history_checkpoints WHERE id=?').run(row.id);
    }
    if (pruned && rows[0]) {
      const checkpoint = this.read(rows[0]);
      checkpoint.floorReason = 'Older undo checkpoints were pruned to the 20-turn / 32 MiB history limit.';
      this.save(rows[0], checkpoint);
    }
  }
  noteEffects(id: string, notice: string): void {
    const row=this.rows(id).findLast(row=>row.status==='open'||row.status==='interrupted');
    if(!row)return;
    const checkpoint=this.read(row);checkpoint.effectsNotice=notice;this.save(row,checkpoint);
  }
  async beginCommand(id: string, workspace: string, actor?: Pick<FileChange,'actorSessionId'|'invocationId'>): Promise<string> {
    const row=this.rows(id).findLast(row=>row.status==='open');
    if(!row)throw conflict('No accepted turn is available for command effects.');
    const before=await snapshotWorkspace(workspace,[this.store.directory]);
    const key=randomUUID();
    this.store.db.prepare('INSERT INTO command_snapshots(id,session_id,checkpoint_id,workspace,data) VALUES(?,?,?,?,?)').run(key,id,row.id,workspace,JSON.stringify({before,actor}));
    this.noteEffects(id,'Undo covers recorded source-file changes. Generated/dependency directories, processes, network and external tool effects are outside file history.');
    return key;
  }
  async finishCommand(key: string): Promise<FileChange[]> {
    const record=this.store.db.prepare('SELECT * FROM command_snapshots WHERE id=?').get(key) as {session_id:string;checkpoint_id:string;workspace:string;data:string}|undefined;
    if(!record)return [];
    const {before,actor}=JSON.parse(record.data) as {before:WorkspaceSnapshot;actor?:Pick<FileChange,'actorSessionId'|'invocationId'>};
    const result=snapshotChanges(before,await snapshotWorkspace(record.workspace,[this.store.directory]));
    const changes=result.changes.map(change=>({...change,...actor}));
    this.transaction(()=>{
      const row=this.rows(record.session_id).find(row=>row.id===record.checkpoint_id);
      if(!row)throw conflict('The command history checkpoint is missing.');
      const checkpoint=this.read(row);
      for(const change of changes) {
        this.validateChange(change);
        const previous=checkpoint.changes.find(item=>item.path===change.path);
        if(previous&&previous.after!==change.before)throw conflict(`Unrecorded changes conflict with command history for ${change.path}. Inspect the workspace before recovering.`);
        checkpoint.changes=[...checkpoint.changes.filter(item=>item.path!==change.path),{...change,before:previous?previous.before:change.before}];
        this.store.recordChange(record.session_id,change);
      }
      if(result.incomplete)checkpoint.effectsNotice='Some binary, large, or unscanned file effects could not be captured. Undo restores only recorded source files; inspect other command effects separately.';
      if(size(checkpoint)>HISTORY_LIMITS.bytes)throw conflict('Command changes exceed the history budget. Inspect the workspace before recovery.');
      this.save(row,checkpoint);
      this.store.db.prepare('DELETE FROM command_snapshots WHERE id=?').run(key);
    });
    return changes;
  }
  private validateChange(change: FileChange): void {
    if (!change || typeof change.path !== 'string' || !change.path || isAbsolute(change.path) || change.path.includes('\\') || change.path.split('/').some(part => !part || part === '.' || part === '..') || [change.before, change.after].some(text => text !== null && (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > HISTORY_LIMITS.fileBytes))) throw invalid('Invalid recorded file change.');
  }
  prepareChange(id: string, change: FileChange): void {
    this.validateChange(change);
    this.assertReady(id);
    const row = this.rows(id).findLast(row => row.status === 'open');
    if (!row || !liveTurns.get(this.store)?.has(id)) throw conflict('No accepted turn is available for this file edit.');
    const checkpoint = this.read(row);
    const previous = checkpoint.changes.find(item => item.path === change.path);
    if (previous && previous.after !== change.before) throw conflict('The file changed outside the recorded tool sequence. This edit was not applied.');
    if (this.intents(id).length) throw conflict('Resolve the previous file edit before starting another.');
    if (size(checkpoint.changes) + size(change) > HISTORY_LIMITS.bytes / 2 || size(checkpoint) + size(change) > HISTORY_LIMITS.bytes) throw conflict('This turn reached its file snapshot budget. Finish it before editing more files.');
    this.store.db.prepare('INSERT INTO history_intents(session_id,path,checkpoint_id,data) VALUES(?,?,?,?)').run(id, change.path, row.id, JSON.stringify(change));
  }
  commitChange(id: string, change: FileChange): void {
    this.validateChange(change);
    const intent = this.intents(id).find(intent => intent.path === change.path);
    if (!intent || intent.data !== JSON.stringify(change)) throw conflict('The completed file edit does not match its durable intent.');
    this.transaction(() => {
      const row = this.rows(id).find(row => row.id === intent.checkpoint_id);
      if (!row) throw conflict('The file edit checkpoint is missing.');
      const checkpoint = this.read(row);
      const previous = checkpoint.changes.find(item => item.path === change.path);
      const merged = { ...change, before: previous ? previous.before : change.before };
      checkpoint.changes = [...checkpoint.changes.filter(item => item.path !== change.path), merged];
      this.save(row, checkpoint);
      this.store.recordChange(id, change);
      this.store.db.prepare('DELETE FROM history_intents WHERE session_id=? AND path=?').run(id, change.path);
    });
  }
  seal(id: string): void {
    liveTurns.get(this.store)?.delete(id);
    const row = this.rows(id).findLast(row => row.status === 'open');
    if (!row) return;
    if (this.intents(id).length || this.store.db.prepare('SELECT 1 FROM command_snapshots WHERE session_id=?').get(id)) { this.save(row, this.read(row), 'interrupted'); this.pause(id); return; }
    const checkpoint = this.read(row);
    checkpoint.after = this.snapshot(id);
    if (completeToolBoundary(checkpoint.after.messages) !== checkpoint.after.messages.length) {
      this.save(row, checkpoint, 'interrupted'); this.pause(id); return;
    }
    if (!checkpoint.before || size(checkpoint) > HISTORY_LIMITS.bytes) { checkpoint.before = null; checkpoint.after = null; checkpoint.changes = []; checkpoint.unavailableReason ||= 'This turn exceeds the 32 MiB history budget and cannot be undone.'; }
    this.transaction(() => {
      if (checkpoint.unavailableReason) this.store.db.prepare('DELETE FROM history_checkpoints WHERE session_id=? AND sequence<?').run(id, row.sequence);
      this.save(row, checkpoint, 'applied'); this.prune(id);
    });
  }
  private assertSnapshot(id: string, expected: Snapshot): void {
    if (JSON.stringify(this.snapshot(id)) !== JSON.stringify(expected)) throw conflict('Conversation, todos, or recorded changes changed since this checkpoint. No history was replaced.');
  }
  private replaceSnapshot(id: string, snapshot: Snapshot): void {
    this.store.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
    for (const message of snapshot.messages) this.store.saveMessage(message);
    this.store.saveTodos(id, snapshot.todos);
    this.store.clearChanges(id);
    for (const change of snapshot.changes) this.store.recordChange(id, change);
  }
  async undo(id: string, expectedCheckpointId: string): Promise<HistoryState> { return this.move(id, expectedCheckpointId, 'undo'); }
  async redo(id: string, expectedCheckpointId: string): Promise<HistoryState> { return this.move(id, expectedCheckpointId, 'redo'); }
  private async move(id: string, expected: string, direction: 'undo' | 'redo'): Promise<HistoryState> {
    this.assertReady(id);
    const state = this.state(id);
    if (!(direction === 'undo' ? state.canUndo : state.canRedo) || expected !== (direction === 'undo' ? state.undoId : state.redoId)) throw conflict(state.unavailableReason || 'The history checkpoint changed. Refresh before undoing or redoing.');
    const row = this.rows(id).find(row => row.id === expected)!;
    const checkpoint = this.read(row);
    this.assertSnapshot(id, (direction === 'undo' ? checkpoint.after : checkpoint.before)!);
    const plan = checkpoint.changes.filter(change => change.before !== change.after).map(change => direction === 'undo' ? { ...change } : { path: change.path, before: change.after, after: change.before });
    const workspace = checkpoint.workspace ?? this.store.session(id).workspace;
    for (const change of plan) if (await readRestoreTarget(workspace, change.path) !== change.after) throw conflict(`Cannot ${direction} ${change.path}: its contents changed outside this turn.`);
    const operation: Operation = { checkpointId: expected, direction, plan, completed: [] };
    this.transaction(() => { this.pause(id); this.saveOperation(id, operation); });
    return this.finishOperation(id, operation);
  }
  private async finishOperation(id: string, operation: Operation): Promise<HistoryState> {
    const row = this.rows(id).find(row => row.id === operation.checkpointId);
    if (!row) throw conflict('The pending history checkpoint is missing.');
    const checkpoint = this.read(row);
    const target = operation.direction === 'undo' ? checkpoint.before : checkpoint.after;
    const source = operation.direction === 'undo' ? checkpoint.after : checkpoint.before;
    if (!target || !source) throw conflict('The pending history snapshot is unavailable.');
    this.assertSnapshot(id, source);
    const workspace = checkpoint.workspace ?? this.store.session(id).workspace;
    const pending: FileChange[] = [];
    for (const change of operation.plan) {
      const current = await readRestoreTarget(workspace, change.path);
      if (current === change.before) {
        if (!operation.completed.includes(change.path)) operation.completed.push(change.path);
      } else if (!operation.completed.includes(change.path) && current === change.after) pending.push(change);
      else throw conflict(`History recovery conflicts with ${change.path}. Restore its expected contents and retry recovery.`);
    }
    this.saveOperation(id, operation);
    await restoreChanges(workspace, pending, change => {
      operation.completed.push(change.path);
      this.saveOperation(id, operation);
    });
    for (const change of operation.plan) if (await readRestoreTarget(workspace, change.path) !== change.before) throw conflict(`File changed during history restoration: ${change.path}.`);
    this.transaction(() => {
      this.assertSnapshot(id, source);
      this.replaceSnapshot(id, target);
      this.save(row, checkpoint, operation.direction === 'undo' ? 'undone' : 'applied');
      this.store.db.prepare('DELETE FROM history_operations WHERE session_id=?').run(id);
      this.advanceRevision(id);
      this.pause(id);
      this.store.updateSession(id, { status: 'idle' });
    });
    return this.state(id);
  }
  async recover(id: string): Promise<HistoryState> {
    this.store.session(id);
    if (liveTurns.get(this.store)?.has(id)) throw conflict('Wait for the accepted turn to finish before recovery.');
    this.pause(id);
    const operation = this.operation(id);
    if (operation) return this.finishOperation(id, operation);
    const pending=this.rows(id).findLast(row=>row.status==='interrupted'||row.status==='open');
    const workspace = (pending&&this.read(pending).workspace)??this.store.session(id).workspace;
    for(const command of this.store.db.prepare('SELECT id FROM command_snapshots WHERE session_id=? ORDER BY rowid').all(id) as {id:string}[])await this.finishCommand(command.id);
    for (const intent of this.intents(id)) {
      const change: FileChange = JSON.parse(intent.data);
      const current = await readRestoreTarget(workspace, change.path);
      if (current === change.after) this.commitChange(id, change);
      else if (current === change.before) this.store.db.prepare('DELETE FROM history_intents WHERE session_id=? AND path=?').run(id, change.path);
      else throw conflict(`Interrupted file edit conflicts with ${change.path}. Its contents match neither recorded snapshot.`);
    }
    const messages = this.store.messages(id);
    const boundary = completeToolBoundary(messages);
    if (boundary !== messages.length) {
      const note: Message = { id: randomUUID(), sessionId: id, role: 'system', content: 'Recovery notice: an interrupted response contained incomplete tool results. The original history was archived. Some tool outcomes and shell side effects may be unknown; inspect the workspace before continuing. No tool success was inferred or replayed.', createdAt: Date.now() };
      this.store.compactHistory(id, [...messages.slice(0, boundary), note]);
    }
    // Accepted steering is durable before acknowledgement. Restore any note
    // absent from the retained transcript after a hard interruption.
    const visibleIds = new Set(this.store.messages(id).map(message => message.id));
    for (const row of this.rows(id).filter(row => row.status === 'interrupted' || row.status === 'open')) {
      const turnId = this.read(row).userId;
      for (const note of this.store.db.prepare('SELECT id,content,created_at FROM steering_notes WHERE session_id=? AND turn_id=? ORDER BY rowid').all(id,turnId) as {id:string;content:string;created_at:number}[]) {
        if (!visibleIds.has(note.id)) this.store.saveMessage({id:note.id,sessionId:id,turnId,role:'system',content:`[Steering] The user sent this note before the response was interrupted. It still needs attention: ${note.content}`,createdAt:note.created_at});
      }
    }
    for (const row of this.rows(id).filter(row => row.status === 'interrupted' || row.status === 'open')) {
      if (row.status === 'interrupted') this.save(row, this.read(row), 'open');
      this.seal(id);
    }
    this.advanceRevision(id);
    return this.state(id);
  }
}
