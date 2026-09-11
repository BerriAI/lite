import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { SearchIndex, SEARCH_LIMITS } from '../server/search.js';
import type { Message, Session, ToolCall } from '../shared/types.js';

let directory: string, store: Store, search: SearchIndex;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-search-')));
  store = new Store(join(directory, 'data'));
  store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Fixture', kind: 'openai', baseUrl: 'http://127.0.0.1:1' }], defaultProvider: 'test', defaultModel: 'model' });
  search = new SearchIndex(store);
});
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
const message = (sessionId: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id: randomUUID(), sessionId, role, content, createdAt: Date.now(), ...extra });
const call = (id: string, name: string, args: Record<string, unknown>, status: ToolCall['status']): ToolCall => ({ id, name, args, status });
const ftsRows = (sessionId: string) => store.db.prepare('SELECT kind, tool_name, content FROM history_fts WHERE session_id=? ORDER BY message_index').all(sessionId) as { kind: string; tool_name: string; content: string }[];
/** A session exercising every kind: user, assistant with two tool calls (one completed, one errored), both tool results. */
function fixture(): { session: Session; messages: Message[] } {
  const session = store.createSession();
  const user = message(session.id, 'user', 'Please refactor the flumoxide parser');
  const assistant = message(session.id, 'assistant', 'Refactoring the flumoxide parser now', { toolCalls: [call('c1', 'bash', { command: 'grep flumoxide src/' }, 'completed'), call('c2', 'read_file', { path: 'src/flumoxide.ts' }, 'error')] });
  const output = message(session.id, 'tool', 'src/parser.ts: flumoxide grammar table', { toolCallId: 'c1' });
  const failure = message(session.id, 'tool', 'ENOENT: flumoxide.ts vanished', { toolCallId: 'c2' });
  const messages = [user, assistant, output, failure];
  for (const item of messages) store.saveMessage(item);
  return { session, messages };
}

