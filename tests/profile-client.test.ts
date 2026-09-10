// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/src/App';
import { ProfilePicker } from '../client/src/ProfilePicker';
import { applyEvent, reconcileSession } from '../client/src/api';
import type { ProfileCatalog, ProfileChoice, ProfileDetail } from '../shared/profiles';
import type { RunEvent, Session, SessionDetail, Settings } from '../shared/types';

const roots: Root[] = [];
function root() { const host = document.createElement('div'); document.body.append(host); const value = createRoot(host); roots.push(value); return value; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function el<T extends Element = HTMLElement>(selector: string): T { const found = document.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }
async function click(selector: string) { if (selector === '[aria-label="Project profiles"]' && !document.querySelector(selector)) await press('Settings'); await act(async () => el<HTMLButtonElement>(selector).click()); }
function button(label: string) { const found = [...document.querySelectorAll('button')].find(value => value.textContent?.trim() === label); expect(found, label).toBeDefined(); return found!; }
async function press(label: string) { await act(async () => button(label).click()); }
async function choose(id: string) { await act(async () => { const input = el<HTMLSelectElement>('[aria-label="Profile"]'); input.value = id; input.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function fill(value: string) { await act(async () => { const input = el<HTMLTextAreaElement>('#message-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function changeMode(mode: string) { await act(async () => { const select = el<HTMLSelectElement>('.mode-switch select'); if (select.disabled) return; select.value = mode; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
class EventSourceMock {
  static instances: EventSourceMock[] = [];
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: {data: string; lastEventId: string}) => void) | null = null;
  constructor(readonly url: string) { EventSourceMock.instances.push(this); }
  close() {}
  emit(event: RunEvent) { this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(event.id ?? '') }); }
}
const settings: Settings = { providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model', 'alternate'] }], defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace', permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: {} };
const catalog: ProfileCatalog = {
  revision: 'catalog-v1', profiles: [{ id: 'review', name: 'Review code', description: 'Review with narrow tools.', tools: ['read_file', 'grep'], defaultModel: { providerId: 'fixture', model: 'alternate' }, defaultMode: 'build', skills: ['testing'] }, { id: 'empty', name: 'No tools', tools: [] }],
  skills: [{ id: 'testing', name: 'Test carefully', description: 'Check regressions.' }, { id: 'docs', name: 'Document changes', description: 'Explain decisions.' }], diagnostics: [],
};
const choice: ProfileChoice = { profileId: 'review', skillIds: ['testing'] };
function profile(value: ProfileChoice = choice): ProfileDetail {
  return { active: value.profileId || value.skillIds.length ? { profileId: value.profileId, name: value.profileId ? 'Review code' : undefined, skillIds: value.skillIds, revision: 'pinned-v1', tools: value.profileId ? ['read_file', 'grep'] : null } : null,
    pinned: value.profileId || value.skillIds.length ? { instructions: value.profileId ? 'Review the implementation carefully.' : '', skills: value.skillIds.map(id => ({ id, name: catalog.skills.find(skill => skill.id === id)?.name || id, description: '', body: `Instructions for ${id}`, path: `.lite/skills/${id}/SKILL.md`, hash: id })), sources: [] } : null,
    source: { status: value.profileId || value.skillIds.length ? 'current' : 'inactive' }, diagnostics: [] };
}
function session(id: string, patch: Partial<Session> = {}): Session { return { id, title: `Session ${id}`, workspace: '/workspace', providerId: 'fixture', model: 'model', mode: 'plan', permissionMode: 'ask', status: 'idle', archived: false, createdAt: 1, updatedAt: 1, configRevision: 3, ...patch }; }
function detail(id: string, patch: Partial<Session> = {}): SessionDetail { return { session: session(id, patch), messages: [], todos: [], permissions: [], questions: [], queue: { items: [], paused: false }, lastEventId: 10 }; }
function server(initial: SessionDetail[] = [detail('a'), detail('b')]) {
  const details = new Map(initial.map(item => [item.session.id, structuredClone(item)]));
  const calls: {path: string; method: string; body: any}[] = [];
  let currentCatalog = structuredClone(catalog), currentProfile = profile({ profileId: null, skillIds: [] });
  let intercept: ((path: string, method: string, body: any) => unknown | Promise<unknown>) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input).replace(/^\/api/, ''), method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    const custom = intercept?.(path, method, body);
    let data: unknown = custom === undefined ? undefined : await custom;
    if (custom === undefined) {
      if (path === '/settings') data = settings;
      else if (path.startsWith('/sessions?')) data = { sessions: [...details.values()].map(item => item.session) };
      else if (path.startsWith('/commands?')) data = { commands: [] };
      else if (path.startsWith('/models?')) data = { models: [] };
      else if (path.startsWith('/profiles?')) data = currentCatalog;
      else if (path === '/profiles/preview') data = profile(body.choice);
      else if (path.endsWith('/profile') && method === 'GET') data = currentProfile;
      else if (/^\/sessions\/[^/]+$/.test(path) && method === 'GET') data = details.get(path.split('/')[2]);
      else if (path.endsWith('/profile') && method === 'POST') {
        const item = details.get(path.split('/')[2])!;
        if (body.expectedConfigRevision !== item.session.configRevision) throw new Error('Session configuration changed (409).');
        currentProfile = profile(body.choice);
        item.session = { ...item.session, ...body.selection, profile: currentProfile.active ?? undefined, configRevision: item.session.configRevision! + 1 };
        item.queue = { ...item.queue!, paused: true, reason: 'Project profile changed.' }; item.lastEventId!++;
        data = { session: item.session, queue: item.queue };
      } else if (method === 'PATCH') {
        const item = details.get(path.split('/')[2])!;
        item.session = { ...item.session, ...body, configRevision: item.session.configRevision! + 1 }; data = item.session;
      } else if (path === '/sessions' && method === 'POST') {
        const item = detail('new', { ...body, profile: body.profile ? profile(body.profile).active ?? undefined : undefined }); details.set('new', item); data = item.session;
      } else if (path.endsWith('/messages') && method === 'POST') data = {};
      else throw new Error(`Unexpected ${method} ${path}`);
    }
    const snapshot = JSON.stringify(data);
    return { ok: true, status: 200, json: async () => JSON.parse(snapshot) };
  }));
  return { details, calls, set catalog(value: ProfileCatalog) { currentCatalog = value; }, set profile(value: ProfileDetail) { currentProfile = value; }, set intercept(value: typeof intercept) { intercept = value; } };
}
async function mount() { await act(async () => root().render(createElement(App))); }
async function picker(props: Partial<Parameters<typeof ProfilePicker>[0]> = {}) {
  const onApply = vi.fn<Parameters<typeof ProfilePicker>[0]['onApply']>(async () => {}), onClose = vi.fn();
  await act(async () => root().render(createElement(ProfilePicker, { workspace: '/workspace', sessionId: null, selection: { providerId: 'fixture', model: 'model', mode: 'plan', permissionMode: 'ask' }, onApply, onClose, ...props })));
  return { onApply, onClose };
}
beforeEach(() => {
  const dom = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', dom.window.localStorage); localStorage.clear(); document.body.innerHTML = '';
  window.history.replaceState(null, '', '/#session/a'); EventSourceMock.instances = [];
  vi.stubGlobal('EventSource', EventSourceMock); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => { await act(async () => { roots.splice(0).forEach(value => value.unmount()); }); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit profile picker', () => {
  it('does not activate manifest presence or select recommendations, and previews before applying', async () => {
    const api = server(), panel = await picker();
    expect(el<HTMLSelectElement>('[aria-label="Profile"]').value).toBe('');
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([]);
    await choose('review');
    expect(el<HTMLInputElement>('[aria-label="Test carefully"]').checked).toBe(false);
    expect(document.body.textContent).toContain('Recommended · optional');
    expect(document.body.textContent).toContain('Review the implementation carefully.');
    expect(el('[aria-label="Profile tool policy"]').textContent).toContain('Excluded: glob, web_fetch, write_file, edit_file, bash, todo_read, todo_write');
    await press('Use profile');
    expect(panel.onApply).toHaveBeenCalledExactlyOnceWith({ profileId: 'review', skillIds: [], catalogRevision: 'catalog-v1' }, undefined);
  });
  it('initializes active skills, clears them on a new profile, and supports unrestricted skills-only', async () => {
    server(); const panel = await picker({ initialChoice: choice });
    expect(el<HTMLInputElement>('[aria-label="Test carefully"]').checked).toBe(true);
    await choose('empty'); expect(el<HTMLInputElement>('[aria-label="Test carefully"]').checked).toBe(false);
    expect(document.body.textContent).toContain('No operational tools');
    await choose(''); await click('[aria-label="Document changes"]');
    expect(document.body.textContent).toContain('Selecting skills alone does not restrict tools');
    await press('Use profile');
    expect(panel.onApply).toHaveBeenCalledExactlyOnceWith({ profileId: null, skillIds: ['docs'], catalogRevision: 'catalog-v1' }, undefined);
  });
  it('shows Plan to Build before explicit Apply defaults and never includes permission mode', async () => {
    server(); const panel = await picker(); await choose('review');
    expect(document.body.textContent).toContain('Apply defaults changes Plan → Build');
    await press('Apply defaults');
    expect(panel.onApply).toHaveBeenCalledExactlyOnceWith({ profileId: 'review', skillIds: [], catalogRevision: 'catalog-v1' }, { providerId: 'fixture', model: 'alternate', mode: 'build' });
  });
  it('keeps missing pinned instructions and diagnostics visible and clears without a catalog revision', async () => {
    const api = server(); api.catalog = { revision: 'invalid', profiles: [], skills: [], diagnostics: [{ path: '.lite/profiles.json', code: 'invalid', message: 'Invalid manifest <script>never()</script>' }] };
    api.profile = { ...profile(), source: { status: 'missing' } };
    api.intercept = path => { if (path === '/profiles/preview') return Promise.reject(new Error('Source unavailable')); };
    const panel = await picker({ sessionId: 'a', initialChoice: choice });
    expect(document.body.textContent).toContain('Project source is missing');
    expect(document.body.textContent).toContain('Review the implementation carefully.');
    expect(document.body.textContent).toContain('Invalid manifest <script>never()</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(button('Use profile').disabled).toBe(true);
    await press('Use default'); expect(panel.onApply).toHaveBeenCalledExactlyOnceWith({ profileId: null, skillIds: [] }, undefined);
  });
  it('reloads only the active explicit IDs with the current catalog revision', async () => {
    const api = server(); api.profile = { ...profile(), source: { status: 'changed' } };
    const panel = await picker({ sessionId: 'a', initialChoice: choice });
    expect(document.body.textContent).toContain('Project source is changed');
    await press('Reload profile'); expect(panel.onApply).toHaveBeenCalledExactlyOnceWith({ ...choice, catalogRevision: 'catalog-v1' }, undefined);
  });
  it('ignores an old preview after selecting a different profile and blocks activation during preview', async () => {
    const api = server(), wait = deferred<ProfileDetail>();
    api.intercept = (path, _, body) => path === '/profiles/preview' && body.choice.profileId === 'review' ? wait.promise : undefined;
    const panel = await picker(); await choose('review');
    expect(button('Use profile').disabled).toBe(true); await choose('empty');
    await act(async () => wait.resolve({ ...profile(), pinned: { instructions: 'OLD PREVIEW SHOULD NOT APPEAR', skills: [], sources: [] } }));
    expect(document.body.textContent).not.toContain('OLD PREVIEW');
    await press('Use profile'); expect(panel.onApply.mock.calls[0]?.[0]).toEqual({ profileId: 'empty', skillIds: [], catalogRevision: 'catalog-v1' });
  });
  it('caps explicit skills at eight, renders names inertly, and suppresses same-tick duplicate apply', async () => {
    const api = server(); api.catalog = { ...catalog, skills: Array.from({ length: 9 }, (_, i) => ({ id: `skill-${i}`, name: i === 8 ? '<img src=x onerror=bad()>' : `Skill ${i}`, description: '' })) };
    const wait = deferred<void>(), onApply = vi.fn(() => wait.promise); await picker({ onApply });
    for (let i = 0; i < 8; i++) await click(`[aria-label="Skill ${i}"]`);
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)?.disabled).toBe(true);
    expect(document.querySelector('img')).toBeNull();
    await act(async () => { button('Use profile').click(); button('Use profile').click(); }); expect(onApply).toHaveBeenCalledTimes(1);
    await act(async () => wait.resolve());
  });
});

