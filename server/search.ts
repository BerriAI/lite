import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '../shared/types.js';

export type SearchKind = 'user_text' | 'assistant_text' | 'tool_input' | 'tool_error' | 'tool_output';
export interface SearchQuery { query: string; kinds?: SearchKind[]; toolName?: string; sessionId?: string; excludeSessionId?: string; limit?: number }
export interface SearchHit { sessionId: string; messageId: string; messageIndex: number; kind: SearchKind; toolName?: string; snippet: string; score: number }
export interface SearchResult { hits: SearchHit[]; indexed: { sessions: number; messages: number } }
export interface AroundQuery { sessionId: string; messageIndex: number; before?: number; after?: number }
export interface AroundMessage { index: number; role: Message['role']; content: string; toolNames?: string[] }
export interface IndexAllProgress { done: boolean; scanned: number; reindexed: number; indexed: { sessions: number; messages: number } }
export const SEARCH_LIMITS = { partBytes: 16 * 1024, snippetBytes: 320, contextBytes: 2 * 1024, results: 8, resultsMax: 20, neighbors: 3, neighborsMax: 10, sessionsPerPass: 200 } as const;

const DEFAULT_KINDS: SearchKind[] = ['user_text', 'assistant_text', 'tool_input', 'tool_error'];
const ALL_KINDS = new Set<SearchKind>([...DEFAULT_KINDS, 'tool_output']);
type FtsRow = { session_id: string; message_id: string; message_index: number; kind: SearchKind; tool_name: string; snip: string; score: number };
function bounded(text: string, max: number): string {
  const bytes = Buffer.from(text); if (bytes.length <= max) return text;
  let end = max; while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
/** UTF-8-safe cap that appends `note` only when content was actually cut; the result never exceeds `max` bytes. */
function capped(text: string, max: number, note: string): string {
  return Buffer.byteLength(text) <= max ? text : bounded(text, max - Buffer.byteLength(note)) + note;
}
const safeJson = (value: unknown): string => { try { return JSON.stringify(value) ?? ''; } catch { return ''; } };

/** Advisory full-text index over session history, derived entirely from the messages
 * table on the same synchronous database handle. It may lag or go missing without
 * harm: search() joins live messages so a stale row can never surface a hit whose
 * message no longer exists in that session, and around() reads live data only. */
export class SearchIndex {
  readonly db: DatabaseSync;
  private cursor = 0; // sessions.rowid high-water mark for the current indexAll pass
  constructor(store: { db: DatabaseSync }) {
    this.db = store.db;
    // A regular (content-storing) FTS5 table rather than contentless: contentless
    // tables only accept rowid-addressed deletes, while compaction/undo rewrite a
    // whole session and need DELETE ... WHERE session_id=?; stored content also
    // lets snippet() work without a second lookup. Size is bounded by the 16 KiB
    // per-part cap. Staleness is tracked per session as a cheap fingerprint
    // (message count, max messages rowid, total data bytes) so indexAll() skips
    // untouched sessions and rerunning it is idempotent.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(session_id UNINDEXED, message_id UNINDEXED, message_index UNINDEXED, kind, tool_name, content);
      CREATE TABLE IF NOT EXISTS history_fts_state (session_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL, max_message_rowid INTEGER NOT NULL, data_bytes INTEGER NOT NULL, parts INTEGER NOT NULL);`);
  }
  private atomic<T>(operation: () => T): T {
    const name = `litespeed_search_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = operation(); this.db.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); throw error; }
  }
  /** Reindexes one session from its current messages (delete+reinsert: rewrites via
   * compaction/undo/fork invalidate arbitrary rows, so replacement is the only safe
   * incremental unit). Indexing a deleted session removes its rows instead. */
  index(sessionId: string): { messages: number; parts: number } {
    return this.atomic(() => {
      if (!this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) { this.removeInside(sessionId); return { messages: 0, parts: 0 }; }
      this.db.prepare('DELETE FROM history_fts WHERE session_id=?').run(sessionId);
      const rows = this.db.prepare('SELECT rowid, data FROM messages WHERE session_id=? ORDER BY rowid').all(sessionId) as { rowid: number | bigint; data: string }[];
      const insert = this.db.prepare('INSERT INTO history_fts(session_id,message_id,message_index,kind,tool_name,content) VALUES(?,?,?,?,?,?)');
      const calls = new Map<string, { name: string; status: string }>();
      let parts = 0, maxRowid = 0, dataBytes = 0;
      rows.forEach((row, index) => {
        maxRowid = Math.max(maxRowid, Number(row.rowid)); dataBytes += Buffer.byteLength(row.data);
        let message: Message; try { message = JSON.parse(row.data); } catch { return; }
        const emit = (kind: SearchKind, content: string, toolName?: string) => {
          const text = content.trim(); if (!text) return;
          insert.run(sessionId, message.id, index, kind, toolName ?? '', capped(text, SEARCH_LIMITS.partBytes, '\n[Indexed content truncated at 16 KiB.]')); parts++;
        };
        for (const call of message.toolCalls ?? []) { calls.set(call.id, { name: call.name, status: call.status }); emit('tool_input', `${call.name} ${safeJson(call.args)}`, call.name); }
        if (message.role === 'user') emit('user_text', message.content);
        else if (message.role === 'assistant') emit('assistant_text', message.content);
        else if (message.role === 'tool') { const call = message.toolCallId ? calls.get(message.toolCallId) : undefined; emit(call?.status === 'error' ? 'tool_error' : 'tool_output', message.content, call?.name); }
      });
      this.db.prepare('INSERT INTO history_fts_state(session_id,message_count,max_message_rowid,data_bytes,parts) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET message_count=excluded.message_count,max_message_rowid=excluded.max_message_rowid,data_bytes=excluded.data_bytes,parts=excluded.parts').run(sessionId, rows.length, maxRowid, dataBytes, parts);
      return { messages: rows.length, parts };
    });
  }
  remove(sessionId: string): void { this.atomic(() => this.removeInside(sessionId)); }
  private removeInside(sessionId: string): void {
    this.db.prepare('DELETE FROM history_fts WHERE session_id=?').run(sessionId);
    this.db.prepare('DELETE FROM history_fts_state WHERE session_id=?').run(sessionId);
  }
  /** Walks sessions in rowid order, reindexing only stale ones. Bounded to 200
   * sessions per invocation; call again while done is false to finish a pass. */
  indexAll(): IndexAllProgress {
    // Sweep index rows whose session was deleted, bounded per call like the scan.
    const orphans = this.db.prepare('SELECT session_id FROM history_fts_state WHERE session_id NOT IN (SELECT id FROM sessions) LIMIT ?').all(SEARCH_LIMITS.sessionsPerPass) as { session_id: string }[];
    for (const orphan of orphans) this.remove(orphan.session_id);
    const sessions = this.db.prepare('SELECT rowid, id FROM sessions WHERE rowid>? ORDER BY rowid LIMIT ?').all(this.cursor, SEARCH_LIMITS.sessionsPerPass) as { rowid: number | bigint; id: string }[];
    let reindexed = 0;
    for (const session of sessions) {
      this.cursor = Number(session.rowid);
      if (this.stale(session.id)) { this.index(session.id); reindexed++; }
    }
    const done = sessions.length < SEARCH_LIMITS.sessionsPerPass;
    if (done) this.cursor = 0;
    return { done, scanned: sessions.length, reindexed, indexed: this.indexedCounts() };
  }
  private stale(sessionId: string): boolean {
    const state = this.db.prepare('SELECT message_count,max_message_rowid,data_bytes FROM history_fts_state WHERE session_id=?').get(sessionId) as { message_count: number; max_message_rowid: number; data_bytes: number } | undefined;
    const current = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(rowid),0) AS max, COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) AS bytes FROM messages WHERE session_id=?').get(sessionId) as { count: number; max: number; bytes: number };
    return !state || Number(state.message_count) !== Number(current.count) || Number(state.max_message_rowid) !== Number(current.max) || Number(state.data_bytes) !== Number(current.bytes);
  }
  private indexedCounts(): { sessions: number; messages: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(message_count),0) AS messages FROM history_fts_state').get() as { sessions: number; messages: number };
    return { sessions: Number(row.sessions), messages: Number(row.messages) };
  }
  /** Ranked by bm25 (ascending: lower is better). tool_output is excluded unless
   * the caller opts in via kinds — raw tool results drown out intent otherwise.
   * The result always carries indexed counts so callers can render honest empties:
   * zero hits against a barely-indexed store is not proof of absence. */
  search(input: SearchQuery): SearchResult {
    const indexed = this.indexedCounts();
    const query = (input.query ?? '').replaceAll('\0', ' ').trim();
    const requested = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.trunc(input.limit) : SEARCH_LIMITS.results;
    const limit = Math.min(Math.max(requested, 1), SEARCH_LIMITS.resultsMax);
    const kinds = [...new Set((input.kinds ?? DEFAULT_KINDS).filter(kind => ALL_KINDS.has(kind)))];
    if (!query || !kinds.length) return { hits: [], indexed };
    const conditions = [`kind IN (${kinds.map(() => '?').join(',')})`], params: (string | number)[] = [...kinds];
    if (input.toolName) { conditions.push('tool_name=?'); params.push(input.toolName); }
    if (input.sessionId) { conditions.push('history_fts.session_id=?'); params.push(input.sessionId); }
    // Searching a session from within itself only ever finds the request that
    // asked for the search; callers exclude the searching session by default.
    if (input.excludeSessionId && input.excludeSessionId !== input.sessionId) { conditions.push('history_fts.session_id!=?'); params.push(input.excludeSessionId); }
    // The join is the staleness guard: a hit must still exist as that message in
    // that session right now, so a lagging index never yields a wrong-session result.
    const sql = `SELECT history_fts.session_id, message_id, message_index, kind, tool_name,
        snippet(history_fts, 5, '[', ']', '…', 12) AS snip, bm25(history_fts) AS score
      FROM history_fts JOIN messages ON messages.id=message_id AND messages.session_id=history_fts.session_id
      WHERE history_fts MATCH ? AND ${conditions.join(' AND ')} ORDER BY score LIMIT ?`;
    const hits = this.matchRows(sql, query, params, limit).map(row => ({
      sessionId: row.session_id, messageId: row.message_id, messageIndex: Number(row.message_index), kind: row.kind,
      ...(row.tool_name ? { toolName: row.tool_name } : {}),
      snippet: capped(row.snip, SEARCH_LIMITS.snippetBytes, '…'), score: Number(row.score),
    }));
    return { hits, indexed };
  }
  /** FTS5 syntax must never escape to the caller: try the raw query first (power
   * users keep operators), then retry with every whitespace-separated term quoted
   * ('"' doubled), dropping operator-only garbage; anything still unparsable is []. */
  private matchRows(sql: string, query: string, params: (string | number)[], limit: number): FtsRow[] {
    const attempt = (match: string) => this.db.prepare(sql).all(match, ...params, limit) as FtsRow[];
    try { return attempt(`content:(${query})`); } catch { /* fall through to quoted terms */ }
    const terms = query.split(/\s+/).filter(term => /[\p{L}\p{N}]/u.test(term)).map(term => `"${term.replaceAll('"', '""')}"`);
    if (!terms.length) return [];
    try { return attempt(`content:(${terms.join(' ')})`); } catch { return []; }
  }
  /** Live neighborhood of one message, straight from the messages table (never the
   * index). A deleted or unknown session simply yields []. */
  around(input: AroundQuery): AroundMessage[] {
    const clamp = (value: number | undefined, fallback: number) => Math.min(Math.max(typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback, 0), SEARCH_LIMITS.neighborsMax);
    const before = clamp(input.before, SEARCH_LIMITS.neighbors), after = clamp(input.after, SEARCH_LIMITS.neighbors);
    const center = Math.max(0, Math.trunc(input.messageIndex) || 0), start = Math.max(0, center - before);
    const rows = this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY rowid LIMIT ? OFFSET ?').all(input.sessionId, center - start + after + 1, start) as { data: string }[];
    const result: AroundMessage[] = [];
    rows.forEach((row, offset) => {
      let message: Message; try { message = JSON.parse(row.data); } catch { return; }
      const toolNames = message.toolCalls?.map(call => call.name);
      result.push({ index: start + offset, role: message.role, content: capped(message.content ?? '', SEARCH_LIMITS.contextBytes, '\n[Content truncated at 2 KiB.]'), ...(toolNames?.length ? { toolNames } : {}) });
    });
    return result;
  }
}