describe('cross-session history search', () => {
  it('indexes user, assistant, tool_input and tool_error kinds and finds them by term', () => {
    const { session, messages } = fixture(); search.index(session.id);
    const { hits, indexed } = search.search({ query: 'flumoxide' });
    expect(indexed).toEqual({ sessions: 1, messages: 4 });
    expect(hits.map(hit => hit.kind).sort()).toEqual(['assistant_text', 'tool_error', 'tool_input', 'tool_input', 'user_text']);
    expect(hits.every(hit => hit.sessionId === session.id && hit.score <= 0 && hit.snippet.includes('[flumoxide]'))).toBe(true);
    const user = hits.find(hit => hit.kind === 'user_text')!;
    expect(user).toMatchObject({ messageId: messages[0].id, messageIndex: 0 });
    expect(user.toolName).toBeUndefined();
    expect(hits.find(hit => hit.kind === 'tool_error')).toMatchObject({ messageId: messages[3].id, messageIndex: 3, toolName: 'read_file' });
  });
  it('excludes noisy tool_output by default and includes it only on request', () => {
    const { session } = fixture(); search.index(session.id);
    expect(search.search({ query: 'grammar' }).hits).toEqual([]);
    const opted = search.search({ query: 'grammar', kinds: ['tool_output'] }).hits;
    expect(opted).toHaveLength(1); expect(opted[0]).toMatchObject({ kind: 'tool_output', messageIndex: 2, toolName: 'bash' });
    expect(search.search({ query: 'flumoxide', kinds: ['bogus' as never, 'tool_output'] }).hits.map(hit => hit.kind)).toEqual(['tool_output']);
  });
  it('filters by toolName and by sessionId', () => {
    const a = fixture(), b = fixture(); search.index(a.session.id); search.index(b.session.id);
    const bash = search.search({ query: 'flumoxide', toolName: 'bash' }).hits;
    expect(bash.length).toBeGreaterThan(0); expect(bash.every(hit => hit.toolName === 'bash' && hit.kind === 'tool_input')).toBe(true);
    const scoped = search.search({ query: 'flumoxide', sessionId: b.session.id }).hits;
    expect(scoped.length).toBeGreaterThan(0); expect(scoped.every(hit => hit.sessionId === b.session.id)).toBe(true);
    expect(search.search({ query: 'flumoxide', toolName: 'nonexistent' }).hits).toEqual([]);
  });
  it('excludes the searching session so a query never matches its own request, unless session_id names it', () => {
    const a = fixture(), b = fixture(); search.index(a.session.id); search.index(b.session.id);
    const excluded = search.search({ query: 'flumoxide', excludeSessionId: a.session.id }).hits;
    expect(excluded.length).toBeGreaterThan(0); expect(excluded.every(hit => hit.sessionId === b.session.id)).toBe(true);
    // Explicitly scoping to the excluded session overrides the exclusion.
    const self = search.search({ query: 'flumoxide', sessionId: a.session.id, excludeSessionId: a.session.id }).hits;
    expect(self.length).toBeGreaterThan(0); expect(self.every(hit => hit.sessionId === a.session.id)).toBe(true);
  });
  it('drops stale hits after a compaction-style rewrite, immediately and after reindex', () => {
    const { session } = fixture(); search.index(session.id);
    expect(search.search({ query: 'flumoxide' }).hits.length).toBeGreaterThan(0);
    store.replaceMessages(session.id, [message(session.id, 'system', 'Summary: parser work concluded'), message(session.id, 'user', 'Now investigate zanthrope caching')]);
    // The live-message join filters stale rows even before anyone reindexes.
    expect(search.search({ query: 'flumoxide' }).hits).toEqual([]);
    search.index(session.id);
    expect(ftsRows(session.id)).toEqual([{ kind: 'user_text', tool_name: '', content: 'Now investigate zanthrope caching' }]);
    expect(search.search({ query: 'zanthrope' }).hits).toMatchObject([{ sessionId: session.id, messageIndex: 1, kind: 'user_text' }]);
  });
  it('never returns a hit whose message no longer exists in that session', () => {
    const { session, messages } = fixture(); search.index(session.id);
    store.db.prepare('DELETE FROM messages WHERE id=?').run(messages[0].id);
    expect(search.search({ query: 'flumoxide' }).hits.some(hit => hit.messageId === messages[0].id)).toBe(false);
  });
  it('removes all rows for a deleted session via remove() and via index() of the deleted id', () => {
    const a = fixture(), b = fixture(); search.index(a.session.id); search.index(b.session.id);
    store.deleteSession(a.session.id); search.remove(a.session.id);
    expect(ftsRows(a.session.id)).toEqual([]);
    expect(search.search({ query: 'flumoxide' }).indexed).toEqual({ sessions: 1, messages: 4 });
    store.deleteSession(b.session.id); expect(search.index(b.session.id)).toEqual({ messages: 0, parts: 0 });
    expect(ftsRows(b.session.id)).toEqual([]);
    expect(search.search({ query: 'flumoxide' })).toEqual({ hits: [], indexed: { sessions: 0, messages: 0 } });
  });
  it.each(['a AND OR (', '"unbalanced', '"" NEAR/ **', 'köln "straße"', '🔥🚀', '', '   ', '\u0000', 'NOT'])('never throws on FTS5-hostile query %j', hostile => {
    const { session } = fixture(); search.index(session.id);
    expect(() => search.search({ query: hostile })).not.toThrow();
  });
  it('matches quoted-term fallback for operator-looking queries and supports real operators', () => {
    const session = store.createSession();
    store.saveMessage(message(session.id, 'user', 'weird AND wonderful (parentheses)')); search.index(session.id);
    expect(search.search({ query: 'weird AND wonderful (' }).hits).toHaveLength(1);
    expect(search.search({ query: 'weird OR absentterm' }).hits).toHaveLength(1);
  });
  it('bounds snippets in bytes, keeping the match marker for ordinary prose', () => {
    const session = store.createSession();
    store.saveMessage(message(session.id, 'user', `${'word '.repeat(200)}snippetterm ${'tail '.repeat(200)}`));
    store.saveMessage(message(session.id, 'user', `${'y'.repeat(500)} snippetterm ${'z'.repeat(500)}`)); search.index(session.id);
    const { hits } = search.search({ query: 'snippetterm' });
    expect(hits).toHaveLength(2);
    expect(hits.every(hit => Buffer.byteLength(hit.snippet) <= SEARCH_LIMITS.snippetBytes)).toBe(true);
    // Ordinary token lengths keep the highlighted term; only a pathological
    // unbroken 500-byte token can push the marker past the byte cap.
    expect(hits.find(hit => hit.messageIndex === 0)!.snippet).toContain('[snippetterm]');
  });
  it('caps indexed content at 16 KiB per part with an explicit truncation note', () => {
    const session = store.createSession();
    store.saveMessage(message(session.id, 'user', `edgeterm ${'界'.repeat(20000)}`)); search.index(session.id);
    const [row] = ftsRows(session.id);
    expect(Buffer.byteLength(row.content)).toBeLessThanOrEqual(SEARCH_LIMITS.partBytes);
    expect(row.content).toContain('[Indexed content truncated at 16 KiB.]'); expect(row.content).not.toContain('�');
    expect(search.search({ query: 'edgeterm' }).hits).toHaveLength(1);
  });
  it('clamps limit into [1, 20] and defaults to 8', () => {
    const session = store.createSession();
    for (let i = 0; i < 25; i++) store.saveMessage(message(session.id, 'user', `clampterm variant ${i}`));
    search.index(session.id);
    expect(search.search({ query: 'clampterm' }).hits).toHaveLength(8);
    expect(search.search({ query: 'clampterm', limit: 999 }).hits).toHaveLength(20);
    expect(search.search({ query: 'clampterm', limit: -3 }).hits).toHaveLength(1);
  });
  it('around returns live bounded neighbors with tool names, clamped to 10 each side', () => {
    const session = store.createSession();
    for (let i = 0; i < 15; i++) store.saveMessage(i === 6 ? message(session.id, 'assistant', `msg-${i}`, { toolCalls: [call('t1', 'bash', {}, 'completed')] }) : message(session.id, 'user', `msg-${i}`));
    const window = search.around({ sessionId: session.id, messageIndex: 5 });
    expect(window.map(entry => entry.index)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(window.map(entry => entry.content)).toEqual([2, 3, 4, 5, 6, 7, 8].map(i => `msg-${i}`));
    expect(window[4]).toMatchObject({ role: 'assistant', toolNames: ['bash'] }); expect(window[0].toolNames).toBeUndefined();
    expect(search.around({ sessionId: session.id, messageIndex: 12, before: 50, after: 50 }).map(entry => entry.index)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(search.around({ sessionId: session.id, messageIndex: 0, before: 0, after: 1 }).map(entry => entry.index)).toEqual([0, 1]);
    expect(search.around({ sessionId: randomUUID(), messageIndex: 0 })).toEqual([]);
    // around() never consults the index: an unindexed session still resolves live.
    const fresh = store.createSession(); store.saveMessage(message(fresh.id, 'user', `long ${'界'.repeat(4000)}`));
    const [entry] = search.around({ sessionId: fresh.id, messageIndex: 0 });
    expect(Buffer.byteLength(entry.content)).toBeLessThanOrEqual(SEARCH_LIMITS.contextBytes); expect(entry.content).toContain('[Content truncated at 2 KiB.]');
  });
  it('indexAll is incremental across bounded passes and idempotent on rerun', () => {
    for (let i = 0; i < SEARCH_LIMITS.sessionsPerPass + 5; i++) {
      const session = store.createSession({ title: `bulk ${i}` });
      if (i < 3) store.saveMessage(message(session.id, 'user', `bulkterm session ${i}`));
    }
    const first = search.indexAll();
    expect(first).toMatchObject({ done: false, scanned: SEARCH_LIMITS.sessionsPerPass, reindexed: SEARCH_LIMITS.sessionsPerPass });
    const second = search.indexAll();
    expect(second).toMatchObject({ done: true, scanned: 5, reindexed: 5 });
    expect(second.indexed).toEqual({ sessions: SEARCH_LIMITS.sessionsPerPass + 5, messages: 3 });
    // Rerunning a full pass reindexes nothing and changes no counts.
    let pass = search.indexAll(); while (!pass.done) { expect(pass.reindexed).toBe(0); pass = search.indexAll(); }
    expect(pass.reindexed).toBe(0); expect(pass.indexed).toEqual(second.indexed);
    expect(search.search({ query: 'bulkterm' }).hits).toHaveLength(3);
    // New activity in one session is picked up by the next full pass.
    const target = store.sessions().find(session => session.title === 'bulk 1')!;
    store.saveMessage(message(target.id, 'user', 'freshterm arrived'));
    let sweep = search.indexAll(); while (!sweep.done) sweep = search.indexAll();
    expect(search.search({ query: 'freshterm' }).hits).toMatchObject([{ sessionId: target.id }]);
    // Deleting a session is swept out of the counts by indexAll.
    store.deleteSession(target.id);
    let cleanup = search.indexAll(); while (!cleanup.done) cleanup = search.indexAll();
    expect(cleanup.indexed.sessions).toBe(SEARCH_LIMITS.sessionsPerPass + 4);
    expect(search.search({ query: 'freshterm' }).hits).toEqual([]);
  });
});
