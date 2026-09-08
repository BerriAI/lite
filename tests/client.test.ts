// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/src/App';
import { useSessionDraft, type ComposerDraft } from '../client/src/api';
import type { QueueState, RunEvent, Session, SessionDetail, Settings } from '../shared/types';

const draftKey = (id: string) => `lite:draft:v1:${id}`;
const stored = (id: string): ComposerDraft | null => JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null');
const roots: Root[] = [];

function root() {
  const container = document.createElement('div'); document.body.append(container);
  const value = createRoot(container); roots.push(value); return value;
}
async function hook(id: string | null) {
  let value!: ReturnType<typeof useSessionDraft>;
  function Probe({ sessionId }: { sessionId: string | null }) { value = useSessionDraft(sessionId); return null; }
  const mounted = root();
  const render = async (sessionId: string | null) => { await act(async () => mounted.render(createElement(Probe, { sessionId }))); };
  await render(id);
  return { get current() { return value; }, render };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function element<T extends Element = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  expect(result, `Missing ${selector}`).not.toBeNull(); return result!;
}
async function click(selector: string) { await act(async () => element<HTMLButtonElement>(selector).click()); }
async function clickText(label: string, scope = document.body) {
  const button = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  expect(button, `Missing button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

class TestEventSource {
  static instances: TestEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(event: RunEvent) {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(event.id ?? '') });
  }
}

const settings: Settings = {
  providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model'] }],
  defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace',
  permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: {},
};
function session(id: string, overrides: Partial<Session> = {}): Session {
  return { id, title: `Session ${id}`, workspace: `/workspace-${id}`, providerId: 'fixture', model: 'model', mode: 'build', permissionMode: 'ask', createdAt: 1, updatedAt: 1, status: 'idle', archived: false, ...overrides };
}
function detail(id: string, overrides: Partial<SessionDetail> = {}): SessionDetail {
  return { session: session(id), messages: [{ id: `history-${id}`, sessionId: id, role: 'user', content: `History ${id}`, createdAt: 1 }], todos: [], permissions: [], queue: { items: [], paused: false }, lastEventId: 10, ...overrides };
}
function appServer(initial: SessionDetail[]) {
  const details = new Map(initial.map(value => [value.session.id, value]));
  const requests: string[] = [];
  let mutation: ((path: string, method: string) => unknown | Promise<unknown>) | undefined;
  let offline = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? 'GET'; requests.push(`${method} ${path}`);
    let data: unknown;
    if (method !== 'GET') {
      if (!mutation) throw new Error(`Unexpected ${method} ${path}`);
      data = await mutation(path, method);
    } else if (path === '/api/settings') data = settings;
    else if (path.startsWith('/api/sessions?')) data = { sessions: [...details.values()].map(value => value.session) };
    else if (path.startsWith('/api/commands?')) data = { commands: [] };
    else if (path.startsWith('/api/sessions/')) {
      if (offline) throw new Error('offline');
      data = details.get(path.split('/').at(-1)!);
      if (!data) throw new Error(`Missing fixture for ${path}`);
    } else throw new Error(`Unexpected ${method} ${path}`);
    // Capture each snapshot at response time; mutations cannot mutate an already-returned response.
    const response = JSON.stringify(data);
    return { ok: true, status: 200, json: async () => JSON.parse(response) };
  }));
  return { details, requests, set mutation(value: typeof mutation) { mutation = value; }, set offline(value: boolean) { offline = value; } };
}
async function mountApp() {
  await act(async () => root().render(createElement(App)));
  expect(document.querySelector('#message-input')).not.toBeNull();
}

beforeEach(() => {
  // Node 26 exposes its own optional localStorage; use the actual JSDOM origin store.
  const dom = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', dom.window.localStorage);
  document.body.innerHTML = ''; localStorage.clear();
  window.history.replaceState(null, '', '/#session/a');
  TestEventSource.instances = [];
  vi.stubGlobal('EventSource', TestEventSource);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  await act(async () => { for (const mounted of roots.splice(0)) mounted.unmount(); });
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('session draft persistence', () => {
  it('does not remove another tab’s newer saved draft when an older submission completes', async () => {
    const first = await hook('a');
    await act(async () => first.current.setText('original draft'));
    // Separate roots have separate hook refs, just like two tabs sharing localStorage.
    const second = await hook('a'), submitted = first.current.draft;
    await act(async () => second.current.setText('new work from another tab'));
    await act(async () => first.current.clearSubmitted(submitted));
    expect(first.current.draft.text).toBe('');
    expect(second.current.draft.text).toBe('new work from another tab');
    expect(stored('a')?.text).toBe('new work from another tab');
    expect(first.current.notice).toContain('different saved draft');
    const reloaded = await hook('a');
    expect(reloaded.current.draft.text).toBe('new work from another tab');
  });

  it('clears a submitted saved draft but preserves newer same-tab edits and other sessions', async () => {
    const tab = await hook('a');
    await act(async () => tab.current.setText('first version'));
    const older = tab.current.draft;
    await act(async () => tab.current.setText('second version'));
    await act(async () => tab.current.clearSubmitted(older));
    expect(stored('a')?.text).toBe('second version');
    const accepted = tab.current.draft, clear = tab.current.clearSubmitted;
    await tab.render('b');
    await act(async () => tab.current.setText('keep session b'));
    await act(async () => clear(accepted));
    expect(stored('a')).toBeNull();
    expect(stored('b')?.text).toBe('keep session b');
    await tab.render('a'); expect(tab.current.draft.text).toBe('');
  });

  it('restores attachments on reload and keeps unsaved work during storage failures', async () => {
    const tab = await hook('a');
    await act(async () => tab.current.setAttachments([{ name: 'notes.txt', content: 'context' }]));
    const reloaded = await hook('a');
    expect(reloaded.current.draft.attachments).toEqual([{ name: 'notes.txt', content: 'context' }]);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await act(async () => tab.current.setText('keep in memory'));
    expect(tab.current.notice).toContain('not saved for reload');
    await tab.render('b'); await tab.render('a');
    expect(tab.current.draft.text).toBe('keep in memory');
    const warning = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(warning);
    expect(warning.defaultPrevented).toBe(true);
    write.mockRestore();
    await act(async () => tab.current.clearSubmitted(tab.current.draft));
    expect(stored('a')).toBeNull();
  });

  it('warns instead of deleting unknown data when restoring or removing storage fails', async () => {
    localStorage.setItem(draftKey('a'), '{invalid saved data');
    const tab = await hook('a');
    expect(tab.current.notice).toContain('could not be restored');
    await act(async () => tab.current.clearSubmitted(tab.current.draft));
    expect(localStorage.getItem(draftKey('a'))).toBe('{invalid saved data');
    await act(async () => tab.current.setText('send me'));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    await act(async () => tab.current.clearSubmitted(tab.current.draft));
    expect(stored('a')?.text).toBe('send me');
    expect(tab.current.notice).toContain('saved draft could not be cleared');
  });

  it('removes deleted-session cache and storage so it no longer consumes the aggregate budget', async () => {
    const tab = await hook('a');
    const attachments = [{ name: 'context.txt', content: 'x'.repeat(450_000) }];
    await act(async () => tab.current.setAttachments(attachments));
    await tab.render('b'); await act(async () => tab.current.setAttachments(attachments));
    await tab.render('c'); await act(async () => tab.current.setAttachments(attachments));
    expect(tab.current.notice).toContain('2 MiB');
    const cleanup = tab.current.prepareDelete('a');
    await act(async () => { expect(cleanup()).toBeUndefined(); });
    expect(stored('a')).toBeNull();
    await act(async () => tab.current.setText('now fits'));
    expect(tab.current.notice).toBeUndefined();
    expect(stored('c')?.text).toBe('now fits');
    await tab.render('a'); expect(tab.current.draft.attachments).toEqual([]);
  });

  it.each([false, true])('preserves a foreign draft written %s relative to deletion preparation', async afterPreparation => {
    const first = await hook('a'); await act(async () => first.current.setText('old'));
    const second = await hook('a');
    if (!afterPreparation) await act(async () => second.current.setText('foreign newer draft'));
    const cleanup = first.current.prepareDelete('a');
    if (afterPreparation) await act(async () => second.current.setText('foreign newer draft'));
    await first.render('b');
    await act(async () => { expect(cleanup()).toContain('different saved draft'); });
    expect(stored('a')?.text).toBe('foreign newer draft');
    expect(second.current.draft.text).toBe('foreign newer draft');
  });

  it('also cleans up a saved draft for an unopened sidebar session', async () => {
    localStorage.setItem(draftKey('unopened'), JSON.stringify({ text: 'saved elsewhere', attachments: [] }));
    const tab = await hook('a'), cleanup = tab.current.prepareDelete('unopened');
    await act(async () => { expect(cleanup()).toBeUndefined(); });
    expect(stored('unopened')).toBeNull();
  });
});

describe('session-scoped asynchronous responses', () => {
  it.each(['success', 'failure'] as const)('ignores a delayed selection PATCH %s after navigating to another session', async outcome => {
    const server = appServer([detail('a'), detail('b', { session: session('b', { mode: 'plan' }) })]);
    const pending = deferred<Session>();
    server.mutation = (path, method) => {
      expect(`${method} ${path}`).toBe('PATCH /api/sessions/a'); return pending.promise;
    };
    await mountApp(); await clickText('Plan'); await click('.session-link[title="Session b"]');
    expect(element('.topbar-title').textContent).toBe('Session b');
    await act(async () => { if (outcome === 'success') pending.resolve(session('a', { mode: 'plan' })); else pending.reject(new Error('old request failed')); });
    expect(window.location.hash).toBe('#session/b');
    expect(element('.topbar-title').textContent).toBe('Session b');
    expect(element('.breadcrumb-project').textContent).toBe('workspace-b');
    expect(element('.mode-switch [aria-pressed="true"]').textContent).toBe('Plan');
    expect(element('.conversation-content').textContent).toContain('History b');
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it('does not roll back a newer selection when an older same-session request fails', async () => {
    const server = appServer([detail('a')]), first = deferred<Session>(), second = deferred<Session>();
    let calls = 0; server.mutation = () => ++calls === 1 ? first.promise : second.promise;
    await mountApp();
    await clickText('Build'); // Previous value is Build; this response must not roll back the later Plan.
    await clickText('Plan');
    await act(async () => second.resolve(session('a', { mode: 'plan' })));
    await act(async () => first.reject(new Error('superseded failure')));
    expect(element('.mode-switch [aria-pressed="true"]').textContent).toBe('Plan');
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it.each(['enqueue', 'pause', 'resume', 'remove'] as const)('does not revive consumed items from a delayed %s response after the journal is pruned', async action => {
    const item = (id: string) => ({ id, sessionId: 'a', content: `queued ${id}`, attachments: [], createdAt: 1 });
    const paused = action === 'resume';
    const initialQueue: QueueState = { items: action === 'enqueue' ? [] : [item('first'), item('second')], paused };
    const server = appServer([detail('a', { session: session('a', { status: 'running' }), queue: initialQueue })]);
    const pending = deferred<QueueState>();
    const expected = action === 'enqueue' ? 'POST /api/sessions/a/queue' : action === 'remove' ? 'DELETE /api/sessions/a/queue/first' : `POST /api/sessions/a/queue/${action}`;
    server.mutation = (path, method) => { expect(`${method} ${path}`).toBe(expected); return pending.promise; };
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'queued draft', attachments: [] }));
    await mountApp();
    if (action === 'enqueue') await click('[aria-label="Add to queue"]');
    else if (action === 'remove') await click('[aria-label="Remove queued message 1"]');
    else await clickText(action === 'pause' ? 'Pause queue' : 'Resume queue');
    expect(server.requests).toContain(expected);
    const accepted: QueueState = { items: [item('second')], paused: action === 'pause' };
    const source = TestEventSource.instances.at(-1)!;
    await act(async () => source.emit({ id: 11, type: 'queue', sessionId: 'a', data: accepted }));
    server.details.set('a', detail('a', { lastEventId: 13 }));
    const reads = server.requests.filter(request => request === 'GET /api/sessions/a').length;
    await act(async () => {
      source.emit({ id: 12, type: 'queue', sessionId: 'a', data: { items: [], paused: false } });
      source.emit({ id: 13, type: 'done', sessionId: 'a', data: { status: 'idle' } });
    });
    expect(server.requests.filter(request => request === 'GET /api/sessions/a')).toHaveLength(reads + 1);
    expect(document.querySelectorAll('.queue-items li')).toHaveLength(0);
    // The done snapshot consumes the event journal. The next refresh fails, leaving no way
    // to hide a stale-response overwrite behind an immediately successful GET.
    server.offline = true;
    await act(async () => pending.resolve(accepted));
    expect(document.querySelectorAll('.queue-items li')).toHaveLength(0);
    expect(document.querySelector('.message-queue')).toBeNull();
    expect(element('.global-alert').textContent).toContain('offline');
    if (action === 'enqueue') expect(stored('a')).toBeNull();
  });

  it.each(['success', 'failure', 'foreign-edit'] as const)('cleans saved drafts only after successful session deletion (%s)', async outcome => {
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'delete my draft', attachments: [{ name: 'context.txt', content: 'x'.repeat(450_000) }] }));
    const server = appServer([detail('a')]), pending = deferred<object>();
    server.mutation = (path, method) => { expect(`${method} ${path}`).toBe('DELETE /api/sessions/a'); return pending.promise; };
    await mountApp(); await click('[aria-label="Session actions"]'); await clickText('Delete session');
    await click('.modal .destructive');
    if (outcome === 'foreign-edit') localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'another tab’s new draft', attachments: [] }));
    await act(async () => {
      if (outcome === 'failure') pending.reject(new Error('delete failed'));
      else { server.details.delete('a'); pending.resolve({}); }
    });
    if (outcome === 'failure') {
      expect(stored('a')?.text).toBe('delete my draft');
      expect(window.location.hash).toBe('#session/a');
    } else {
      expect(window.location.hash).toBe('');
      expect(document.querySelectorAll('.session-link')).toHaveLength(0);
      if (outcome === 'success') expect(stored('a')).toBeNull();
      else {
        expect(stored('a')?.text).toBe('another tab’s new draft');
        expect(element('.global-alert').textContent).toContain('different saved draft');
      }
    }
  });
});
