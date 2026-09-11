// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/src/App';
import { TaskTranscript } from '../client/src/TaskCard';
import { applyEvent, visibleDelegations } from '../client/src/api';
import type { DelegationDetail, DelegationSummary } from '../shared/delegation';
import type { Message, RunEvent, Session, SessionDetail, Settings } from '../shared/types';

const roots: Root[] = [];
function root() { const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root); return root; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function el<T extends Element = HTMLElement>(selector: string): T { const found = document.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }
function button(label: string, scope: ParentNode = document) { const found = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label); expect(found, label).toBeDefined(); return found!; }
async function press(label: string, scope: ParentNode = document) { await act(async () => button(label, scope).click()); }
async function click(selector: string) { await act(async () => el<HTMLButtonElement>(selector).click()); }
async function fill(text: string) { await act(async () => { const input = el<HTMLTextAreaElement>('#message-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
const settings: Settings = { providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model'] }], defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace', permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: {} };
function session(id: string, patch: Partial<Session> = {}): Session { return { id, title: `Session ${id}`, workspace: '/workspace', providerId: 'fixture', model: 'model', mode: 'plan', permissionMode: 'ask', status: 'idle', archived: false, createdAt: 1, updatedAt: 1, ...patch }; }
function task(patch: Partial<DelegationSummary> = {}): DelegationSummary { return { id: 'task-a', parentSessionId: 'a', parentMessageId: 'message-a', parentTurnId: 'turn-a', toolCallId: 'tool-a', childSessionId: 'child-a', description: 'Research the file layout', status: 'running', createdAt: 1, ...patch }; }
function linkedMessage(): Message { return { id: 'message-a', sessionId: 'a', role: 'assistant', content: 'Investigating the repository.', createdAt: 1, toolCalls: [{ id: 'tool-a', name: 'task', args: { description: 'Research the file layout' }, status: 'running', delegationId: 'task-a' }] }; }
function parent(id = 'a'): SessionDetail { return { session: session(id, { status: id === 'a' ? 'running' : 'idle' }), messages: id === 'a' ? [linkedMessage()] : [], delegations: id === 'a' ? [task()] : [], todos: [], permissions: [], questions: [], queue: { items: [], paused: false }, lastEventId: 10 }; }
function child(patch: Partial<DelegationDetail> = {}): DelegationDetail { return { session: session('child-a', { status: 'running' }), messages: [{ id: 'child-message', sessionId: 'child-a', role: 'assistant', content: 'Reading research.txt.', createdAt: 1 }], delegation: task(), readOnly: true, todos: [], permissions: [], questions: [], lastEventId: 20, ...patch }; }
class Source {
  static instances: Source[] = [];
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null; closed = false;
  constructor(readonly url: string) { Source.instances.push(this); }
  close() { this.closed = true; }
  emit(event: RunEvent) { this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(event.id ?? '') }); }
}
const bound = '/api/sessions/a/delegations/task-a';
function server() {
  const parents = new Map([['a', parent()], ['b', parent('b')]]), calls: { path: string; method: string }[] = [];
  let transcript = child(), intercept: ((path: string, method: string) => unknown | Promise<unknown>) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? 'GET'; calls.push({ path, method });
    const custom = intercept?.(path, method); let value: unknown;
    if (custom !== undefined) value = await custom;
    else if (path === '/api/settings') value = settings;
    else if (path.startsWith('/api/sessions?')) value = { sessions: [...parents.values()].map(item => item.session) };
    else if (path.startsWith('/api/commands?')) value = { commands: [] };
    else if (path === bound && method === 'GET') value = transcript;
    else if (path === bound + '/cancel' && method === 'POST') { parents.get('a')!.delegations = [task({ status: 'cancelled', finishedAt: 2 })]; parents.get('a')!.lastEventId = 11; value = { delegation: task({ status: 'cancelled', finishedAt: 2 }) }; }
    else if (path === '/api/sessions/child-a') throw new Error('Session not found (404)');
    else if (path.startsWith('/api/sessions/') && method === 'GET') value = parents.get(path.split('/').at(-1)!);
    else throw new Error(`Unexpected ${method} ${path}`);
    const json = JSON.stringify(value); return { ok: true, status: 200, json: async () => JSON.parse(json) };
  }));
  return { parents, calls, set child(value: DelegationDetail) { transcript = value; }, set intercept(value: typeof intercept) { intercept = value; } };
}
async function mountApp() { await act(async () => root().render(createElement(App))); }
async function mountTranscript(value = task()) { const mounted = root(); await act(async () => mounted.render(createElement(TaskTranscript, { task: value }))); return { root: mounted, render: async (next: DelegationSummary) => { await act(async () => mounted.render(createElement(TaskTranscript, { task: next }))); } }; }
async function expandSteps(open = true) { await act(async () => { const log = el<HTMLDetailsElement>('.work-log'); if (log.open !== open) log.querySelector('summary')!.click(); }); }
const region = () => el('[aria-label="Research task"]');
const transcriptSource = () => Source.instances.find(source => source.url.startsWith(bound + '/events'))!;
beforeEach(() => {
  const dom = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom; vi.stubGlobal('localStorage', dom.window.localStorage); localStorage.clear(); document.body.innerHTML = '';
  window.history.replaceState(null, '', '/#session/a'); Source.instances = []; vi.stubGlobal('EventSource', Source); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => { await act(async () => roots.splice(0).forEach(root => root.unmount())); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bound research task cards', () => {
  it('shows live transcripts automatically without launching anything', async () => {
    const api = server(); await mountApp(); expect(region().querySelector('strong')?.title).toBe('Read-only research'); expect(region().textContent).not.toContain('parent response is waiting'); expect(region().textContent).toContain('Researching');
    expect(api.calls.every(call => call.method === 'GET')).toBe(true); expect(api.calls.some(call => call.path === bound)).toBe(true);
    expect(el<HTMLDetailsElement>('.work-log').open).toBe(true); expect(el('[aria-label="Research transcript"]').textContent).toContain('Reading research.txt.'); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0); expect(window.location.hash).toBe('#session/a');
  });
  it.each(['no-summary', 'wrong-parent', 'wrong-message', 'wrong-tool', 'copied-id'] as const)('keeps %s task references inert', async variant => {
    const api = server(), value = api.parents.get('a')!;
    if (variant === 'no-summary') value.delegations = [];
    if (variant === 'wrong-parent') value.delegations![0].parentSessionId = 'forked';
    if (variant === 'wrong-message') value.delegations![0].parentMessageId = 'copied-message';
    if (variant === 'wrong-tool') value.delegations![0].toolCallId = 'other-tool';
    if (variant === 'copied-id') { delete value.messages[0].toolCalls![0].delegationId; value.messages[0].toolCalls![0].output = 'childSessionId=child-a delegationId=task-a'; }
    await mountApp(); expect(document.querySelector('[aria-label="Research task"]')).toBeNull(); expect(document.body.textContent).not.toContain('Open transcript'); expect(api.calls.some(call => call.path === bound)).toBe(false);
  });
  it('preserves parent composer draft and attachment while child updates and collapses', async () => {
    const api = server(); localStorage.setItem('litespeed:draft:v1:a', JSON.stringify({ text: 'Next parent thought', attachments: [{ name: 'notes.txt', content: 'keep' }] }));
    await mountApp(); await expandSteps();
    await act(async () => transcriptSource().emit({ id: 21, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: ' Child progress.' } }));
    expect(el('[aria-label="Research transcript"]').textContent).toContain('Child progress.'); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Next parent thought');
    await act(async () => Source.instances[0].emit({ id: 11, sessionId: 'a', type: 'message', data: { id: 'driver-update', sessionId: 'a', role: 'assistant', content: 'Reviewing the findings.', createdAt: 2 } }));
    expect(el<HTMLDetailsElement>('.work-log').open).toBe(false); expect(transcriptSource().closed).toBe(true); expect(document.body.textContent).toContain('notes.txt'); expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('cancels once against parent-bound identity and refreshes root status without clearing its draft', async () => {
    const api = server(), wait = deferred<object>(); api.intercept = (path, method) => path === bound + '/cancel' && method === 'POST' ? wait.promise : undefined;
    await mountApp(); await fill('Keep this draft'); await act(async () => { button('Cancel task', region()).click(); button('Cancel task', region()).click(); });
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([{ path: bound + '/cancel', method: 'POST' }]); expect(region().textContent).toContain('Cancelling');
    api.parents.get('a')!.delegations = [task({ status: 'cancelled' })]; api.parents.get('a')!.lastEventId = 11;
    await act(async () => wait.resolve({ delegation: task({ status: 'cancelled' }) })); expect(region().textContent).toContain('Cancelled'); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Keep this draft');
  });
  it('keeps failed cancellation explicit and retryable without a background repeat or lost draft', async () => {
    const api = server(); api.intercept = (path, method) => path.endsWith('/cancel') && method === 'POST' ? Promise.reject(new Error('Cancellation unavailable')) : undefined;
    await mountApp(); await fill('Parent draft'); await press('Cancel task', region());
    expect(region().textContent).toContain('Cancellation unavailable'); expect(button('Cancel task', region()).disabled).toBe(false); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('Parent draft');
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    api.intercept = undefined; await press('Cancel task', region()); expect(region().textContent).toContain('Cancelled'); expect(region().querySelector('[role="alert"]')).toBeNull();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  });
  it('drops open transcript and task links when reset removes their current message', async () => {
    server(); await mountApp(); await expandSteps(); const childStream = transcriptSource();
    await act(async () => Source.instances[0].emit({ id: 11, sessionId: 'a', type: 'reset', data: { messages: [] } }));
    expect(document.querySelector('[aria-label="Research task"]')).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(childStream.closed).toBe(true);
    await act(async () => Source.instances[0].emit({ id: 12, sessionId: 'a', type: 'delegation', data: task() })); expect(document.querySelector('[aria-label="Research task"]')).toBeNull();
  });
  it('ignores late cancellation and child updates after navigating away', async () => {
    const api = server(), wait = deferred<object>(); api.intercept = (path, method) => path.endsWith('/cancel') && method === 'POST' ? wait.promise : undefined;
    await mountApp(); await press('Cancel task', region()); await expandSteps(); const stream = transcriptSource(); await expandSteps(false); await click('.session-link[title="Session b"]'); await fill('B draft');
    await act(async () => { wait.reject(new Error('Old task failed')); stream.emit({ id: 21, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: 'Old child' } }); });
    expect(el('.topbar-title').textContent).toBe('Session b'); expect(el<HTMLTextAreaElement>('#message-input').value).toBe('B draft'); expect(document.querySelector('.global-alert')).toBeNull(); expect(document.body.textContent).not.toContain('Old task failed');
  });
  it('does not expose root mutation controls for a direct child URL', async () => {
    server(); window.history.replaceState(null, '', '/#session/child-a'); await mountApp();
    expect(document.querySelector('#message-input')).toBeNull(); expect(document.querySelector('[aria-label="Session actions"]')).toBeNull(); expect(document.querySelector('[aria-label="Open terminal"]')).toBeNull(); expect(document.body.textContent).toContain('couldn’t be opened');
  });
  it('merges summary events independently, deduplicates, and never revives terminal tasks', () => {
    let state = parent(); state = applyEvent(state, { id: 11, sessionId: 'a', type: 'delegation', data: task({ status: 'completed' }) });
    state = applyEvent(state, { id: 12, sessionId: 'a', type: 'delegation', data: task() }); expect(state.delegations).toHaveLength(1); expect(state.delegations![0].status).toBe('completed');
    expect(visibleDelegations(state)).toHaveLength(1); expect(visibleDelegations({ ...state, session: session('copied') })).toHaveLength(0);
  });
});

