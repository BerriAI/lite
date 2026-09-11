import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { History } from '../server/history.js';
import { resolveProfileChoice, type ResolvedProfile } from '../server/profiles.js';
import type { Message } from '../shared/types.js';

let directory: string, store: Store, resolved: ResolvedProfile;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-profile-store-'))); store = new Store(join(directory, 'data'));
  store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: 'http://127.0.0.1:1' }], defaultProvider: 'test', defaultModel: 'model' });
  await mkdir(join(directory, '.litespeed/skills/check'), { recursive: true });
  await writeFile(join(directory, '.litespeed/profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'review', name: 'Review', tools: ['read_file'], instructions: 'Pinned profile instructions' }], skills: [{ id: 'check', name: 'Check' }] }));
  await writeFile(join(directory, '.litespeed/skills/check/SKILL.md'), 'Pinned skill bytes\r\nno final newline');
  resolved = await resolveProfileChoice(directory, { profileId: 'review', skillIds: ['check'] });
});
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
const rows = () => store.db.prepare('SELECT session_id,data FROM session_profiles').all();
const message = (id: string, role: Message['role'] = 'user'): Message => ({ id: randomUUID(), sessionId: id, role, content: role === 'user' ? 'Task' : 'Completed', createdAt: Date.now() });

describe('transactional pinned profile storage', () => {
  it('creates private snapshot atomically, drops imported public activation, and normalizes old revisions', () => {
    const profiled = store.createSession({ permissionMode: 'auto' }, resolved);
    expect(profiled.configRevision).toBe(0); expect(profiled.profile).toEqual(resolved.snapshot?.active); expect(store.profileSnapshot(profiled.id)).toEqual(resolved.snapshot);
    expect(JSON.stringify(profiled)).not.toContain('Pinned'); expect(store.createSession({ ...profiled, id: randomUUID(), configRevision: 900 }).profile).toBeUndefined();
    const ordinary = store.createSession(); expect(store.profileSnapshot(ordinary.id)).toBeNull();
    store.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ ...ordinary, configRevision: undefined }), ordinary.id);
    expect(store.session(ordinary.id).configRevision).toBe(0); expect(store.sessions().find(item => item.id === ordinary.id)?.configRevision).toBe(0);
  });

  it('activation compares revisions, pauses queue and preserves permissions and grants on activate/clear', async () => {
    const session = store.createSession({ permissionMode: 'auto' }); store.grantTool(session.id, 'bash', 'known'); store.enqueue(session.id, 'Queued work', [], true);
    const updated = store.applyProfile(session.id, 0, resolved, { mode: 'plan' });
    expect(updated).toMatchObject({ mode: 'plan', permissionMode: 'auto', configRevision: 1 }); expect(store.toolGrants(session.id)).toEqual([{ tool: 'bash', scope: 'known' }]); expect(store.queue(session.id).paused).toBe(true);
    const before = store.profileSnapshot(session.id); expect(() => store.applyProfile(session.id, 0, resolved)).toThrow(/changed/); expect(store.profileSnapshot(session.id)).toEqual(before);
    const empty = await resolveProfileChoice(directory, { profileId: null, skillIds: [] }); const cleared = store.applyProfile(session.id, 1, empty);
    expect(cleared.profile).toBeUndefined(); expect(cleared.configRevision).toBe(2); expect(store.profileSnapshot(session.id)).toBeNull(); expect(store.toolGrants(session.id)).toHaveLength(1);
  });

  it('ordinary configuration updates are optimistic, do not allow forged activation and only bump real configuration changes', () => {
    const session = store.createSession(); store.enqueue(session.id, 'Pending', [], true);
    expect(store.updateSession(session.id, { title: 'Rename' }).configRevision).toBe(0);
    expect(store.updateSession(session.id, { status: 'running' }).configRevision).toBe(0);
    expect(store.updateSession(session.id, { profile: resolved.snapshot!.active, configRevision: 99 }).profile).toBeUndefined();
    expect(store.updateSession(session.id, { model: 'other' }, 0).configRevision).toBe(1); expect(store.queue(session.id).paused).toBe(true);
    expect(() => store.updateSession(session.id, { model: 'third' }, 0)).toThrow(/changed/); expect(store.session(session.id).model).toBe('other');
    expect(store.updateSession(session.id, { model: 'other' }, 1).configRevision).toBe(1);
  });

  it.each(['create', 'apply', 'fork', 'archive'])('real deferred COMMIT failure rolls back every %s side effect', phase => {
    const source = phase === 'create' ? undefined : store.createSession({}, phase === 'apply' ? undefined : resolved);
    if (source) { store.saveMessage(message(source.id)); store.enqueue(source.id, 'Queued', [], true); }
    const sessions = store.sessions(), snapshots = rows(), queue = source ? store.queue(source.id) : undefined, original = source ? store.messages(source.id) : undefined;
    store.db.exec(`CREATE TABLE profile_commit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE profile_commit_child(parent_id INTEGER REFERENCES profile_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER reject_profile_commit AFTER INSERT ON session_profiles BEGIN INSERT INTO profile_commit_child(parent_id) VALUES(1); END;`);
    expect(() => phase === 'create' ? store.createSession({}, resolved) : phase === 'apply' ? store.applyProfile(source!.id, 0, resolved, { model: 'other' }) : phase === 'fork' ? store.fork(source!.id) : store.compactHistory(source!.id, [message(source!.id, 'system')])).toThrow(/FOREIGN KEY/);
    expect(store.sessions()).toEqual(sessions); expect(store.sessions('', true)).toEqual([]); expect(rows()).toEqual(snapshots);
    if (source) { expect(store.queue(source.id)).toEqual(queue); expect(store.messages(source.id)).toEqual(original); }
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM profile_commit_child').get()).toMatchObject({ count: 0 });
  });

  it('fork, compaction, restart and exact history moves use pinned snapshots without rereading project files', async () => {
    const session = store.createSession({}, resolved), history = new History(store), user = message(session.id);
    history.accept(session.id, user); store.saveMessage(message(session.id, 'assistant')); history.seal(session.id);
    await rm(join(directory, '.litespeed'), { recursive: true });
    store.grantTool(session.id, 'bash', 'scope'); const fork = store.fork(session.id); expect(store.profileSnapshot(fork.id)).toEqual(resolved.snapshot); expect(store.toolGrants(fork.id)).toEqual([]);
    const archive = history.compact(session.id, [message(session.id, 'system')]); expect(store.profileSnapshot(archive.id)).toEqual(resolved.snapshot);
    const after = store.messages(session.id); await history.undo(session.id, history.state(session.id).undoId!); expect(store.profileSnapshot(session.id)).toEqual(resolved.snapshot);
    await history.redo(session.id, history.state(session.id).redoId!); expect(store.messages(session.id)).toEqual(after);
    store.close(); store = new Store(join(directory, 'data')); expect(store.profileSnapshot(session.id)).toEqual(resolved.snapshot); expect(store.profileSnapshot(archive.id)).toEqual(resolved.snapshot);
    store.deleteSession(session.id); expect(rows().some(row => row.session_id === session.id)).toBe(false); expect(store.profileSnapshot(fork.id)).toEqual(resolved.snapshot);
  });

  it.each(['missing', 'invalid-json', 'mismatch', 'body-corrupt'])('fails closed on %s private snapshot and allows explicit clear', async kind => {
    const session = store.createSession({}, resolved);
    if (kind === 'missing') store.db.prepare('DELETE FROM session_profiles WHERE session_id=?').run(session.id);
    else if (kind === 'invalid-json') store.db.prepare('UPDATE session_profiles SET data=? WHERE session_id=?').run('{', session.id);
    else { const snapshot = structuredClone(resolved.snapshot!); if (kind === 'mismatch') snapshot.active.tools = ['bash']; else snapshot.skills[0].body = 'Unpinned'; store.db.prepare('UPDATE session_profiles SET data=? WHERE session_id=?').run(JSON.stringify(snapshot), session.id); }
    expect(() => store.profileSnapshot(session.id)).toThrow(/pinned profile/); expect(() => store.fork(session.id)).toThrow();
    const empty = await resolveProfileChoice(directory, { profileId: null, skillIds: [] }); store.applyProfile(session.id, 0, empty); expect(store.profileSnapshot(session.id)).toBeNull();
  });

  it('never moves a pinned profile to a different workspace or accepts inconsistent resolved revisions', () => {
    expect(() => store.createSession({ workspace: '/different' }, resolved)).toThrow(/workspace/); expect(rows()).toEqual([]);
    const session = store.createSession({}, resolved); expect(() => store.updateSession(session.id, { workspace: '/different' })).toThrow(/Clear/);
    expect(() => store.applyProfile(session.id, 0, { ...resolved, catalogRevision: 'a'.repeat(64) })).toThrow(/revision/);
  });
});
