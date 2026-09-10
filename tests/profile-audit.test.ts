import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import * as profiles from '../server/profiles.js';
import type { ProfileChoice, Session } from '../shared/types.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean) => { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for profile audit'); await new Promise(resolve => setTimeout(resolve, 5)); } };

describe('independent profile acceptance and visibility audit', () => {
  let directory: string, store: Store, server: Server, providerServer: Server, url: string, runner: ReturnType<typeof createApp>['runner'], selected: ProfileChoice;
  let calls: unknown[];
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-profile-audit-'))); calls = [];
    await mkdir(join(directory, '.speedrail/skills/check'), { recursive: true });
    await writeFile(join(directory, '.speedrail/profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'review', name: 'Review', tools: ['read_file'], instructions: 'PRIVATE_PINNED_PROFILE', defaultModel: { providerId: 'primary', model: 'review-model' } }], skills: [{ id: 'check', name: 'Check' }] }));
    await writeFile(join(directory, '.speedrail/skills/check/SKILL.md'), 'PRIVATE_PINNED_SKILL');
    providerServer = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); calls.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); });
    const baseUrl = await listen(providerServer); store = new Store(join(directory, 'data')); store.saveSettings({ workspace: directory, providers: [{ id: 'primary', name: 'Primary', kind: 'openai', baseUrl }, { id: 'secondary', name: 'Secondary', kind: 'openai', baseUrl }], defaultProvider: 'primary', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
    selected = { profileId: 'review', skillIds: ['check'], catalogRevision: (await profiles.readProfileCatalog(directory)).revision };
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); vi.restoreAllMocks(); await close(server); await close(providerServer); store.close(); await rm(directory, { recursive: true, force: true }); });
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async () => { const response = await api('/sessions', { profile: selected }); expect(response.status).toBe(201); return response.body as Session; };

  it.each(['missing', 'malformed'])('rejects a %s pinned snapshot before accepting any user turn or checkpoint', async kind => {
    const session = await create(), previous = store.session(session.id), queue = store.queue(session.id), eventId = store.latestEventId(session.id);
    if (kind === 'missing') store.db.prepare('DELETE FROM session_profiles WHERE session_id=?').run(session.id);
    else store.db.prepare('UPDATE session_profiles SET data=? WHERE session_id=?').run('{', session.id);
    const response = await api(`/sessions/${session.id}/messages`, { content: 'Must not be accepted' }); await runner.whenIdle();
    expect(response.status).toBe(409); expect(store.messages(session.id)).toEqual([]); expect(runner.history.hasCheckpoints(session.id)).toBe(false);
    expect(store.session(session.id)).toEqual(previous); expect(store.queue(session.id)).toEqual(queue); expect(store.latestEventId(session.id)).toBe(eventId); expect(calls).toEqual([]);
  });

  it('queued work remains queued when the pinned snapshot is unavailable at acceptance', async () => {
    const session = await create(); const queued = runner.enqueue(session.id, 'Do not dequeue a broken profile');
    store.db.prepare('DELETE FROM session_profiles WHERE session_id=?').run(session.id);
    runner.resumeQueue(session.id); await runner.whenIdle();
    expect(store.queue(session.id).items).toEqual(queued.items); expect(store.queue(session.id).paused).toBe(true); expect(store.messages(session.id)).toEqual([]); expect(runner.history.hasCheckpoints(session.id)).toBe(false); expect(calls).toEqual([]);
  });

  it('uses the validated profile captured at acceptance instead of rereading the pin after accepting work', async () => {
    const session = await create(), lookup = store.profileSnapshot.bind(store);
    const getter = vi.spyOn(store, 'profileSnapshot').mockImplementationOnce(lookup).mockImplementation(() => { throw new Error('A later profile lookup must not happen inside this accepted turn'); });
    runner.start(session.id, 'Use captured context'); await runner.whenIdle();
    expect(getter).toHaveBeenCalledOnce(); expect(calls).toHaveLength(1); expect(store.session(session.id).status).toBe('idle');
    expect(JSON.stringify(calls[0])).toContain('PRIVATE_PINNED_PROFILE'); expect(JSON.stringify(calls[0])).toContain('PRIVATE_PINNED_SKILL');
  });

  it('ordinary API detail, lists, export and durable events never expose pinned instructions; import stays inert', async () => {
    const session = await create(); runner.start(session.id, 'Work'); await runner.whenIdle();
    for (const route of ['/sessions', `/sessions/${session.id}`, `/sessions/${session.id}/export`]) {
      const response = await api(route); expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_PINNED_|SKILL\.md/);
    }
    expect(JSON.stringify(store.events(session.id, 0))).not.toContain('PRIVATE_PINNED_');
    const explicit = await api(`/sessions/${session.id}/profile`); expect(JSON.stringify(explicit.body)).toContain('PRIVATE_PINNED_PROFILE'); expect(JSON.stringify(explicit.body)).toContain('PRIVATE_PINNED_SKILL');
    const exported = await api(`/sessions/${session.id}/export`), count = calls.length;
    const imported = await api('/sessions/import', exported.body); expect(imported.status).toBe(201); expect(imported.body.profile).toBeUndefined(); expect(store.profileSnapshot(imported.body.id)).toBeNull(); expect(calls).toHaveLength(count);
  });

  it.each([{ providerId: '', model: '' }, { providerId: '' }, { model: '' }])('rejects explicitly empty profile provider/model overrides %j', async pair => {
    await writeFile(join(directory, '.speedrail/profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'writer', name: 'Writer', tools: ['read_file'] }], skills: [] }));
    const choice = { profileId: 'writer', skillIds: [], catalogRevision: (await profiles.readProfileCatalog(directory)).revision };
    expect((await api('/sessions', { profile: choice, ...pair })).status).toBe(400); expect(store.sessions()).toEqual([]);
  });

  it('a provider removed during asynchronous profile creation is validated again before any commit', async () => {
    const resolved = await profiles.resolveProfileChoice(directory, selected); let release!: (value: profiles.ResolvedProfile) => void;
    vi.spyOn(profiles, 'resolveProfileChoice').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = api('/sessions', { profile: selected }); await until(() => Boolean(release));
    const remaining = store.settings().providers.filter(provider => provider.id === 'secondary');
    expect((await api('/settings', { providers: remaining, defaultProvider: 'secondary', defaultModel: 'other' }, 'PATCH')).status).toBe(200);
    release(resolved); expect((await pending).status).toBe(400); expect(store.sessions()).toEqual([]); expect(store.db.prepare('SELECT COUNT(*) AS n FROM session_profiles').get()).toMatchObject({ n: 0 }); expect(calls).toEqual([]);
  });

  it('cancelled postcommit event delivery does not turn successful activation into an unchanged-state error', async () => {
    const session = store.createSession(); vi.spyOn(console, 'error').mockImplementation(() => {}); let cancelled = false;
    const unsubscribe = runner.bus.subscribe(session.id, event => {
      if (event.type === 'session' && event.data.configRevision === 1) { cancelled = true; runner.cancel(session.id); throw new Error('Disconnected subscriber after cancelling'); }
    });
    try {
      const response = await api(`/sessions/${session.id}/profile`, { expectedConfigRevision: 0, choice: selected });
      expect(cancelled).toBe(true); expect(response.status).toBe(200); expect(response.body.session.configRevision).toBe(1); expect(store.profileSnapshot(session.id)?.active.profileId).toBe('review'); expect(calls).toEqual([]);
    } finally { unsubscribe(); }
  });

  it('a source changed before delayed resolution completes cannot be activated under an older catalog revision', async () => {
    const session = store.createSession(); let release!: () => void;
    const resolve = profiles.resolveProfileChoice;
    vi.spyOn(profiles, 'resolveProfileChoice').mockImplementation((workspace, choice, signal) => new Promise((done, reject) => { release = () => { void resolve(workspace, choice, signal).then(done, reject); }; }));
    const pending = api(`/sessions/${session.id}/profile`, { expectedConfigRevision: 0, choice: selected }); await until(() => Boolean(release));
    await writeFile(join(directory, '.speedrail/skills/check/SKILL.md'), 'CHANGED_PINNED_SKILL'); release();
    expect((await pending).status).toBe(409); expect(store.session(session.id)).toEqual(session); expect(store.profileSnapshot(session.id)).toBeNull(); expect(calls).toEqual([]);
  });
});