describe('independent read-only research transcript', () => {
  it('uses child cursor and no controls for approvals, questions, settings, composer or fork', async () => {
    const api = server(); api.child = child({ permissions: [{ id: 'p', sessionId: 'child-a', toolCallId: 't', tool: 'write_file', args: {}, description: 'Must not show approval' }], questions: [{ id: 'q', sessionId: 'child-a', turnId: 't', messageId: 'm', toolCallId: 'tool', question: 'Must not answer', options: [{ id: 'yes', label: 'Yes' }], createdAt: 1 }] });
    await mountTranscript(); expect(transcriptSource().url).toBe(bound + '/events?after=20');
    expect(document.querySelector('textarea')).toBeNull(); expect(document.querySelector('[aria-label="Fork session at this message"]')).toBeNull(); expect(document.querySelector('[aria-label="Permission requested"]')).toBeNull(); expect(document.body.textContent).not.toContain('Must not answer');
    await press('Refresh transcript'); expect(api.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('reconciles reconnect snapshots with newer child events without duplicate text or messages', async () => {
    const api = server(); await mountTranscript(); const stream = transcriptSource(), wait = deferred<DelegationDetail>(); api.intercept = path => path === bound ? wait.promise : undefined;
    await act(async () => stream.onopen?.());
    await act(async () => { stream.emit({ id: 21, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: ' More.' } }); stream.emit({ id: 21, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: ' More.' } }); stream.emit({ id: 22, sessionId: 'a', type: 'message', data: { id: 'wrong-parent', role: 'assistant', content: 'Wrong stream' } }); });
    await act(async () => wait.resolve(child()));
    expect(document.body.textContent).toContain('Reading research.txt. More.'); expect(document.querySelectorAll('.assistant-message')).toHaveLength(1); expect(document.body.textContent?.match(/More\./g)).toHaveLength(1); expect(document.body.textContent).not.toContain('Wrong stream');
  });
  it('loads sealed terminal snapshot on parent settlement and ignores later child stream events', async () => {
    const api = server(), view = await mountTranscript(), stream = transcriptSource();
    api.child = child({ session: session('child-a'), delegation: task({ status: 'completed' }), messages: [{ id: 'report', sessionId: 'child-a', role: 'assistant', content: 'Sealed final report', createdAt: 2 }], lastEventId: 22 });
    await view.render(task({ status: 'completed' })); expect(stream.closed).toBe(true); expect(document.body.textContent).toContain('Sealed final report');
    const reads = api.calls.length;
    await act(async () => { stream.emit({ id: 23, sessionId: 'child-a', type: 'message', data: { id: 'late', sessionId: 'child-a', role: 'assistant', content: 'Late running message', createdAt: 3 } }); stream.onerror?.(); stream.onopen?.(); });
    expect(document.body.textContent).not.toContain('Late running message'); expect(document.body.textContent).not.toContain('Reconnecting'); expect(api.calls).toHaveLength(reads);
    api.child = child(); await press('Refresh transcript'); expect(document.body.textContent).toContain('Sealed final report'); expect(document.body.textContent).not.toContain('Reading research.txt.');
  });
  it('restores a terminal transcript on reload without opening SSE or running another task', async () => {
    const api = server(); api.child = child({ session: session('child-a'), delegation: task({ status: 'cancelled' }) }); await mountTranscript(task({ status: 'cancelled' }));
    expect(Source.instances).toHaveLength(0); expect(document.querySelector('[aria-label="Research transcript"]')).not.toBeNull(); expect(api.calls).toEqual([{ path: bound, method: 'GET' }]);
  });
  it('rejects a mismatched bound detail without exposing another child transcript', async () => {
    const api = server(); api.child = child({ delegation: task({ parentSessionId: 'other' }), messages: [{ id: 'private', sessionId: 'child-a', role: 'assistant', content: 'Wrong parent transcript', createdAt: 1 }] });
    await mountTranscript(); expect(document.body.textContent).toContain('does not match this task'); expect(document.body.textContent).not.toContain('Wrong parent transcript'); expect(Source.instances).toHaveLength(0);
  });
  it('ignores delayed old transcript reads after switching task identity', async () => {
    const api = server(), wait = deferred<DelegationDetail>(); api.intercept = path => path === bound ? wait.promise : undefined;
    const view = await mountTranscript(); const second = task({ id: 'second', childSessionId: 'child-second', toolCallId: 'second-tool' });
    api.intercept = path => path.endsWith('/second') ? child({ session: session('child-second'), delegation: second, messages: [{ id: 'second-message', sessionId: 'child-second', role: 'assistant', content: 'Second transcript', createdAt: 1 }] }) : path === bound ? wait.promise : undefined;
    await view.render(second); await act(async () => wait.resolve(child()));
    expect(document.body.textContent).toContain('Second transcript'); expect(document.body.textContent).not.toContain('Reading research.txt.');
  });
  it('bounds the replay journal without losing deltas when an old snapshot resolves after 2000 updates', async () => {
    const api = server(); await mountTranscript(); const stream = transcriptSource(), wait = deferred<DelegationDetail>(); api.intercept = path => path === bound ? wait.promise : undefined;
    await act(async () => stream.onopen?.());
    await act(async () => { for (let id = 21; id <= 2025; id++) stream.emit({ id, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: 'x' } }); });
    await act(async () => wait.resolve(child()));
    expect(el('.markdown').textContent).toBe('Reading research.txt.' + 'x'.repeat(2005));
    api.intercept = undefined; api.child = child({ lastEventId: 2025, messages: [{ id: 'child-message', sessionId: 'child-a', role: 'assistant', content: 'Reading research.txt.' + 'x'.repeat(2005), createdAt: 1 }] });
    await press('Refresh transcript'); await act(async () => stream.emit({ id: 2026, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: ' Final.' } }));
    expect(el('.markdown').textContent).toBe('Reading research.txt.' + 'x'.repeat(2005) + ' Final.');
  });
  it('keeps the newest overlapping initial read and opens exactly one child stream', async () => {
    const api = server(), first = deferred<DelegationDetail>(), second = deferred<DelegationDetail>(); let reads = 0;
    api.intercept = path => path === bound ? (++reads === 1 ? first.promise : second.promise) : undefined;
    const view = await mountTranscript(); await view.render(task({ status: 'completed' }));
    await act(async () => first.resolve(child({ messages: [] })));
    await act(async () => second.resolve(child()));
    expect(Source.instances).toHaveLength(1); expect(transcriptSource().url).toBe(bound + '/events?after=20'); expect(document.body.textContent).toContain('Reading research.txt.');
  });
  it('restores via child done reread without allowing a higher-cursor live event to overwrite the sealed report', async () => {
    const api = server(); await mountTranscript(); const stream = transcriptSource(), wait = deferred<DelegationDetail>(); api.intercept = path => path === bound ? wait.promise : undefined;
    await act(async () => { stream.emit({ id: 21, sessionId: 'child-a', type: 'done', data: { status: 'idle' } }); stream.emit({ id: 30, sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: ' Not sealed.' } }); });
    await act(async () => wait.resolve(child({ session: session('child-a'), delegation: task({ status: 'completed' }), lastEventId: 22, messages: [{ id: 'sealed', sessionId: 'child-a', role: 'assistant', content: 'Sealed report only', createdAt: 1 }] })));
    expect(document.body.textContent).toContain('Sealed report only'); expect(document.body.textContent).not.toContain('Not sealed.'); expect(stream.closed).toBe(true);
  });
  it.each(['read-only', 'turn'] as const)('rejects a mismatched %s boundary', async variant => {
    const api = server(); api.child = variant === 'read-only' ? { ...child(), readOnly: false } as unknown as DelegationDetail : child({ delegation: task({ parentTurnId: 'other-turn' }) });
    await mountTranscript(); expect(document.body.textContent).toContain('does not match this task'); expect(Source.instances).toHaveLength(0);
  });
  it('shows an inert empty transcript rather than prompting for a new run', async () => {
    const api = server(); api.child = child({ messages: [] }); await mountTranscript();
    expect(document.body.textContent).toContain('No transcript yet'); expect(document.body.textContent).not.toContain('Give your agent a task'); expect(document.querySelector('textarea')).toBeNull();
  });
  it('rejects malformed or unnumbered events and supports authoritative reconnect recovery', async () => {
    const api = server(); await mountTranscript(); const stream = transcriptSource();
    await act(async () => { stream.onmessage?.({ data: 'not JSON', lastEventId: '21' }); stream.emit({ sessionId: 'child-a', type: 'delta', data: { messageId: 'child-message', delta: 'Unnumbered' } }); });
    expect(document.body.textContent).toContain('could not be read'); expect(document.body.textContent).not.toContain('Unnumbered');
    api.child = child({ lastEventId: 23, messages: [{ id: 'child-message', sessionId: 'child-a', role: 'assistant', content: 'Recovered live text', createdAt: 1 }] });
    await act(async () => stream.onerror?.()); expect(document.body.textContent).toContain('Recovered live text'); expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it('recovers explicitly after GET failure and preserves safe plain-text descriptions', async () => {
    const api = server(); api.intercept = path => path === bound ? Promise.reject(new Error('offline')) : undefined;
    await mountTranscript(task({ description: '<img src=x onerror=bad()>' })); expect(document.body.textContent).toContain('offline'); expect(document.querySelector('img')).toBeNull();
    api.intercept = undefined; await press('Refresh transcript'); expect(document.body.textContent).toContain('Reading research.txt.'); expect(api.calls.every(call => call.method === 'GET')).toBe(true);
  });
});
