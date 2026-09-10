// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/src/App';
import { useSessionDraft, type ComposerDraft } from '../client/src/api';
import type { ContextSnapshot, QueueState, RunEvent, Session, SessionDetail, Settings } from '../shared/types';
import { ContextIndicator } from '../client/src/ContextIndicator';
import { Settings as SettingsPanel } from '../client/src/Settings';
import type { QuestionRequest } from '../shared/questions';

const draftKey = (id: string) => `speedrail:draft:v1:${id}`;
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
async function fill(selector: string, value: string) {
  const input = element<HTMLTextAreaElement>(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function clickText(label: string, scope = document.body) {
  const button = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  expect(button, `Missing button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

async function changeMode(mode: string) { await act(async () => { const select = element<HTMLSelectElement>('.mode-switch select'); if (select.disabled) return; select.value = mode; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
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
    await mountApp(); await changeMode('plan'); await click('.session-link[title="Session b"]');
    expect(element('.topbar-title').textContent).toBe('Session b');
    await act(async () => { if (outcome === 'success') pending.resolve(session('a', { mode: 'plan' })); else pending.reject(new Error('old request failed')); });
    expect(window.location.hash).toBe('#session/b');
    expect(element('.topbar-title').textContent).toBe('Session b');
    expect(element('.breadcrumb-project').textContent).toBe('workspace-b');
    expect(element<HTMLSelectElement>('.mode-switch select').selectedOptions[0].textContent).toBe('Plan');
    expect(element('.conversation-content').textContent).toContain('History b');
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it('serializes selection changes, releases the failed lock, and guards an explicit retry by revision', async () => {
    const server = appServer([detail('a')]), first = deferred<Session>(), second = deferred<Session>();
    let calls = 0; server.mutation = () => ++calls === 1 ? first.promise : second.promise;
    await mountApp();
    await changeMode('build');
    expect(element<HTMLButtonElement>('.mode-switch select').disabled).toBe(true);
    await changeMode('plan');
    expect(calls).toBe(1);
    await act(async () => first.reject(new Error('Configuration request failed')));
    expect(element<HTMLSelectElement>('.mode-switch select').selectedOptions[0].textContent).toBe('Build');
    expect(element<HTMLButtonElement>('.mode-switch select').disabled).toBe(false);
    await changeMode('plan');
    expect(calls).toBe(2);
    const patches = vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'PATCH');
    expect(patches.map(([, options]) => JSON.parse(String(options?.body)).expectedConfigRevision)).toEqual([0, 0]);
    await act(async () => second.resolve(session('a', { mode: 'plan', configRevision: 1 })));
    expect(element<HTMLSelectElement>('.mode-switch select').selectedOptions[0].textContent).toBe('Plan');
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it.each(['enqueue', 'pause', 'resume', 'remove', 'steer'] as const)('does not revive consumed items from a delayed %s response after the journal is pruned', async action => {
    const item = (id: string) => ({ id, sessionId: 'a', content: `queued ${id}`, attachments: [], createdAt: 1 });
    const paused = action === 'resume';
    const initialQueue: QueueState = { items: action === 'enqueue' ? [] : [item('first'), item('second')], paused };
    const server = appServer([detail('a', { session: session('a', { status: 'running' }), queue: initialQueue })]);
    const pending = deferred<QueueState>();
    const expected = action === 'steer' ? 'POST /api/sessions/a/queue/first/steer' : action === 'enqueue' ? 'POST /api/sessions/a/queue' : action === 'remove' ? 'DELETE /api/sessions/a/queue/first' : `POST /api/sessions/a/queue/${action}`;
    server.mutation = (path, method) => { expect(`${method} ${path}`).toBe(expected); return pending.promise; };
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'queued draft', attachments: [] }));
    await mountApp();
    if (action === 'enqueue') await click('[aria-label="Add to queue"]');
    else if (action === 'steer') await click('[aria-label="Steer with queued message 1"]');
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

const undoable = { hasCheckpoints: true, canUndo: true, canRedo: false, undoId: 'turn-1' };
const redoable = { hasCheckpoints: true, canUndo: false, canRedo: true, redoId: 'turn-1' };
const historyRegion = () => element<HTMLElement>('[aria-label="Turn history"]');
async function confirmHistory(label: string) {
  if (label === 'Recover history') await clickText(label, historyRegion());
  else { await click('[aria-label="Session actions"]'); await clickText(label, element<HTMLElement>('.session-menu')); }
  expect(element('.modal h2').textContent).toBe(`${label}?`);
  await clickText(label, element<HTMLElement>('.modal'));
}

describe('turn history UI', () => {
  it.each(['undo', 'redo'] as const)('restores an authoritative snapshot after %s without touching drafts or replaying providers', async action => {
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'keep my draft', attachments: [{ name: 'draft.txt', content: 'keep context' }] }));
    const server = appServer([detail('a', { history: action === 'undo' ? undoable : redoable })]);
    const pending = deferred<object>();
    server.mutation = (path, method) => { expect(`${method} ${path}`).toBe(`POST /api/sessions/a/history/${action}`); return pending.promise; };
    await mountApp();
    await confirmHistory(action === 'undo' ? 'Undo last turn' : 'Redo turn');
    const request = vi.mocked(fetch).mock.calls.find(([path]) => path === `/api/sessions/a/history/${action}`)!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ checkpointId: 'turn-1' });
    expect(element<HTMLTextAreaElement>('#message-input').disabled).toBe(true);
    server.details.set('a', detail('a', { history: action === 'undo' ? redoable : undoable, lastEventId: 15, queue: { items: [], paused: true, reason: 'History changed. Resume explicitly.' }, messages: [] }));
    await act(async () => pending.resolve({}));
    expect(element<HTMLTextAreaElement>('#message-input').value).toBe('keep my draft');
    expect(stored('a')?.attachments[0].content).toBe('keep context');
    expect(document.querySelector('.queue-status')).toBeNull();
    expect(document.querySelector('.conversation-content')?.textContent).not.toContain('History a');
    expect(server.requests.filter(request => request.startsWith('POST'))).toEqual([`POST /api/sessions/a/history/${action}`]);
    expect(element('.toast').textContent).toContain(action === 'undo' ? 'Last turn undone' : 'without replay');
  });

  it('refreshes after partial failure, displays recovery paths, and leaves normal sends disabled', async () => {
    const server = appServer([detail('a', { history: undoable })]), pending = deferred<object>();
    server.mutation = () => pending.promise;
    await mountApp(); await confirmHistory('Undo last turn');
    server.details.set('a', detail('a', { lastEventId: 15, history: { ...undoable, canUndo: false, pendingRecovery: { reason: 'Finish interrupted undo before continuing.', paths: ['src/changed.ts'] } } }));
    await act(async () => pending.reject(new Error('File changed during restoration')));
    expect(element('.global-alert').textContent).toContain('File changed');
    expect(element('.history-recovery').textContent).toContain('src/changed.ts');
    expect(element<HTMLTextAreaElement>('#message-input').disabled).toBe(true);
    expect(element<HTMLTextAreaElement>('#message-input').disabled).toBe(true);
    server.mutation = (path, method) => {
      expect(`${method} ${path}`).toBe('POST /api/sessions/a/history/recover');
      server.details.set('a', detail('a', { lastEventId: 20, history: redoable })); return {};
    };
    await confirmHistory('Recover history');
    expect(document.querySelector('.history-recovery')).toBeNull();
    expect(element<HTMLTextAreaElement>('#message-input').disabled).toBe(false);
  });

  it('does not apply a late history result or error to a different active session', async () => {
    const server = appServer([detail('a', { history: undoable }), detail('b', { history: redoable })]), pending = deferred<object>();
    server.mutation = () => pending.promise;
    await mountApp(); await confirmHistory('Undo last turn');
    await click('.session-link[title="Session b"]');
    await act(async () => pending.reject(new Error('Session a restore failed')));
    expect(element('.topbar-title').textContent).toBe('Session b');
    expect(element('.conversation-content').textContent).toContain('History b');
    expect(document.querySelector('.global-alert')).toBeNull();
    expect(document.querySelector('.toast')).toBeNull();
    expect(server.requests.filter(request => request === 'GET /api/sessions/a')).toHaveLength(2);
  });

  it('refuses a stale confirmation after SSE changes the current checkpoint', async () => {
    const server = appServer([detail('a', { history: undoable })]);
    await mountApp(); await click('[aria-label="Session actions"]'); await clickText('Undo last turn', element<HTMLElement>('.session-menu'));
    server.details.set('a', detail('a', { lastEventId: 11, history: { ...undoable, undoId: 'turn-2' } }));
    await act(async () => TestEventSource.instances.at(-1)!.emit({ id: 11, type: 'history', sessionId: 'a', data: { ...undoable, undoId: 'turn-2' } }));
    await clickText('Undo last turn', element<HTMLElement>('.modal'));
    expect(element('.global-alert').textContent).toContain('Turn history changed');
    expect(server.requests.some(request => request.startsWith('POST'))).toBe(false);
  });

  it('blocks history during message preparation but leaves queue enabled during active runs', async () => {
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'prepare this', attachments: [] }));
    const server = appServer([detail('a', { history: undoable })]), pending = deferred<object>();
    server.mutation = () => pending.promise;
    await mountApp(); await click('[aria-label="Send message"]');
    await click('[aria-label="Session actions"]');
    expect([...document.querySelectorAll<HTMLButtonElement>('.session-menu button')].find(button => button.textContent === 'Undo last turn')?.disabled).toBe(true);
    await act(async () => pending.reject(new Error('preparation failed')));
    expect(stored('a')?.text).toBe('prepare this');
    expect([...document.querySelectorAll<HTMLButtonElement>('.session-menu button')].find(button => button.textContent === 'Undo last turn')?.disabled).toBe(false);
    await act(async () => TestEventSource.instances.at(-1)!.emit({ id: 11, type: 'session', sessionId: 'a', data: { status: 'running' } }));
    expect([...document.querySelectorAll<HTMLButtonElement>('.session-menu button')].find(button => button.textContent === 'Undo last turn')?.disabled).toBe(true);
    expect(element<HTMLButtonElement>('[aria-label="Add to queue"]').disabled).toBe(false);
    expect(element<HTMLButtonElement>('[aria-label="Stop generation"]').disabled).toBe(false);
  });

  it.each([false, true])('only exposes session-wide legacy undo when hasCheckpoints is false (%s)', async hasCheckpoints => {
    appServer([detail('a', { history: { hasCheckpoints, canUndo: false, canRedo: false } })]);
    await mountApp(); await click('[aria-label="Session actions"]');
    const labels = [...element('.session-menu').querySelectorAll('button')].map(button => button.textContent);
    expect(labels.includes('Undo session file changes')).toBe(!hasCheckpoints);
    expect(labels).toContain('Undo last turn'); expect(labels).toContain('Redo turn');
    expect(document.querySelector('[aria-label="Undo session file changes"]')).toBeNull();
  });
});

function question(id = 'q-a', sessionId = 'a'): QuestionRequest {
  return { id, sessionId, turnId: 'turn-a', messageId: 'assistant-a', toolCallId: 'ask-a', question: 'Which database should we use?', options: [{ id: 'postgres', label: 'PostgreSQL', description: 'A relational database' }, { id: 'sqlite', label: 'SQLite' }], createdAt: 1 };
}
function questioning(id = 'a', request = question(`q-${id}`, id)) {
  return detail(id, { session: session(id, { status: 'waiting' }), questions: [request] });
}
const questionRegion = () => element<HTMLElement>('[aria-label="Question from agent"]');
const submitQuestion = () => clickText('Submit answer', questionRegion());

describe('structured agent questions', () => {
  it('requires explicit option selection and submits once without modifying composer drafts', async () => {
    const saved = { text: 'unsent composer work', attachments: [{ name: 'draft.txt', content: 'keep this' }] };
    localStorage.setItem(draftKey('a'), JSON.stringify(saved));
    const server = appServer([questioning()]), pending = deferred<object>();
    server.mutation = (path, method) => { expect(`${method} ${path}`).toBe('POST /api/sessions/a/questions/q-a/answer'); return pending.promise; };
    await mountApp();
    expect(questionRegion().querySelector('input:checked')).toBeNull();
    expect(element<HTMLButtonElement>('.question-actions .primary').disabled).toBe(true);
    expect(document.querySelector('.session-state')).toBeNull();
    expect(document.querySelector('.run-status')).toBeNull();
    await click('.question-option input[value="postgres"]');
    expect(server.requests.some(request => request.startsWith('POST'))).toBe(false);
    const button = element<HTMLButtonElement>('.question-actions .primary');
    await act(async () => { button.click(); button.click(); });
    expect(server.requests.filter(request => request.startsWith('POST'))).toEqual(['POST /api/sessions/a/questions/q-a/answer']);
    const [, options] = vi.mocked(fetch).mock.calls.find(([path]) => path === '/api/sessions/a/questions/q-a/answer')!;
    expect(JSON.parse(options!.body as string)).toEqual({ kind: 'option', optionId: 'postgres' });
    expect(element<HTMLButtonElement>('[aria-label="Add to queue"]').disabled).toBe(false);
    expect(element<HTMLButtonElement>('[aria-label="Stop generation"]').disabled).toBe(false);
    expect(element<HTMLButtonElement>('.question-actions .secondary').disabled).toBe(false);
    server.details.set('a', detail('a', { questions: [], lastEventId: 12 }));
    await act(async () => pending.resolve({ id: 'q-a', status: 'answered', answer: { kind: 'option', optionId: 'postgres' } }));
    expect(document.querySelector('.question-card')).toBeNull();
    expect(stored('a')).toEqual(saved);
    expect(element<HTMLTextAreaElement>('#message-input').value).toBe(saved.text);
    expect(server.requests.filter(request => request === 'GET /api/sessions/a')).toHaveLength(2);
  });

  it('always offers custom text, preserves it across switching, and keeps Enter as a newline', async () => {
    const request = { ...question(), options: [] };
    const server = appServer([questioning('a', request), questioning('b')]);
    server.mutation = () => { server.details.set('a', detail('a', { questions: [], lastEventId: 12 })); return { id: 'q-a', status: 'answered', answer: { kind: 'text', text: 'Use an embedded database' } }; };
    await mountApp(); await click('.question-option.custom input');
    await fill('.question-custom textarea', '   ');
    expect(element<HTMLButtonElement>('.question-actions .primary').disabled).toBe(true);
    await fill('.question-custom textarea', '  Use an embedded database  ');
    const input = element<HTMLTextAreaElement>('.question-custom textarea');
    expect(input.maxLength).toBe(8000);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(server.requests.some(request => request.startsWith('POST'))).toBe(false);
    await click('.session-link[title="Session b"]');
    expect(questionRegion().querySelector('input:checked')).toBeNull();
    await click('.session-link[title="Session a"]');
    expect(element<HTMLTextAreaElement>('.question-custom textarea').value).toBe('  Use an embedded database  ');
    await submitQuestion();
    const [, options] = vi.mocked(fetch).mock.calls.find(([path]) => path === '/api/sessions/a/questions/q-a/answer')!;
    expect(JSON.parse(options!.body as string)).toEqual({ kind: 'text', text: 'Use an embedded database' });
  });

  it('keeps the answer and enables retry after failure, without touching main draft', async () => {
    const server = appServer([questioning()]);
    server.mutation = () => { throw new Error('answer not accepted'); };
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'main draft', attachments: [] }));
    await mountApp(); await click('.question-option.custom input'); await fill('.question-custom textarea', 'Keep my custom answer'); await submitQuestion();
    expect(element('.question-error').textContent).toContain('answer not accepted');
    expect(element<HTMLTextAreaElement>('.question-custom textarea').value).toBe('Keep my custom answer');
    expect(element<HTMLButtonElement>('.question-actions .primary').disabled).toBe(false);
    expect(stored('a')?.text).toBe('main draft');
    expect(server.requests.filter(request => request === 'GET /api/sessions/a')).toHaveLength(2);
  });

  it('does not resurrect a remotely resolved question from a stale snapshot or delayed failed answer', async () => {
    const server = appServer([questioning()]), pending = deferred<object>();
    server.mutation = () => pending.promise;
    await mountApp(); await click('.question-option input[value="sqlite"]'); await submitQuestion();
    const source = TestEventSource.instances.at(-1)!;
    await act(async () => source.emit({ id: 12, sessionId: 'a', type: 'question_resolved', data: { id: 'q-a', status: 'answered' } }));
    expect(document.querySelector('.question-card')).toBeNull();
    // Prune the journal using a current snapshot, then return an older pending snapshot.
    server.details.set('a', detail('a', { questions: [], lastEventId: 13 }));
    await act(async () => source.onopen?.());
    server.details.set('a', questioning());
    await act(async () => pending.reject(new Error('Another client answered first')));
    expect(document.querySelector('.question-card')).toBeNull();
    expect(document.querySelector('.question-error')).toBeNull();
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it.each(['success', 'failure'] as const)('ignores a late answer %s after navigation to another question', async outcome => {
    const server = appServer([questioning(), questioning('b')]), pending = deferred<object>();
    server.mutation = () => pending.promise;
    await mountApp(); await click('.question-option input[value="sqlite"]'); await submitQuestion();
    await click('.session-link[title="Session b"]');
    await click('.question-option.custom input'); await fill('.question-custom textarea', 'Session b answer');
    await act(async () => {
      if (outcome === 'success') pending.resolve({ id: 'q-a', status: 'answered', answer: { kind: 'option', optionId: 'sqlite' } });
      else pending.reject(new Error('Session a failed'));
    });
    expect(element('.topbar-title').textContent).toBe('Session b');
    expect(element<HTMLTextAreaElement>('.question-custom textarea').value).toBe('Session b answer');
    expect(document.querySelector('.question-error')).toBeNull();
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it('Stop response stays usable during an in-flight answer and refreshes paused queue state', async () => {
    const server = appServer([questioning()]), pending = deferred<object>();
    server.mutation = (path, method) => {
      if (path.endsWith('/answer')) return pending.promise;
      expect(`${method} ${path}`).toBe('POST /api/sessions/a/cancel');
      server.details.set('a', detail('a', { questions: [], lastEventId: 15, queue: { items: [], paused: true, reason: 'Cancelled. Resume explicitly.' } }));
      TestEventSource.instances.at(-1)!.emit({ id: 14, sessionId: 'a', type: 'question_resolved', data: { id: 'q-a', status: 'cancelled' } });
      return {};
    };
    await mountApp(); await click('.question-option input[value="sqlite"]'); await submitQuestion();
    await clickText('Stop response', questionRegion());
    await act(async () => pending.reject(new Error('Question cancelled')));
    expect(server.requests).toContain('POST /api/sessions/a/cancel');
    expect(document.querySelector('.question-card')).toBeNull();
    expect(document.querySelector('.queue-status')).toBeNull();
    expect(document.querySelector('.global-alert')).toBeNull();
    expect(server.requests.some(request => request.endsWith('/queue/resume'))).toBe(false);
  });

  it('renders malicious question/option text inertly and never treats auto mode as an answer', async () => {
    const malicious = '<img src=x onerror="window.questionExecuted=true"><script>alert(1)</script>';
    const request = { ...question(), question: malicious, options: [{ id: 'unsafe', label: malicious, description: '<a href="javascript:alert(1)">click</a>' }] };
    const server = appServer([detail('a', { session: session('a', { status: 'waiting', mode: 'plan', permissionMode: 'auto' }), questions: [request] })]);
    await mountApp();
    expect(questionRegion().textContent).toContain(malicious);
    expect(questionRegion().querySelector('img,script,a')).toBeNull();
    expect(questionRegion().querySelector('input:checked')).toBeNull();
    expect(server.requests.some(request => request.startsWith('POST'))).toBe(false);
  });

  it('SSE deduplicates pending requests and resolution restores the approval waiting label', async () => {
    appServer([detail('a', { session: session('a', { status: 'waiting' }), permissions: [{ id: 'permission', sessionId: 'a', toolCallId: 'write', tool: 'write_file', args: {}, description: 'Needs permission' }] })]);
    await mountApp(); const source = TestEventSource.instances.at(-1)!;
    await act(async () => {
      source.emit({ id: 11, type: 'question', sessionId: 'a', data: question() });
      source.emit({ id: 12, type: 'question', sessionId: 'a', data: question() });
    });
    expect(document.querySelectorAll('.question-card')).toHaveLength(1);
    expect(document.querySelector('.run-status')).toBeNull();
    await act(async () => source.emit({ id: 13, type: 'question_resolved', sessionId: 'a', data: { id: 'q-a', status: 'answered' } }));
    expect(document.querySelectorAll('.question-card')).toHaveLength(0);
    expect(document.querySelector('.run-status')).toBeNull();
  });
});

const contextSnapshot = (overrides: Partial<ContextSnapshot> = {}): ContextSnapshot => ({ providerId: 'fixture', model: 'model', estimatedInputTokens: 8192, contextWindow: 16384, outputReserve: 4096, limitSource: 'override', uncertain: false, action: 'continue', ...overrides });
async function inputValue(selector: string, value: string) {
  const input = element<HTMLInputElement>(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('saved context estimate', () => {
  it('shows approximate input and accessible source/window/reserve details without remaining percentages', async () => {
    await act(async () => root().render(createElement(ContextIndicator, { context: contextSnapshot() })));
    const indicator = element('details[aria-label="Context estimate"]');
    expect(indicator.querySelector('summary')?.textContent).toContain('Context estimate · ≈8,192 input tokens');
    expect(indicator.textContent).toContain('pre-request snapshot for this response');
    expect(indicator.textContent).toContain('not live remaining context or draft usage');
    expect([...indicator.querySelectorAll('dt')].map(item => item.textContent)).toEqual(['Estimated input', 'Context window', 'Output reserve', 'Limit source', 'Model', 'Provider']);
    expect(indicator.textContent).toContain('16,384 tokens');
    expect(indicator.textContent).toContain('4,096 tokens');
    expect(indicator.textContent).toContain('exact-model override');
    expect(indicator.textContent).not.toContain('%');
    expect(indicator.querySelector('meter,progress,[role="progressbar"]')).toBeNull();
  });

  it('labels an input-only catalog cap distinctly instead of claiming a total window', async () => {
    await act(async () => root().render(createElement(ContextIndicator, { context: contextSnapshot({ contextWindow: 200_000, limitSource: 'catalog-input' }) })));
    const indicator = element('.context-estimate');
    expect(indicator.textContent).toContain('200,000 tokens · input limit');
    expect(indicator.textContent).toContain('Model catalog · input limit (max_input_tokens)');
    expect(indicator.querySelector('summary')?.textContent).not.toContain('limit unknown');
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('reports unknown limit honestly for %s', async contextWindow => {
    await act(async () => root().render(createElement(ContextIndicator, { context: contextSnapshot({ contextWindow, limitSource: 'catalog' }) })));
    expect(element('.context-estimate > summary').textContent).toContain('limit unknown');
    expect(element('.context-estimate').textContent).toContain('Unknown · no verified limit');
    expect(element('.context-estimate').textContent).not.toContain('%');
  });

  it('never treats an unknown source as a known window, or malformed estimates as zero usage', async () => {
    await act(async () => root().render(createElement(ContextIndicator, { context: contextSnapshot({ limitSource: 'unknown', estimatedInputTokens: Number.NaN, outputReserve: -4 }) })));
    expect(element('.context-estimate > summary').textContent).toContain('input unavailable · limit unknown');
    expect(element('.context-estimate').textContent).not.toMatch(/NaN|Infinity|-4 tokens/);
  });

  it('warns about uncertainty and compaction without claiming success, and renders opaque text inertly', async () => {
    const malicious = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    await act(async () => root().render(createElement(ContextIndicator, { context: contextSnapshot({ uncertain: true, action: 'compact', reason: malicious, model: malicious, providerId: malicious }) })));
    const indicator = element('.context-estimate');
    expect(indicator.querySelector('summary')?.textContent).toContain('uncertain · compaction needed');
    expect(indicator.textContent).toContain('images, opaque provider data');
    expect(indicator.textContent).toContain('does not confirm that compaction succeeded');
    expect(indicator.textContent).toContain(malicious);
    expect(indicator.querySelector('img,script,a')).toBeNull();
  });

  it('keeps context diagnostics out of streaming and completed conversation messages', async () => {
    appServer([detail('a', { session: session('a', { status: 'running' }), messages: [
      { id: 'reply', sessionId: 'a', role: 'assistant', content: 'Reply', context: contextSnapshot(), createdAt: 2, usage: { inputTokens: 100, outputTokens: 20 } },
    ] })]);
    await mountApp();
    expect(document.querySelector('.context-estimate')).toBeNull();
    expect(document.querySelector('.usage')).toBeNull();
    await act(async () => TestEventSource.instances.at(-1)!.emit({ id: 11, sessionId: 'a', type: 'session', data: session('a') }));
    expect(document.querySelector('.context-estimate')).toBeNull();
    expect(element('.usage').textContent).toContain('20 tokens');
  });
});

describe('live context progress snapshot reconciliation', () => {
  const progress = () => ({ id: 'preparing-response', sessionId: 'a', role: 'assistant' as const, content: '', createdAt: 3, activity: 'Making room in context.', context: contextSnapshot({ action: 'compact' }) });

  it('preserves projected progress across post-submit and reconnect snapshots, then replaces it by the same response ID', async () => {
    const initial = detail('a'), server = appServer([initial]);
    const accepted = { id: 'accepted-user', sessionId: 'a', role: 'user' as const, content: 'Continue safely', createdAt: 2 };
    const pending = deferred<object>(); server.mutation = () => pending.promise;
    await mountApp(); await fill('#message-input', accepted.content); await click('[aria-label="Send message"]');
    const source = TestEventSource.instances.at(-1)!, liveMessage = progress();
    // The detail projection covers the same cursor as the transient event, without
    // requiring the progress placeholder in the durable conversation/archive.
    server.details.set('a', detail('a', { session: session('a', { status: 'running' }), messages: [...initial.messages, accepted, liveMessage], lastEventId: 13 }));
    await act(async () => {
      source.emit({ id: 11, sessionId: 'a', type: 'session', data: session('a', { status: 'running' }) });
      source.emit({ id: 12, sessionId: 'a', type: 'message', data: accepted });
      source.emit({ id: 13, sessionId: 'a', type: 'message', data: liveMessage });
    });
    expect(element('.run-status').textContent).toContain('Making room in context.');
    const reads = server.requests.filter(request => request === 'GET /api/sessions/a').length;
    await act(async () => pending.resolve({ messageId: accepted.id }));
    expect(server.requests.filter(request => request === 'GET /api/sessions/a').length).toBeGreaterThan(reads);
    expect(document.querySelectorAll('.context-estimate')).toHaveLength(0);
    await act(async () => source.onopen?.());
    expect(document.querySelectorAll('.context-estimate')).toHaveLength(0);
    const completed = { ...liveMessage, activity: '', content: 'Final answer', context: contextSnapshot({ reason: 'Older context was compacted before this request.' }) };
    await act(async () => source.emit({ id: 14, sessionId: 'a', type: 'message', data: completed }));
    expect(document.querySelectorAll('.assistant-message')).toHaveLength(1);
    expect(document.querySelectorAll('.context-estimate')).toHaveLength(0);
    expect(element('.assistant-message').textContent).toContain('Final answer');
    expect(document.querySelector('.run-status')).toBeNull();
  });

  it('does not revive another session’s pending progress when its old submission and stream settle', async () => {
    const liveMessage = progress(), initial = detail('a'), server = appServer([initial, detail('b')]);
    const pending = deferred<object>(); server.mutation = () => pending.promise;
    await mountApp(); await fill('#message-input', 'Prepare context'); await click('[aria-label="Send message"]');
    const source = TestEventSource.instances.at(-1)!;
    server.details.set('a', detail('a', { session: session('a', { status: 'running' }), messages: [...initial.messages, liveMessage], lastEventId: 12 }));
    await act(async () => {
      source.emit({ id: 11, sessionId: 'a', type: 'session', data: session('a', { status: 'running' }) });
      source.emit({ id: 12, sessionId: 'a', type: 'message', data: liveMessage });
    });
    expect(document.querySelectorAll('.context-estimate')).toHaveLength(0);
    await click('.session-link[title="Session b"]'); await fill('#message-input', 'Session b draft');
    await act(async () => {
      source.emit({ id: 13, sessionId: 'a', type: 'message', data: { ...liveMessage, content: 'Late session a reply' } });
      pending.resolve({ messageId: 'accepted-a' });
    });
    expect(element('.topbar-title').textContent).toBe('Session b');
    expect(document.querySelector('.context-estimate')).toBeNull();
    expect(element('.conversation-content').textContent).not.toContain('Late session a reply');
    expect(element<HTMLTextAreaElement>('#message-input').value).toBe('Session b draft');
  });

  it('restores pending progress on a cold mount, but reset and newer snapshots discard it without resurrection', async () => {
    const liveMessage = progress(), pendingSnapshot = detail('a', { session: session('a', { status: 'running' }), messages: [liveMessage], lastEventId: 13 });
    const server = appServer([pendingSnapshot]);
    localStorage.setItem(draftKey('a'), JSON.stringify({ text: 'Keep pending draft', attachments: [] }));
    await mountApp(); const source = TestEventSource.instances.at(-1)!;
    expect(document.querySelectorAll('.context-estimate')).toHaveLength(0);
    expect(element('[aria-label="Stop generation"]')).toBeDefined();
    await act(async () => source.onopen?.());
    expect(document.querySelectorAll('.context-estimate')).toHaveLength(0);
    const replacement = [{ id: 'summary', sessionId: 'a', role: 'system' as const, content: 'Saved context summary', createdAt: 4 }];
    server.details.set('a', detail('a', { session: session('a', { status: 'running' }), messages: replacement, lastEventId: 14 }));
    await act(async () => source.emit({ id: 14, sessionId: 'a', type: 'reset', data: { messages: replacement } }));
    await act(async () => source.onopen?.()); // Consume journal against authoritative reset.
    expect(document.querySelector('.context-estimate')).toBeNull();
    // Old message and snapshot must not restore an obsolete progress card.
    server.details.set('a', pendingSnapshot);
    await act(async () => {
      source.emit({ id: 13, sessionId: 'a', type: 'message', data: liveMessage });
      source.onopen?.();
    });
    expect(document.querySelector('.context-estimate')).toBeNull();
    expect(element('.system-message').textContent).toContain('Saved context summary');
    expect(element<HTMLTextAreaElement>('#message-input').value).toBe('Keep pending draft');
  });
});

describe('provider context window settings', () => {
  async function mountSettings(value: Settings = settings) {
    const onSave = vi.fn(), onClose = vi.fn();
    const writes: Settings[] = [];
    let pending: ReturnType<typeof deferred<Settings>> | undefined;
    let failure: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      expect(path).toBe('/api/settings'); expect(options?.method).toBe('PATCH');
      const body = JSON.parse(String(options?.body)) as Settings; writes.push(body);
      if (failure) throw new Error(failure);
      const saved = pending ? await pending.promise : body;
      return { ok: true, status: 200, json: async () => saved };
    }));
    await act(async () => root().render(createElement(SettingsPanel, { settings: value, onSave, onClose })));
    return { writes, onSave, onClose, set pending(value: typeof pending) { pending = value; }, set failure(value: string | undefined) { failure = value; } };
  }
  const modelInput = '[aria-label="Model ID 1"]', tokensInput = '[aria-label="Context window tokens 1"]';

  it('saves exact-model limits independently of model lists, without echoing saved credentials', async () => {
    const value = { ...settings, providers: [{ ...settings.providers[0], apiKey: 'SAVED_SECRET_SENTINEL' }] };
    const panel = await mountSettings(value);
    expect(document.body.textContent).not.toContain('SAVED_SECRET_SENTINEL');
    expect([...document.querySelectorAll('input')].some(input => input.value.includes('SAVED_SECRET_SENTINEL'))).toBe(false);
    await clickText('Add context limit'); await inputValue(modelInput, ' exact-deployment '); await inputValue(tokensInput, '128000');
    await clickText('Save settings');
    expect(panel.writes).toHaveLength(1);
    expect(panel.writes[0].providers[0].contextWindows).toEqual({ 'exact-deployment': 128000 });
    expect(panel.writes[0].providers[0].models).toEqual(['model']);
    expect(panel.writes[0].providers[0].apiKey).toBeUndefined();
    expect(panel.onClose).toHaveBeenCalledOnce();
  });

  it('keeps row drafts separate across providers and supports deletion with an explicit empty map', async () => {
    const value: Settings = { ...settings, providers: [
      { ...settings.providers[0], contextWindows: { model: 4096 } },
      { id: 'other', name: 'Other provider', kind: 'openai', baseUrl: 'http://localhost', contextWindows: { model: 8192 } },
    ] };
    const panel = await mountSettings(value);
    await inputValue(tokensInput, '16384'); await clickText('Other provider');
    expect(element<HTMLInputElement>(tokensInput).value).toBe('8192');
    await inputValue(tokensInput, '32768'); await clickText('Fixture');
    expect(element<HTMLInputElement>(tokensInput).value).toBe('16384');
    await click('[aria-label="Remove context limit model"]');
    expect(document.querySelector(modelInput)).toBeNull();
    await clickText('Save settings');
    expect(panel.writes[0].providers[0].contextWindows).toEqual({});
    expect(panel.writes[0].providers[1].contextWindows).toEqual({ model: 32768 });
  });

  it.each(['', '1023', '10000001', '2.5', '-1', '1e4'])('rejects invalid token count %s before saving', async tokens => {
    const panel = await mountSettings();
    await clickText('Add context limit'); await inputValue(modelInput, 'model'); await inputValue(tokensInput, tokens);
    await clickText('Save settings');
    expect(panel.writes).toHaveLength(0);
    expect(element('[role="alert"]').textContent).toContain('whole token count from 1,024 to 10,000,000');
    expect(element<HTMLInputElement>(modelInput).value).toBe('model');
    expect(panel.onClose).not.toHaveBeenCalled();
  });

  it('rejects empty IDs and duplicates after trimming rather than overwriting an earlier row', async () => {
    const panel = await mountSettings(); await clickText('Add context limit'); await inputValue(tokensInput, '1024');
    await clickText('Save settings'); expect(panel.writes).toHaveLength(0);
    expect(element('[role="alert"]').textContent).toContain('enter an exact model ID');
    await inputValue(modelInput, 'model'); await clickText('Add context limit');
    await inputValue('[aria-label="Model ID 2"]', ' model '); await inputValue('[aria-label="Context window tokens 2"]', '2048');
    await clickText('Save settings'); expect(panel.writes).toHaveLength(0);
    expect(element('[role="alert"]').textContent).toContain('already has an override');
  });

  it('allows both limit boundaries and prototype-like exact model IDs safely', async () => {
    const panel = await mountSettings(); await clickText('Add context limit');
    await inputValue(modelInput, '__proto__'); await inputValue(tokensInput, '1024');
    await clickText('Add context limit'); await inputValue('[aria-label="Model ID 2"]', 'constructor'); await inputValue('[aria-label="Context window tokens 2"]', '10000000');
    await clickText('Save settings');
    expect(Object.entries(panel.writes[0].providers[0].contextWindows!)).toEqual([['__proto__', 1024], ['constructor', 10000000]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('caps rows at 100 and lets removing a row free a slot', async () => {
    const value = { ...settings, providers: [{ ...settings.providers[0], contextWindows: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`model-${index}`, 4096])) }] };
    await mountSettings(value);
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Add context limit')?.disabled).toBe(true);
    await click('[aria-label="Remove context limit model-0"]');
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Add context limit')?.disabled).toBe(false);
  });

  it('retains override drafts after failure and prevents duplicate saves or edits during a pending save', async () => {
    const panel = await mountSettings(); await clickText('Add context limit');
    await inputValue(modelInput, 'model'); await inputValue(tokensInput, '32768');
    panel.failure = 'offline'; await clickText('Save settings');
    expect(element<HTMLInputElement>(tokensInput).value).toBe('32768');
    expect(element('[role="alert"]').textContent).toContain('offline');
    panel.failure = undefined; const pending = deferred<Settings>(); panel.pending = pending;
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === 'Save settings')!;
    await act(async () => { save.click(); save.click(); });
    expect(panel.writes).toHaveLength(2);
    expect(element<HTMLInputElement>(tokensInput).disabled).toBe(true);
    expect(element<HTMLButtonElement>('[aria-label="Remove context limit model"]').disabled).toBe(true);
    await act(async () => pending.resolve(panel.writes[1]));
    expect(panel.onSave).toHaveBeenCalledOnce();
  });
});
