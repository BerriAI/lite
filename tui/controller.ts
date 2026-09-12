import type { Attachment, PermissionRequest, QuestionAnswer, QuestionRequest, QueuedMessage, Session, SessionDetail, Settings } from '../shared/types.js';
import type { SkillInvocation } from '../shared/skill-commands.js';
import { SessionSync, type SyncState } from './sync.js';
import { ApiError, LitespeedClient } from './client.js';

export interface Draft { text: string; attachments: Attachment[] }
export interface DraftStorage { load(key: string): Draft; save(key: string, draft: Draft): void; remember?(text: string): void; history?(): string[] }
export interface ClientState { sync: SyncState; draft: Draft; pending: string | null; notice: string; settings: Settings | null }
const empty = (): Draft => ({ text: '', attachments: [] });
export const isRunning = (detail: SessionDetail | null) => Boolean(detail && ['running', 'waiting'].includes(detail.session.status));
export const effectiveModel = (session: Session) => session.mode === 'plan' && session.planner ? session.planner : { providerId: session.providerId, model: session.model };

/** Owns client requests and drafts; the server remains authoritative for work. */
export class TerminalController {
  private state: ClientState;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private generation = 0;
  private drafts = new Map<string, Draft>();
  constructor(readonly client: LitespeedClient, private sync: SessionSync, private storage?: DraftStorage) {
    this.state = { sync: sync.getState(), draft: this.loadDraft(sync.sessionId), pending: null, notice: '', settings: null };
    this.connect();
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<ClientState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private connect() {
    this.unsubscribe = this.sync.subscribe(() => this.set({ sync: this.sync.getState() }));
    this.sync.start();
  }
  private key(id: string) { return JSON.stringify([this.client.base, id]); }
  private loadDraft(id: string): Draft { return this.drafts.get(id) ?? this.storage?.load(this.key(id)) ?? empty(); }
  setDraft(draft: Draft) {
    this.drafts.set(this.sync.sessionId, draft); this.set({ draft });
    try { this.storage?.save(this.key(this.sync.sessionId), draft); } catch { this.set({ notice: 'Draft kept in memory; it could not be saved to disk.' }); }
  }
  inputHistory() { return this.storage?.history?.() ?? []; }
  notice(notice: string) { this.set({ notice }); }
  async settings() { const settings = await this.client.api<Settings>('/settings'); this.set({ settings }); return settings; }
  get sessionId() { return this.sync.sessionId; }
  get detail() { return this.state.sync.detail; }
  path(suffix = '') { return `/sessions/${encodeURIComponent(this.sessionId)}${suffix}`; }
  async refresh() { await this.sync.refresh(); this.set({ sync: this.sync.getState() }); }
  async open(id: string) {
    if (this.state.pending) throw new Error('Wait for the current action before switching sessions.');
    this.generation++; this.unsubscribe?.(); this.sync.stop();
    this.sync = new SessionSync(this.client, id);
    this.set({ sync: this.sync.getState(), draft: this.loadDraft(id), notice: '' }); this.connect();
  }
  async create(workspace: string) {
    let session: Session | undefined;
    const accepted = await this.action('Creating session', async () => { session = await this.client.api<Session>('/sessions', { workspace }); });
    if (accepted && session) await this.open(session.id);
    return session;
  }
  configurationReady() {
    if (this.state.pending || isRunning(this.detail) || this.detail?.history?.pendingRecovery) throw new Error('Finish the response or recover history before changing configuration.');
  }
  async action(label: string, operation: () => Promise<unknown>): Promise<boolean> {
    if (this.state.pending) { this.notice('Another action is still being accepted.'); return false; }
    const generation = this.generation;
    this.set({ pending: label, notice: '' });
    try {
      await operation();
      // Failure to refresh after an accepted mutation must not invite a replay.
      if (generation === this.generation) await this.refresh().catch(() => this.notice('Action accepted. Reconnecting to refresh its state…'));
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.notice(error instanceof Error ? error.message : 'The action failed.');
        await this.refresh().catch(() => {});
      }
      return false;
    } finally { if (generation === this.generation) this.set({ pending: null }); }
  }
  async send(kind: 'message' | 'steer' | 'queue' = 'message', content?: string, skills?: SkillInvocation) {
    const detail = this.detail, draft = this.state.draft;
    if (!detail || (!draft.text.trim() && !draft.attachments.length)) return false;
    if (kind === 'steer' && (!isRunning(detail) || draft.attachments.length)) { this.notice('Steering needs a running response and text without attachments.'); return false; }
    if (detail.history?.pendingRecovery) { this.notice('Recover the interrupted history before sending. Your draft is saved.'); return false; }
    const queued = kind === 'queue' || kind !== 'steer' && (isRunning(detail) || Boolean(detail.queue?.items.length));
    if (queued && (detail.queue?.items.length ?? 0) >= 20) { this.notice('Queue is full. Remove a message or resume it first.'); return false; }
    const path = this.path(kind === 'steer' ? '/steer' : queued ? '/queue' : '/messages');
    const accepted = await this.action(kind === 'steer' ? 'Sending steering' : queued ? 'Queuing' : 'Sending', async () => {
      await this.client.api(path, { content: content ?? (draft.text.trim() || 'Please review the attached files.'), ...(kind === 'steer' ? {} : { attachments: draft.attachments }), ...(skills ? { skills } : {}) });
      if (this.state.draft === draft) this.setDraft(empty());
      try { this.storage?.remember?.(draft.text); } catch { this.notice('Message accepted; input history could not be saved.'); }
    });
    return accepted;
  }
  cancel() { return this.action('Stopping', () => this.client.api(this.path('/cancel'), {})); }
  interrupt() {
    const turnId=this.detail?.messages.findLast(message=>message.role==='user')?.id;
    return turnId ? this.action('Interrupting', () => this.client.api(this.path('/interrupt'), {turnId})) : this.cancel();
  }
  async recallQueued(id?: string) {
    const items=(this.detail?.queue?.items??[]).filter(item=>!id||item.id===id);
    if(!items.length)return false;
    const merge=(entries:QueuedMessage[]):Draft=>({text:[...entries.map(item=>item.content),this.state.draft.text].filter(Boolean).join('\n'),attachments:[...entries.flatMap(item=>item.attachments.filter(attachment=>!attachment.skillId)),...this.state.draft.attachments]});
    const preview=merge(items);
    if(preview.text.length>200000||preview.attachments.length>10||Buffer.byteLength(JSON.stringify(preview))>12*1024*1024) {
      this.notice('These queued messages are too large for one draft. Use /queue to edit one message at a time.');return false;
    }
    return this.action('Editing queued messages',async()=>{
      let recalled:QueuedMessage[];
      try {({items:recalled}=await this.client.api<{items:QueuedMessage[]}>(this.path('/queue/recall'),{ids:items.map(item=>item.id)}));}
      catch(error) {
        // A lost response may follow a committed recall. Keep a visible copy
        // rather than losing the user's input; definite rejections leave it queued.
        if(!(error instanceof ApiError&&error.status&&error.status>=400&&error.status<500)) {
          this.setDraft(merge(items));
          throw new Error('Could not confirm queue recall. Messages were copied into your draft; review /queue before resending.');
        }
        throw error;
      }
      this.setDraft(merge(recalled));
    });
  }
  decide(request: PermissionRequest, decision: 'allow' | 'always' | 'deny') {
    return this.action('Recording decision', () => this.client.api(this.path(`/permissions/${encodeURIComponent(request.id)}`), { decision }));
  }
  permissionMode(permissionMode: Session['permissionMode']) {
    return this.action('Updating permissions', () => this.client.api(this.path('/permission-mode'), { permissionMode, expectedConfigRevision: this.detail?.session.configRevision ?? 0 }, 'PATCH'));
  }
  answer(request: QuestionRequest, answer: QuestionAnswer) {
    return this.action('Sending answer', () => this.client.api(`/sessions/${encodeURIComponent(request.sessionId)}/questions/${encodeURIComponent(request.id)}/answer`, answer));
  }
  steerQueued(id: string) { return this.action('Steering driver', () => this.client.api(this.path(`/queue/${encodeURIComponent(id)}/steer`), {})); }
  queue(action: 'pause' | 'resume' | 'remove', id?: string) {
    return this.action('Updating queue', () => this.client.api(this.path(`/queue/${action === 'remove' ? encodeURIComponent(id!) : action}`), action === 'remove' ? undefined : {}, action === 'remove' ? 'DELETE' : 'POST'));
  }
  configure(patch: Record<string, unknown>, expectedConfigRevision = this.detail?.session.configRevision ?? 0) {
    this.configurationReady();
    return this.action('Saving configuration', () => this.client.api(this.path(), { ...patch, expectedConfigRevision }, 'PATCH'));
  }
  history(direction: 'undo' | 'redo' | 'recover') {
    const state = this.detail?.history;
    const checkpointId = direction === 'undo' ? state?.undoId : direction === 'redo' ? state?.redoId : undefined;
    return this.action(`${direction === 'recover' ? 'Recovering' : direction === 'undo' ? 'Undoing' : 'Redoing'} history`, () => this.client.api(this.path(`/history/${direction}`), checkpointId ? { checkpointId } : {}));
  }
  async fork(messageId?: string) {
    let session: Session | undefined;
    if (await this.action('Forking session', async () => { session = await this.client.api<Session>(this.path('/fork'), messageId ? { messageId } : {}); }) && session) await this.open(session.id);
  }
  stop() { this.generation++; this.unsubscribe?.(); this.sync.stop(); this.listeners.clear(); }
}