describe('session profile integration', () => {
  it('preserves existing selections and composer attachments, captures revision, refreshes authoritative queue', async () => {
    const api = server(); localStorage.setItem('lite:draft:v1:a', JSON.stringify({ text: 'Keep this draft', attachments: [{ name: 'notes.txt', content: 'Important context' }] }));
    await mount(); await click('[aria-label="Project profiles"]'); await choose('review'); await click('[aria-label="Test carefully"]'); await press('Use profile');
    const write = api.calls.find(call => call.path === '/sessions/a/profile' && call.method === 'POST')!;
    expect(write.body).toEqual({ expectedConfigRevision: 3, choice: { profileId: 'review', skillIds: ['testing'], catalogRevision: 'catalog-v1' } });
    expect(api.details.get('a')!.session).toMatchObject({ mode: 'plan', model: 'model', permissionMode: 'ask', configRevision: 4 });
    expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Keep this draft'); expect(document.body.textContent).toContain('notes.txt');
    expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull();
    expect(api.calls.filter(call => call.path === '/sessions/a' && call.method === 'GET').length).toBeGreaterThan(1);
    expect(api.details.get('a')?.queue?.paused).toBe(true);
  });
  it('Apply defaults intentionally changes model and mode but keeps automatic permissions unchanged', async () => {
    const api = server([detail('a', { permissionMode: 'auto' })]); await mount(); await click('[aria-label="Project profiles"]'); await choose('review'); await press('Apply defaults');
    expect(api.details.get('a')!.session).toMatchObject({ model: 'alternate', mode: 'build', permissionMode: 'auto' });
    expect(el<HTMLSelectElement>('.mode-switch select').selectedOptions[0].textContent).toBe('Build'); expect(el('.model-trigger').textContent).toContain('alternate');
    expect(api.calls.find(call => call.path === '/sessions/a/profile' && call.method === 'POST')!.body.selection).not.toHaveProperty('permissionMode');
  });
  it('retains dialog-open revision across external changes and requires explicit reopen after conflict', async () => {
    const api = server(); await mount(); await click('[aria-label="Project profiles"]'); await choose('review');
    const current = api.details.get('a')!; current.session = { ...current.session, model: 'external', configRevision: 4 }; current.lastEventId = 11;
    await act(async () => EventSourceMock.instances[0].emit({ id: 11, sessionId: 'a', type: 'session', data: current.session }));
    await press('Use profile');
    expect(api.calls.find(call => call.path === '/sessions/a/profile' && call.method === 'POST')!.body.expectedConfigRevision).toBe(3);
    expect(document.body.textContent).toContain('Session configuration changed (409)');
    expect(document.body.textContent).toContain('Close and reopen');
    expect(el<HTMLTextAreaElement>('#message-input').value).toBe('');
    await click('[aria-label="Close dialog"]'); await click('[aria-label="Project profiles"]'); await choose('review'); await press('Use profile');
    expect(api.calls.filter(call => call.path === '/sessions/a/profile' && call.method === 'POST').at(-1)!.body.expectedConfigRevision).toBe(4);
    expect(api.details.get('a')!.session.model).toBe('external');
  });
  it.each(['success', 'failure'] as const)('does not overwrite a different session or its draft on late profile %s', async result => {
    const api = server(), wait = deferred<unknown>(); api.intercept = (path, method) => path === '/sessions/a/profile' && method === 'POST' ? wait.promise : undefined;
    await mount(); await click('[aria-label="Project profiles"]'); await choose('review'); await press('Use profile');
    await click('[aria-label="Close dialog"]'); await click('.session-link[title="Session b"]'); await fill('B draft');
    await act(async () => result === 'success' ? wait.resolve({ session: session('a', { profile: profile().active!, configRevision: 4 }), queue: { items: [], paused: true } }) : wait.reject(new Error('Old request failed')));
    expect(el('.topbar-title').textContent).toBe('Session b'); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('B draft');
    expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull(); expect(document.querySelector('.global-alert')).toBeNull();
  });
  it('disables configuration during profile apply and sends selection PATCH with the current revision', async () => {
    const api = server(), wait = deferred<unknown>(); api.intercept = (path, method) => path === '/sessions/a/profile' && method === 'POST' ? wait.promise : undefined;
    await mount(); await click('[aria-label="Project profiles"]'); await choose('review'); await press('Use profile');
    expect(el<HTMLButtonElement>('.mode-switch select').disabled).toBe(true); expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull();
    await click('[aria-label="Close dialog"]'); await changeMode('build'); expect(api.calls.some(call => call.method === 'PATCH')).toBe(false);
    const item = api.details.get('a')!; item.session.configRevision = 4;
    await act(async () => wait.resolve({ session: item.session, queue: item.queue }));
    await changeMode('build'); expect(api.calls.find(call => call.method === 'PATCH')!.body.expectedConfigRevision).toBe(4);
  });
  it('stages welcome choice until first send, preserves drafts, and never includes recommended skills', async () => {
    window.history.replaceState(null, '', '/'); const api = server(); await mount(); await fill('First message');
    await click('[aria-label="Project profiles"]'); await choose('review'); await press('Use profile');
    expect(api.calls.filter(call => call.path === '/sessions' && call.method === 'POST')).toEqual([]);
    expect(el<HTMLTextAreaElement>('#message-input').value).toBe('First message'); expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull();
    await click('[aria-label="Send message"]');
    expect(api.calls.find(call => call.path === '/sessions' && call.method === 'POST')!.body).toMatchObject({ profile: { profileId: 'review', skillIds: [], catalogRevision: 'catalog-v1' }, mode: 'build', model: 'model', permissionMode: 'ask' });
  });
  it('locks pending created-session choice after a failed first message and retries the same session', async () => {
    window.history.replaceState(null, '', '/'); const api = server(); let fail = true;
    api.intercept = path => path === '/sessions/new/messages' && fail ? Promise.reject(new Error('Send failed')) : undefined;
    await mount(); await fill('Retry this'); await click('[aria-label="Project profiles"]'); await choose('review'); await press('Use profile'); await click('[aria-label="Send message"]');
    expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull(); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Retry this');
    fail = false; await click('[aria-label="Send message"]');
    expect(api.calls.filter(call => call.path === '/sessions' && call.method === 'POST')).toHaveLength(1);
    expect(api.calls.filter(call => call.path === '/sessions/new/messages')).toHaveLength(2);
    expect(api.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });
  it.each(['running', 'waiting'] as const)('disables profile and selection controls while %s without touching drafts', async status => {
    server([detail('a', { status })]); await mount(); await fill('Next thought');
    expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull(); expect(el<HTMLButtonElement>('.model-trigger').disabled).toBe(true);
    expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Next thought');
  });
  it('preserves a pending question answer and composer attachments when a profile dialog is blocked by a live run', async () => {
    const item = detail('a', { status: 'waiting' });
    item.questions = [{ id: 'question-a', sessionId: 'a', turnId: 'turn-a', messageId: 'assistant-a', toolCallId: 'ask-a', question: 'Which database?', options: [{ id: 'sqlite', label: 'SQLite' }, { id: 'postgres', label: 'PostgreSQL' }], createdAt: 1 }];
    const api = server([item]);
    localStorage.setItem('lite:draft:v1:a', JSON.stringify({ text: 'Keep my next prompt', attachments: [{ name: 'draft.txt', content: 'keep' }] }));
    await mount(); await click('.question-option input[value="sqlite"]'); await click('[aria-label="Project profiles"]');
    expect(document.querySelector('[aria-label="Profile"]')).toBeNull();
    expect(el<HTMLInputElement>('.question-option input[value="sqlite"]').checked).toBe(true);
    expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Keep my next prompt'); expect(document.body.textContent).toContain('draft.txt');
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('discards late dialog catalog and preview loads across navigation without reopening the old session', async () => {
    const api = server(), wait = deferred<ProfileCatalog>();
    api.intercept = path => path.startsWith('/profiles?') ? wait.promise : undefined;
    await mount(); await click('[aria-label="Project profiles"]'); await click('[aria-label="Close dialog"]'); await click('.session-link[title="Session b"]'); await fill('B stays here');
    await act(async () => wait.resolve(catalog));
    expect(document.querySelector('[aria-label="Profile"]')).toBeNull(); expect(el('.topbar-title').textContent).toBe('Session b'); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('B stays here');
  });
  it('retains the accepted profile response if its authoritative refresh fails', async () => {
    const api = server(); await mount(); await click('[aria-label="Project profiles"]'); await choose('review');
    api.intercept = (path, method) => path === '/sessions/a' && method === 'GET' ? Promise.reject(new Error('offline')) : undefined;
    await press('Use profile');
    expect(document.querySelector('.composer [aria-label="Project profiles"]')).toBeNull(); expect(document.body.textContent).toContain('Could not refresh the session');
    expect(el<HTMLSelectElement>('.mode-switch select').selectedOptions[0].textContent).toBe('Plan');
  });
  it('clears an omitted profile from full revision-bearing SSE but preserves it for legacy partial status events', () => {
    const state = { ...detail('a'), session: session('a', { profile: profile().active!, configRevision: 4 }) };
    expect(applyEvent(state, { id: 11, sessionId: 'a', type: 'session', data: { status: 'running' } }).session.profile).toEqual(state.session.profile);
    const cleared = applyEvent(state, { id: 11, sessionId: 'a', type: 'session', data: session('a', { configRevision: 5 }) });
    expect(cleared.session.profile).toBeUndefined(); expect(cleared.session.configRevision).toBe(5);
  });
  it('never revives old profile configuration through a stale snapshot or newer-cursor older-config event', () => {
    const current = session('a', { profile: profile().active!, configRevision: 4 });
    expect(reconcileSession(current, session('a', { configRevision: 3 })).profile).toEqual(current.profile);
    const state = { ...detail('a'), session: current };
    const result = applyEvent(state, { id: 11, sessionId: 'a', type: 'session', data: session('a', { configRevision: 3, mode: 'build' }) });
    expect(result.session).toMatchObject({ configRevision: 4, mode: 'plan', profile: current.profile }); expect(result.lastEventId).toBe(11);
  });
});
