import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { History } from '../server/history.js';
import { Delegations, DELEGATION_LIMITS, type CreateDelegation } from '../server/delegations.js';
import { resolveProfileChoice, type ProfileSnapshot } from '../server/profiles.js';
import type { Message, Session } from '../shared/types.js';

let directory: string, store: Store, history: History, delegations: Delegations;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-delegations-'))); store = new Store(join(directory, 'data'));
  store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Fixture', kind: 'openai', baseUrl: 'http://127.0.0.1:1' }], defaultProvider: 'test', defaultModel: 'model' });
  history = new History(store); delegations = new Delegations(store, history);
});
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
const message = (sessionId: string, role: Message['role'], content = 'Fixture message'): Message => ({ id: randomUUID(), sessionId, role, content, createdAt: Date.now() });
function origin(options: { session?: Session; profile?: ProfileSnapshot | null; calls?: number; mode?: Session['mode'] } = {}) {
  const parent = options.session ?? store.createSession({ mode: options.mode ?? 'build', permissionMode: 'auto' });
  const user = message(parent.id, 'user'); history.accept(parent.id, user);
  const assistant: Message = { ...message(parent.id, 'assistant'), toolCalls: Array.from({ length: options.calls ?? 1 }, (_, i) => ({ id: `task-${i}`, name: 'task', args: { prompt: 'Inspect only' }, status: 'pending' })) };
  store.saveMessage(assistant);
  const input: CreateDelegation = { parentSessionId: parent.id, parentTurnId: user.id, parentMessageId: assistant.id, toolCallId: 'task-0', description: 'Inspect code', prompt: 'Inspect only', childSession: { workspace: parent.workspace, providerId: parent.providerId, model: parent.model, mode: parent.mode, permissionMode: parent.permissionMode }, profile: options.profile ?? null };
  return { parent, user, assistant, input };
}
function finish(child: Session) { store.saveMessage(message(child.id, 'assistant', 'Research complete.')); store.updateSession(child.id, { status: 'idle' }); history.seal(child.id); }
const records = () => store.db.prepare('SELECT * FROM delegations ORDER BY rowid').all();
function database() { return Object.fromEntries(['sessions', 'messages', 'session_profiles', 'delegations', 'history_checkpoints', 'queues'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
async function skill() {
  await mkdir(join(directory, '.lite/skills/research'), { recursive: true });
  await writeFile(join(directory, '.lite/profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'named', name: 'Named', tools: ['read_file'] }], skills: [{ id: 'research', name: 'Research' }] }));
  await writeFile(join(directory, '.lite/skills/research/SKILL.md'), 'EXACT PINNED RESEARCH\r\n');
  return (await resolveProfileChoice(directory, { profileId: null, skillIds: ['research'] })).snapshot!;
}
function reopen() { store.close(); store = new Store(join(directory, 'data')); history = new History(store); delegations = new Delegations(store, history); }

describe('durable foreground researcher storage', () => {
  it.each(['build', 'plan'] as const)('atomically creates hidden child, prompt, pin, history and exact parent link from %s', async mode => {
    const profile = await skill(), root = origin({ profile, mode }); const { child, user, delegation } = delegations.create(root.input);
    expect(child).toMatchObject({ mode, permissionMode: 'auto', workspace: root.parent.workspace, providerId: 'test', model: 'model' });
    expect(store.isChild(child.id)).toBe(true); expect(store.sessions().map(session => session.id)).toEqual([root.parent.id]);
    expect(store.messages(child.id)).toEqual([user]); expect(history.state(child.id).pendingRecovery).toBeUndefined();
    expect(store.profileSnapshot(child.id)).toEqual(profile); expect(store.toolGrants(child.id)).toEqual([]);
    expect(store.messages(root.parent.id)[1].toolCalls?.[0]).toMatchObject({ delegationId: delegation.id, status: 'running' });
    expect(delegations.list(root.parent.id)).toEqual([delegation]); expect(delegations.transcript(root.parent.id, delegation.id)).toMatchObject({ readOnly: true, lastEventId: 0, messages: [user] });
    await rm(join(directory, '.lite'), { recursive: true }); expect(store.profileSnapshot(child.id)).toEqual(profile);
  });
  it('never persists extra runtime credentials or grants from the child authority object', () => {
    const root = origin(); store.grantTool(root.parent.id, 'bash', 'root-only');
    const authority = { ...root.input.childSession, apiKey: 'SYNTHETIC_DO_NOT_PERSIST', system: 'SYNTHETIC_SYSTEM_AUTHORITY' };
    const created = delegations.create({ ...root.input, childSession: authority });
    expect(JSON.stringify(database())).not.toContain('SYNTHETIC_'); expect(store.toolGrants(created.child.id)).toEqual([]);
  });
  it.each(['child', 'pin', 'link', 'parent', 'checkpoint', 'prompt'])('rolls back every create write when %s persistence fails', async point => {
    const profile = await skill(), root = origin({ profile }), before = database();
    const trigger = point === 'child' ? 'BEFORE INSERT ON sessions' : point === 'pin' ? 'BEFORE INSERT ON session_profiles' : point === 'link' ? 'BEFORE INSERT ON delegations' : point === 'parent' ? `BEFORE UPDATE ON messages WHEN NEW.id='${root.assistant.id}'` : point === 'checkpoint' ? 'BEFORE INSERT ON history_checkpoints' : `BEFORE INSERT ON messages WHEN NEW.session_id!='${root.parent.id}'`;
    store.db.exec(`CREATE TRIGGER reject_create ${trigger} BEGIN SELECT RAISE(ABORT,'fixture create failure'); END;`);
    expect(() => delegations.create(root.input)).toThrow(/fixture create failure/); expect(database()).toEqual(before);
    store.db.exec('DROP TRIGGER reject_create'); const retry = delegations.create(root.input); expect(history.state(retry.child.id).pendingRecovery).toBeUndefined();
  });
  it('rolls back child and live checkpoint registration on actual deferred COMMIT failure', async () => {
    const profile = await skill(), root = origin({ profile }), before = database();
    store.db.exec('CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON delegations BEGIN INSERT INTO commit_child(id) VALUES(1); END;');
    expect(() => delegations.create(root.input)).toThrow(/FOREIGN KEY/); expect(database()).toEqual(before); expect(records()).toEqual([]);
    store.db.exec('DROP TRIGGER fail_commit'); const created = delegations.create(root.input); expect(history.state(created.child.id).pendingRecovery).toBeUndefined();
  });
  it.each(['parent', 'result', 'terminal', 'commit'])('settles parent call, one result and immutable terminal atomically across %s failure', point => {
    const root = origin(), { child, delegation } = delegations.create(root.input); finish(child); const before = database();
    if (point === 'commit') store.db.exec('CREATE TABLE settle_parent(id INTEGER PRIMARY KEY); CREATE TABLE settle_child(id INTEGER REFERENCES settle_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_settle AFTER UPDATE ON delegations BEGIN INSERT INTO settle_child(id) VALUES(1); END;');
    else store.db.exec(`CREATE TRIGGER fail_settle ${point === 'parent' ? `BEFORE UPDATE ON messages WHEN NEW.id='${root.assistant.id}'` : point === 'result' ? 'BEFORE INSERT ON messages' : 'BEFORE UPDATE ON delegations'} BEGIN SELECT RAISE(ABORT,'fixture settle failure'); END;`);
    expect(() => delegations.settle(delegation.id, 'completed', 'Report')).toThrow(); expect(database()).toEqual(before);
    store.db.exec('DROP TRIGGER fail_settle'); const first = delegations.settle(delegation.id, 'completed', 'Report'), second = delegations.settle(delegation.id, 'failed', 'Must not replace');
    expect(second).toEqual(first); expect(store.messages(root.parent.id).filter(message => message.role === 'tool')).toEqual([first.result]);
  });
  it.each(['failed', 'cancelled', 'timed_out', 'interrupted'] as const)('stores truthful bounded %s report markers exactly once', status => {
    const root = origin(), { child, delegation } = delegations.create(root.input); finish(child);
    const terminal = delegations.settle(delegation.id, status, '界'.repeat(40000));
    expect(terminal.delegation.status).toBe(status); expect(terminal.result.content.startsWith(terminal.delegation.error!)).toBe(true);
    expect(Buffer.byteLength(terminal.result.content)).toBeLessThanOrEqual(DELEGATION_LIMITS.outputBytes); expect(terminal.result.content).not.toContain('�'); expect(terminal.assistant.toolCalls?.[0].status).toBe('error');
  });
  it('requires cleanup/seal before settlement and prevents terminal transcript mutation', () => {
    const root = origin(), { child, delegation } = delegations.create(root.input);
    expect(() => delegations.settle(delegation.id, 'completed', 'Too early')).toThrow(/Seal/);
    finish(child); delegations.settle(delegation.id, 'completed', 'Report'); const before = delegations.transcript(root.parent.id, delegation.id);
    expect(() => store.saveMessage(message(child.id, 'assistant', 'Late overwrite'))).toThrow(/immutable/); expect(() => store.updateSession(child.id, { title: 'Changed' })).toThrow(/immutable/);
    expect(() => store.replaceMessages(child.id, [])).toThrow(/immutable/); expect(delegations.transcript(root.parent.id, delegation.id)).toEqual(before);
    expect(() => store.fork(child.id)).toThrow(); expect(() => store.deleteSession(child.id)).toThrow();
  });
  it('binds duplicate provider call IDs independently across accepted turns and merges same-batch task outcomes', () => {
    const root = origin({ calls: 2 }), first = delegations.create(root.input); finish(first.child); const a = delegations.settle(first.delegation.id, 'completed', 'First');
    const second = delegations.create({ ...root.input, toolCallId: 'task-1' }); finish(second.child); const b = delegations.settle(second.delegation.id, 'completed', 'Second');
    expect(b.assistant.toolCalls).toEqual([a.assistant.toolCalls![0], expect.objectContaining({ delegationId: second.delegation.id, output: 'Second' })]); history.seal(root.parent.id);
    const next = origin({ session: root.parent }); const third = delegations.create(next.input); finish(third.child); const c = delegations.settle(third.delegation.id, 'completed', 'Third');
    expect(c.result.toolCallId).toBe(a.result.toolCallId); expect(c.result.id).not.toBe(a.result.id); expect(delegations.list(root.parent.id)).toHaveLength(3);
  });
  it('restart interrupts once with one parent result and no replay or resurrection on repeated service construction', () => {
    const root = origin(), { child, delegation } = delegations.create(root.input); store.updateSession(child.id, { status: 'running' });
    const anotherService = new Delegations(store, history); expect(anotherService.get(root.parent.id, delegation.id).status).toBe('running');
    reopen(); const first = delegations.get(root.parent.id, delegation.id); expect(first.status).toBe('interrupted');
    expect(delegations.transcript(root.parent.id, delegation.id).session.status).toBe('idle'); expect(store.queue(child.id).paused).toBe(true);
    expect(store.messages(root.parent.id).filter(message => message.role === 'tool')).toHaveLength(1); const db = database();
    reopen(); expect(database()).toEqual(db); expect(delegations.get(root.parent.id, delegation.id)).toEqual(first);
  });
  it('restart settlement commit failure rolls back interruption and can recover exactly once after repair', () => {
    const root = origin(), { child, delegation } = delegations.create(root.input); store.updateSession(child.id, { status: 'running' });
    store.db.exec('CREATE TABLE restart_parent(id INTEGER PRIMARY KEY); CREATE TABLE restart_child(id INTEGER REFERENCES restart_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_restart AFTER UPDATE ON delegations BEGIN INSERT INTO restart_child(id) VALUES(1); END;');
    store.close(); store = new Store(join(directory, 'data')); history = new History(store);
    expect(() => new Delegations(store, history)).toThrow(/FOREIGN KEY/); expect(records()[0]).toMatchObject({ status: 'running' });
    expect(store.messages(root.parent.id).filter(message => message.role === 'tool')).toEqual([]); expect(store.session(child.id).status).toBe('running');
    store.db.exec('DROP TRIGGER fail_restart'); delegations = new Delegations(store, history); expect(delegations.get(root.parent.id, delegation.id).status).toBe('interrupted');
    expect(store.messages(root.parent.id).filter(message => message.role === 'tool')).toHaveLength(1);
  });
  it.each(['missing', 'corrupt'])('missing/corrupt child pin fails closed and restart quarantines it (%s)', async kind => {
    const profile = await skill(), root = origin({ profile }), { child, delegation } = delegations.create(root.input); finish(child);
    if (kind === 'missing') store.db.prepare('DELETE FROM session_profiles WHERE session_id=?').run(child.id);
    else store.db.prepare('UPDATE session_profiles SET data=? WHERE session_id=?').run('{', child.id);
    expect(() => delegations.get(root.parent.id, delegation.id)).toThrow(); expect(() => delegations.settle(delegation.id, 'completed', 'Unsafe')).toThrow();
    reopen(); expect(records()[0]).toMatchObject({ status: 'interrupted' }); expect(store.messages(root.parent.id).filter(message => message.role === 'tool')).toEqual([]); expect(() => delegations.transcript(root.parent.id, delegation.id)).toThrow();
  });
  it('quarantines missing origin on restart without injecting a result into another assistant group', () => {
    const root = origin(), { child, delegation } = delegations.create(root.input); store.db.prepare('DELETE FROM messages WHERE id=?').run(root.assistant.id);
    reopen(); expect(store.isChild(child.id)).toBe(true); expect(delegations.list(root.parent.id)).toEqual([]); expect(() => delegations.get(root.parent.id, delegation.id)).toThrow();
    expect(store.messages(root.parent.id).filter(message => message.role === 'tool')).toEqual([]); expect(records()[0]).toMatchObject({ status: 'interrupted' });
  });
  it('undo hides exact links and redo restores readonly access without changing the child', async () => {
    const root = origin(), { child, delegation } = delegations.create(root.input); finish(child); delegations.settle(delegation.id, 'completed', 'Report'); history.seal(root.parent.id);
    const terminal = delegations.transcript(root.parent.id, delegation.id); await history.undo(root.parent.id, history.state(root.parent.id).undoId!);
    expect(delegations.list(root.parent.id)).toEqual([]); expect(() => delegations.get(root.parent.id, delegation.id)).toThrow();
    await history.redo(root.parent.id, history.state(root.parent.id).redoId!); expect(delegations.transcript(root.parent.id, delegation.id)).toEqual(terminal);
  });
  it('fork/archive/import references are inert and deleting the root atomically deletes its private family only', () => {
    const root = origin(), { child, delegation } = delegations.create(root.input); finish(child); delegations.settle(delegation.id, 'completed', 'Report'); history.seal(root.parent.id);
    const fork = store.fork(root.parent.id), imported = store.createSession({ parentId: child.id });
    for (const original of store.messages(root.parent.id)) store.saveMessage({ ...original, id: randomUUID(), sessionId: imported.id });
    expect(store.isChild(imported.id)).toBe(false); expect(delegations.list(imported.id)).toEqual([]); expect(() => delegations.get(imported.id, delegation.id)).toThrow();
    expect(store.messages(fork.id).flatMap(message => message.toolCalls ?? []).every(call => call.delegationId === undefined)).toBe(true);
    const archive = history.compact(root.parent.id, [message(root.parent.id, 'system', 'Summary')]);
    expect(store.messages(archive.id).flatMap(message => message.toolCalls ?? []).every(call => call.delegationId === undefined)).toBe(true);
    store.deleteSession(root.parent.id); expect(() => store.session(child.id)).toThrow(); expect(records()).toEqual([]);
    expect(store.db.prepare('SELECT 1 FROM history_checkpoints WHERE session_id=?').get(child.id)).toBeUndefined(); expect(store.session(fork.id)).toBeDefined(); expect(store.session(imported.id)).toBeDefined(); expect(store.session(archive.id)).toBeDefined();
  });
  it('root family deletion rolls back on a real deferred COMMIT failure', () => {
    const root = origin(), created = delegations.create(root.input); finish(created.child); delegations.settle(created.delegation.id, 'completed', 'Report'); const before = database();
    store.db.exec('CREATE TABLE delete_parent(id INTEGER PRIMARY KEY); CREATE TABLE delete_child(id INTEGER REFERENCES delete_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_delete AFTER DELETE ON delegations BEGIN INSERT INTO delete_child(id) VALUES(1); END;');
    expect(() => store.deleteSession(root.parent.id)).toThrow(/FOREIGN KEY/); expect(database()).toEqual(before);
  });
  it('rejects named profile pins, wrong accepted turns, duplicate origins and child recursion before dispatch', async () => {
    await skill(); const named = (await resolveProfileChoice(directory, { profileId: 'named', skillIds: [] })).snapshot!; const root = origin();
    expect(() => delegations.create({ ...root.input, profile: named })).toThrow(/Named/);
    expect(() => delegations.create({ ...root.input, parentTurnId: randomUUID() })).toThrow(/accepted/);
    const created = delegations.create(root.input); expect(() => delegations.create(root.input)).toThrow();
    const childAssistant = { ...message(created.child.id, 'assistant'), toolCalls: [{ id: 'nested', name: 'task', args: { prompt: 'Nested' }, status: 'pending' as const }] }; store.saveMessage(childAssistant);
    expect(() => delegations.create({ ...root.input, parentSessionId: created.child.id, parentTurnId: created.user.id, parentMessageId: childAssistant.id, toolCallId: 'nested' })).toThrow(/cannot/);
    expect(records()).toHaveLength(1);
  });
  it('enforces bounded prompt, description and four launches per accepted parent turn', () => {
    const root = origin({ calls: 5 }); expect(() => delegations.create({ ...root.input, prompt: 'x'.repeat(DELEGATION_LIMITS.promptBytes + 1) })).toThrow(); expect(() => delegations.create({ ...root.input, description: 'x'.repeat(201) })).toThrow();
    for (let i = 0; i < 4; i++) { const created = delegations.create({ ...root.input, toolCallId: `task-${i}` }); finish(created.child); delegations.settle(created.delegation.id, 'completed', String(i)); }
    expect(() => delegations.create({ ...root.input, toolCallId: 'task-4' })).toThrow(/limit/); expect(records()).toHaveLength(4);
  });
});
