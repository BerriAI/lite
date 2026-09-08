import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { completeToolBoundary } from './context.js';
import type { ApplyProfileRequest } from '../shared/profiles.js';
import type { ProfileSnapshot, ResolvedProfile } from './profiles.js';
import { validateProfileSnapshot } from './profiles.js';
import type { Session, Message, Settings, Todo, FileChange, RunEvent, Provider, QueueState, QueuedMessage, Attachment } from '../shared/types.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory = resolve(process.env.LITE_DATA_DIR || '.lite')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'lite.db'));
    chmodSync(join(directory, 'lite.db'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
      CREATE TABLE IF NOT EXISTS todos (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,path));
      CREATE TABLE IF NOT EXISTS queues (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_grants (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, tool TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(session_id,tool));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id,id);
      CREATE TABLE IF NOT EXISTS session_profiles (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_turn_id TEXT NOT NULL,
        parent_message_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(parent_session_id,parent_turn_id,parent_message_id,tool_call_id));
      CREATE INDEX IF NOT EXISTS delegations_parent ON delegations(parent_session_id);
      CREATE TABLE IF NOT EXISTS tool_outputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, content BLOB NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_outputs_session ON tool_outputs(session_id, created_at);`);
    // An interrupted process must never leave a session stuck running.
    for (const session of this.sessions('', true).concat(this.sessions())) {
      if (session.status === 'running' || session.status === 'waiting') this.updateSession(session.id, { status: 'idle' });
      const queue=this.queue(session.id);
      if(queue.items.length)this.saveQueue(session.id,{...queue,paused:true,reason:'Server restarted. Review and resume queued messages explicitly.'});
    }
  }
  close() { this.db.close(); }
  settings(): Settings {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get() as { data: string } | undefined;
    const settings: Settings = row ? JSON.parse(row.data) : {
      providers: [{ id: 'litellm', name: 'LiteLLM', kind: 'openai', baseUrl: process.env.LITELLM_BASE_URL || 'http://localhost:4000' }],
      defaultProvider: 'litellm', defaultModel: process.env.LITE_MODEL || '', workspace: resolve(process.env.LITE_WORKSPACE || process.cwd()),
      permissionMode: 'ask', maxSteps: 40, theme: 'system', mcpServers: {},
    };
    settings.providers = settings.providers.map(p => p.id === 'litellm' ? { ...p, apiKey: p.apiKey ?? process.env.LITELLM_API_KEY } : p);
    return settings;
  }
  publicSettings(): Settings {
    const settings = this.settings();
    return { ...settings, providers: settings.providers.map(({ apiKey, ...p }) => ({ ...p, configured: Boolean(apiKey) || ['localhost','127.0.0.1','[::1]'].includes(new URL(p.baseUrl).hostname) })), mcpServers: Object.fromEntries(Object.entries(settings.mcpServers).map(([name, config]) => [name, { ...config, env: config.env ? Object.fromEntries(Object.keys(config.env).map(k => [k, '••••••••'])) : undefined }])) };
  }
  saveSettings(patch: Partial<Settings>): Settings {
    const old = this.settings();
    const providers: Provider[] = patch.providers?.map(p => ({ ...p, apiKey: p.apiKey === undefined ? old.providers.find(x => x.id === p.id)?.apiKey : p.apiKey })) || old.providers;
    const settings = { ...old, ...patch, providers };
    // Environment credentials are never copied to persistent configuration.
    const persisted = { ...settings, providers: providers.map(p => p.id === 'litellm' && process.env.LITELLM_API_KEY && p.apiKey === process.env.LITELLM_API_KEY ? { ...p, apiKey: undefined } : p) };
    this.db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(persisted));
    return this.publicSettings();
  }
  sessions(query = '', archived = false): Session[] {
    const rows = this.db.prepare('SELECT s.data FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM delegations d WHERE d.child_session_id=s.id)').all() as { data: string }[];
    return rows.map(r => this.normalizedSession(JSON.parse(r.data) as Session)).filter(s => s.archived === archived && (!query || s.title.toLowerCase().includes(query.toLowerCase()))).sort((a,b) => b.updatedAt-a.updatedAt);
  }
  isChild(id: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM delegations WHERE child_session_id=?').get(id)); }
  private assertChildMutable(id: string): void {
    const row = this.db.prepare('SELECT status FROM delegations WHERE child_session_id=?').get(id) as { status: string } | undefined;
    if (row && row.status !== 'running') throw Object.assign(new Error('Researcher transcripts are immutable after completion.'), { status: 409 });
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw Object.assign(new Error('Session not found'), { status: 404 });
    return this.normalizedSession(JSON.parse(row.data));
  }
  private detachedMessage(message: Message): Message {
    return { ...message, ...(message.toolCalls ? { toolCalls: message.toolCalls.map(({ delegationId: _delegation, ...call }) => call) } : {}) };
  }
  private normalizedSession(session: Session): Session {
    return { ...session, configRevision: Number.isSafeInteger(session.configRevision) && session.configRevision! >= 0 ? session.configRevision : 0 };
  }
  private atomic<T>(operation: () => T): T {
    const name = `lite_store_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = operation(); this.db.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
  }
  private assertConfigRevision(session: Session, expected?: number): void {
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected !== session.configRevision)) throw Object.assign(new Error('Session configuration changed. Reload and try again.'), { status: 409 });
  }
  private pauseConfigurationQueue(id: string): void {
    const queue = this.queue(id);
    if (queue.items.length) this.saveQueue(id, { ...queue, paused: true, reason: 'Session configuration changed. Review and explicitly resume queued messages.' });
  }
  private writeProfile(id: string, snapshot: ProfileSnapshot | null): void {
    if (snapshot) this.db.prepare('INSERT INTO session_profiles(session_id,data) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(snapshot));
    else this.db.prepare('DELETE FROM session_profiles WHERE session_id=?').run(id);
  }
  private resolvedSnapshot(workspace: string, resolved: ResolvedProfile): ProfileSnapshot | null {
    if (workspace !== resolved.workspace) throw Object.assign(new Error('Resolved profile belongs to a different workspace.'), { status: 409 });
    const snapshot = resolved.snapshot === null ? null : validateProfileSnapshot(resolved.snapshot);
    if (snapshot && snapshot.active.revision !== resolved.catalogRevision) throw Object.assign(new Error('Resolved profile revision is inconsistent.'), { status: 409 });
    return snapshot;
  }
  profileSnapshot(id: string): ProfileSnapshot | null {
    const session = this.session(id), row = this.db.prepare('SELECT data FROM session_profiles WHERE session_id=?').get(id) as { data: string } | undefined;
    if (!row) {
      if (session.profile) throw Object.assign(new Error('The pinned profile snapshot is missing. Explicitly replace or clear it before continuing.'), { status: 409 });
      return null;
    }
    let snapshot: ProfileSnapshot;
    try { snapshot = validateProfileSnapshot(JSON.parse(row.data)); } catch { throw Object.assign(new Error('The pinned profile snapshot is invalid. Explicitly replace or clear it before continuing.'), { status: 409 }); }
    if (!session.profile || JSON.stringify(snapshot.active) !== JSON.stringify(session.profile)) throw Object.assign(new Error('The pinned profile summary is inconsistent. Explicitly replace or clear it before continuing.'), { status: 409 });
    return snapshot;
  }
  createSession(input: Partial<Session> = {}, resolved?: ResolvedProfile): Session {
    return this.atomic(() => {
      const settings = this.settings(), now = Date.now();
      const session: Session = { id: randomUUID(), title: 'New session', workspace: settings.workspace, model: settings.defaultModel, providerId: settings.defaultProvider, mode: 'build', permissionMode: settings.permissionMode, createdAt: now, updatedAt: now, archived: false, ...input, status: 'idle', configRevision: 0 };
      // Imported/public summaries can never manufacture a private activation.
      delete session.profile;
      const snapshot = resolved ? this.resolvedSnapshot(session.workspace, resolved) : null;
      if (snapshot) session.profile = snapshot.active;
      this.db.prepare('INSERT INTO sessions(id,data) VALUES(?,?)').run(session.id, JSON.stringify(session));
      if (snapshot) this.writeProfile(session.id, snapshot);
      return session;
    });
  }
  updateSession(id: string, patch: Partial<Session>, expectedConfigRevision?: number): Session {
    return this.atomic(() => {
      this.assertChildMutable(id);
      const previous = this.session(id); this.assertConfigRevision(previous, expectedConfigRevision);
      const { profile: _profile, configRevision: _revision, ...safe } = patch;
      const changed = (['workspace', 'providerId', 'model', 'mode', 'permissionMode'] as const).some(key => safe[key] !== undefined && safe[key] !== previous[key]);
      if (safe.workspace !== undefined && safe.workspace !== previous.workspace && (previous.profile || this.db.prepare('SELECT 1 FROM session_profiles WHERE session_id=?').get(id))) throw Object.assign(new Error('Clear the profile before changing the workspace.'), { status: 409 });
      const session = { ...previous, ...safe, id, updatedAt: Date.now(), configRevision: previous.configRevision! + (changed ? 1 : 0) };
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), id);
      if (changed) this.pauseConfigurationQueue(id);
      return session;
    });
  }
  applyProfile(id: string, expectedConfigRevision: number, resolved: ResolvedProfile, selection: ApplyProfileRequest['selection'] = {}): Session {
    return this.atomic(() => {
      this.assertChildMutable(id);
      const previous = this.session(id); this.assertConfigRevision(previous, expectedConfigRevision);
      const snapshot = this.resolvedSnapshot(previous.workspace, resolved);
      const session: Session = { ...previous, ...(selection.providerId !== undefined ? { providerId: selection.providerId } : {}), ...(selection.model !== undefined ? { model: selection.model } : {}), ...(selection.mode !== undefined ? { mode: selection.mode } : {}), updatedAt: Date.now(), configRevision: previous.configRevision! + 1 };
      delete session.profile; if (snapshot) session.profile = snapshot.active;
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), id);
      this.writeProfile(id, snapshot); this.pauseConfigurationQueue(id);
      return session;
    });
  }
  deleteSession(id: string) {
    this.session(id);
    if (this.isChild(id)) throw Object.assign(new Error('Delete a researcher through its originating parent session.'), { status: 409 });
    this.atomic(() => {
      const children = this.db.prepare('SELECT child_session_id FROM delegations WHERE parent_session_id=?').all(id) as { child_session_id: string }[];
      for (const child of children) this.db.prepare('DELETE FROM sessions WHERE id=?').run(child.child_session_id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    });
  }
  messages(id: string): Message[] {
    this.session(id);
    return (this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY rowid').all(id) as {data:string}[]).map(r => JSON.parse(r.data));
  }
  saveMessage(message: Message) {
    this.assertChildMutable(message.sessionId);
    this.db.prepare('INSERT INTO messages(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(message.id, message.sessionId, JSON.stringify(message));
  }
  replaceMessages(id: string, messages: Message[]) {
    this.assertChildMutable(id);
    this.db.exec('BEGIN');
    try { this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id); for (const message of messages) this.saveMessage(message); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  compactHistory(id: string, messages: Message[]): Session {
    if (this.isChild(id)) throw Object.assign(new Error('Researcher history cannot be compacted.'), { status: 409 });
    // A savepoint is atomic standalone and also participates in History.compact's
    // outer transaction, so an archive cannot commit before its checkpoint does.
    this.db.exec('SAVEPOINT lite_compaction');
    try {
      const source=this.session(id);
      const snapshot=this.profileSnapshot(id);
      const archive=this.createSession({...source,id:randomUUID(),title:`${source.title} · before compaction`,parentId:id,createdAt:Date.now(),updatedAt:Date.now(),archived:true},snapshot?{workspace:source.workspace,catalogRevision:snapshot.active.revision,snapshot}:undefined);
      for(const message of this.messages(id))this.saveMessage({...this.detachedMessage(message),id:randomUUID(),sessionId:archive.id});
      this.saveTodos(archive.id,this.todos(id));
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
      for(const message of messages)this.saveMessage(message);
      this.db.exec('RELEASE SAVEPOINT lite_compaction');
      return archive;
    } catch(error) { this.db.exec('ROLLBACK TO SAVEPOINT lite_compaction; RELEASE SAVEPOINT lite_compaction');throw error; }
  }
  /** Persist the full pre-truncation output of one tool call so
   * tool_output_page can read it back. Storage is capped at 4 MiB of UTF-8
   * (rounded down to a character boundary, with the cap noted in the stored
   * text); the sha256 covers exactly the stored bytes so paged reassembly is
   * verifiable. Retention is bounded per session: only the newest 200 rows
   * survive a save. Rows ride the sessions ON DELETE CASCADE. */
  saveToolOutput(sessionId: string, callId: string, content: string): void {
    this.session(sessionId);
    if (typeof callId !== 'string' || !callId || typeof content !== 'string') throw new Error('Invalid tool output.');
    const cap = 4 * 1024 * 1024;
    let bytes = Buffer.from(content, 'utf8');
    if (bytes.length > cap) {
      let end = cap;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      bytes = Buffer.concat([bytes.subarray(0, end), Buffer.from('\n[Stored output capped at 4 MiB; the remainder was not retained.]', 'utf8')]);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.atomic(() => {
      this.db.prepare('INSERT OR REPLACE INTO tool_outputs(id,session_id,content,sha256,created_at) VALUES(?,?,?,?,?)').run(callId, sessionId, bytes, sha256, Date.now());
      this.db.prepare('DELETE FROM tool_outputs WHERE session_id=? AND rowid NOT IN (SELECT rowid FROM tool_outputs WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200)').run(sessionId, sessionId);
    });
  }
  /** Session-scoped read-back: a call id from another session is not visible. */
  toolOutput(sessionId: string, callId: string): { content: string; sha256: string } | undefined {
    const row = this.db.prepare('SELECT content,sha256 FROM tool_outputs WHERE id=? AND session_id=?').get(callId, sessionId) as { content: Uint8Array; sha256: string } | undefined;
    return row ? { content: Buffer.from(row.content).toString('utf8'), sha256: row.sha256 } : undefined;
  }
  todos(id: string): Todo[] { const row = this.db.prepare('SELECT data FROM todos WHERE session_id=?').get(id) as {data:string}|undefined; return row ? JSON.parse(row.data) : []; }
  saveTodos(id: string, todos: Todo[]) { this.db.prepare('INSERT INTO todos(session_id,data) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(todos)); }
  changes(id: string): FileChange[] { return (this.db.prepare('SELECT data FROM changes WHERE session_id=?').all(id) as {data:string}[]).map(r => JSON.parse(r.data)); }
  recordChange(id: string, change: FileChange) {
    const previous = this.changes(id).find(c => c.path === change.path);
    this.db.prepare('INSERT INTO changes(session_id,path,data) VALUES(?,?,?) ON CONFLICT(session_id,path) DO UPDATE SET data=excluded.data').run(id, change.path, JSON.stringify({ ...change, before: previous ? previous.before : change.before }));
  }
  clearChanges(id: string) { this.db.prepare('DELETE FROM changes WHERE session_id=?').run(id); }
  clearChange(id: string, path: string) { this.db.prepare('DELETE FROM changes WHERE session_id=? AND path=?').run(id,path); }
  toolGrants(id: string): { tool: string; scope: string }[] {
    this.session(id);
    return this.db.prepare('SELECT tool,scope FROM tool_grants WHERE session_id=? ORDER BY tool').all(id) as {tool:string;scope:string}[];
  }
  grantTool(id: string, tool: string, scope: string) {
    this.session(id);
    this.db.prepare('INSERT INTO tool_grants(session_id,tool,scope) VALUES(?,?,?) ON CONFLICT(session_id,tool) DO UPDATE SET scope=excluded.scope').run(id,tool,scope);
  }
  clearToolGrants(id: string) { this.session(id); this.db.prepare('DELETE FROM tool_grants WHERE session_id=?').run(id); }
  event(event: RunEvent): RunEvent {
    const result = this.db.prepare('INSERT INTO events(session_id,data) VALUES(?,?)').run(event.sessionId, JSON.stringify(event));
    return { ...event, id: Number(result.lastInsertRowid) };
  }
  queue(id: string): QueueState {
    this.session(id);
    const row=this.db.prepare('SELECT data FROM queues WHERE session_id=?').get(id) as {data:string}|undefined;
    return row?JSON.parse(row.data):{items:[],paused:true};
  }
  saveQueue(id: string, queue: QueueState): QueueState {
    this.session(id);
    this.db.prepare('INSERT INTO queues(session_id,data) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(queue));
    return queue;
  }
  enqueue(id: string, content: string, attachments: Attachment[], active: boolean): QueueState {
    const queue=this.queue(id);
    if(queue.items.length>=20)throw Object.assign(new Error('Queue is full (20 messages). Remove an item before adding another.'),{status:409});
    const item:QueuedMessage={id:randomUUID(),sessionId:id,content,attachments,createdAt:Date.now()};
    const next:QueueState={...queue,items:[...queue.items,item]};
    // Explicit Pause holds future items too, even after all existing items are removed.
    if(!queue.items.length&&!queue.manualPause){next.paused=!active;next.reason=active?undefined:'Ready when you are. Resume to send queued messages.';}
    if(Buffer.byteLength(JSON.stringify(next))>16*1024*1024)throw Object.assign(new Error('Queued attachments exceed the 16 MiB session queue limit.'),{status:413});
    return this.saveQueue(id,next);
  }
  removeQueued(id: string, itemId: string): QueueState {
    const queue=this.queue(id);
    if(!queue.items.some(item=>item.id===itemId))throw Object.assign(new Error('Queued message not found. It may already have started.'),{status:404});
    return this.saveQueue(id,{...queue,items:queue.items.filter(item=>item.id!==itemId)});
  }
  acceptQueued(id: string, itemId: string, message: Message): void {
    this.db.exec('BEGIN');
    try {
      const queue=this.queue(id);
      if(queue.paused||queue.items[0]?.id!==itemId)throw Object.assign(new Error('Queue changed before this message could start.'),{status:409});
      const item=queue.items[0];
      if(message.sessionId!==id||message.role!=='user'||message.content!==item.content||JSON.stringify(message.attachments)!==JSON.stringify(item.attachments)||this.db.prepare('SELECT id FROM messages WHERE id=?').get(message.id))throw Object.assign(new Error('Queued message does not match the stored draft.'),{status:409});
      this.saveMessage(message);
      this.saveQueue(id,{...queue,items:queue.items.slice(1)});
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  latestEventId(id: string): number { return Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events WHERE session_id=?').get(id) as {id:number}).id); }
  events(id: string, after: number): RunEvent[] {
    return (this.db.prepare('SELECT id,data FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT 10000').all(id, after) as {id:number,data:string}[]).map(r => ({ ...JSON.parse(r.data), id:r.id }));
  }
  fork(id: string, messageId?: string): Session {
    if (this.isChild(id)) throw Object.assign(new Error('Researcher sessions cannot be forked.'), { status: 409 });
    return this.atomic(() => {
    const source = this.session(id), messages = this.messages(id), snapshot = this.profileSnapshot(id);
    const end = messageId ? messages.findIndex(m => m.id === messageId) : messages.length - 1;
    if (messageId && end < 0) throw Object.assign(new Error('Message not found'), {status:404});
    const session = this.createSession({ ...source, id:randomUUID(), title:`${source.title} (fork)`, parentId:id, createdAt:Date.now(), updatedAt:Date.now(), archived:false }, snapshot ? { workspace: source.workspace, catalogRevision: snapshot.active.revision, snapshot } : undefined);
    // Trim before the earliest crossing group, including partially resolved parallel
    // calls and interrupted runs whose last message is already a tool result.
    const copied = messages.slice(0, completeToolBoundary(messages, end + 1));
    // Tool IDs belong to provider history, not database keys. Preserve them and
    // signed provider metadata together; only persisted message IDs are new.
    for (const m of copied) this.saveMessage({ ...this.detachedMessage(m), id:randomUUID(), sessionId:session.id });
    this.saveTodos(session.id, this.todos(id));
    return session;
    });
  }
}
