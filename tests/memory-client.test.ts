// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../client/src/Settings';
import { Conversation } from '../client/src/Conversation';
import type { MemoryFactSummary } from '../shared/memory';
import type { SessionDetail, Settings as SettingsType } from '../shared/types';

const roots: Root[] = [];
const base: SettingsType = { providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model'] }], defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace', permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: {}, mcpConfigRevision: 'config-a' };
const facts: MemoryFactSummary[] = [
  { id: 'fact-1', name: 'build-command', description: 'Use npm run check before shipping.', pinned: false, updatedAt: Date.UTC(2026, 8, 1, 12) },
  { id: 'fact-2', name: 'style-guide', description: 'Dense single-line JSX is preferred.', pinned: false, updatedAt: Date.UTC(2026, 8, 3, 12) },
];
function el<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); expect(value, selector).not.toBeNull(); return value!; }
function button(label: string, scope: ParentNode = document) { const value = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label); expect(value, label).toBeDefined(); return value!; }
async function press(label: string, scope: ParentNode = document) { await act(async () => button(label, scope).click()); }
async function click(selector: string) { await act(async () => el<HTMLButtonElement>(selector).click()); }
async function fill(selector: string, value: string) { const target = el<HTMLInputElement>(selector); await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function toggle(selector: string) { const target = el<HTMLInputElement>(selector); await act(async () => target.click()); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function server(initial = base) {
  const calls: { path: string; method: string; body: any }[] = [];
  let saved = structuredClone(initial), memory = structuredClone(facts);
  let intercept: ((path: string, method: string) => unknown | Promise<unknown>) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    const custom = intercept?.(path, method); let value: unknown;
    if (custom !== undefined) value = await custom;
    else if (path === '/api/settings' && method === 'GET') value = saved;
    else if (path === '/api/settings' && method === 'PATCH') { const { expectedMcpConfigRevision: _, ...changes } = body; saved = { ...saved, ...changes }; value = saved; }
    else if (path === '/api/mcp' && method === 'GET') value = { servers: [], configRevision: 'config-a' };
    else if (path.startsWith('/api/memory?') && method === 'GET') value = { facts: memory };
    else if (path.startsWith('/api/memory/') && method === 'DELETE') { const name = decodeURIComponent(path.slice('/api/memory/'.length).split('?')[0]); const before = memory.length; memory = memory.filter(fact => fact.name !== name); value = { removed: memory.length < before }; }
    // Pin toggle mirrors the server: flag update + pinned-first, then name ordering.
    else if (path.startsWith('/api/memory/') && method === 'PATCH') { const name = decodeURIComponent(path.slice('/api/memory/'.length).split('?')[0]); memory = memory.map(fact => fact.name === name ? { ...fact, pinned: Boolean(body.pinned) } : fact).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name)); value = { fact: memory.find(fact => fact.name === name) }; }
    else throw new Error(`Unexpected ${method} ${path}`);
    const json = JSON.stringify(value); return { ok: true, status: 200, json: async () => JSON.parse(json) };
  }));
  return { calls, patches: () => calls.filter(call => call.method === 'PATCH'), deletes: () => calls.filter(call => call.method === 'DELETE'), memoryReads: () => calls.filter(call => call.path.startsWith('/api/memory?') && call.method === 'GET'), memoryPatches: () => calls.filter(call => call.path.startsWith('/api/memory/') && call.method === 'PATCH'), set memory(value: MemoryFactSummary[]) { memory = value; }, set intercept(value: typeof intercept) { intercept = value; } };
}
async function mount(settings = base) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  const onSave = vi.fn(), onClose = vi.fn();
  await act(async () => root.render(createElement(Settings, { settings, onSave, onClose })));
  return { root, onSave, onClose };
}
beforeEach(() => { document.body.innerHTML = ''; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { await act(async () => roots.splice(0).forEach(root => root.unmount())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('memory settings section', () => {
  it('renders the toggle on by default with the automatic-memory hint and saves memoryEnabled only when touched', async () => {
    const api = server(); const view = await mount(); await press('Workspace');
    const checkbox = el<HTMLInputElement>('.memory-toggle input[type="checkbox"]');
    expect(checkbox.checked).toBe(true);
    const text = document.body.textContent!;
    expect(text).toContain('On by default'); expect(text).toContain('background context'); expect(text).toContain('Ask and Deny rules');
    await press('Save settings');
    expect(api.patches()).toHaveLength(1); expect(api.patches()[0].body).not.toHaveProperty('memoryEnabled');
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });
  it('PATCHes memoryEnabled true after the toggle is enabled and saved', async () => {
    const disabled={...base,memoryEnabled:false}; const api = server(disabled); const view = await mount(disabled); await press('Workspace');
    await toggle('.memory-toggle input[type="checkbox"]');
    expect(el<HTMLInputElement>('.memory-toggle input[type="checkbox"]').checked).toBe(true);
    await press('Save settings');
    expect(api.patches()).toHaveLength(1);
    expect(api.patches()[0].body.memoryEnabled).toBe(true);
    expect(view.onSave).toHaveBeenCalledTimes(1); expect(view.onClose).toHaveBeenCalledTimes(1);
  });
  it('lists fetched facts with name, description, updated date and delete buttons', async () => {
    server(); await mount(); await press('Workspace');
    const list = el('.memory-facts');
    expect(list.textContent).toContain('build-command'); expect(list.textContent).toContain('Use npm run check before shipping.');
    expect(list.textContent).toContain('style-guide'); expect(list.textContent).toContain('Updated');
    expect(list.querySelectorAll('.memory-fact')).toHaveLength(2);
    expect(document.querySelector('[aria-label="Delete fact build-command"]')).not.toBeNull();
  });
  it('deletes a fact against the exact URL and refreshes the list', async () => {
    const api = server(); await mount(); await press('Workspace');
    await click('[aria-label="Delete fact build-command"]');
    expect(api.deletes()).toEqual([{ path: '/api/memory/build-command?workspace=%2Fworkspace', method: 'DELETE', body: undefined }]);
    expect(api.memoryReads().length).toBeGreaterThanOrEqual(2);
    const list = el('.memory-facts');
    expect(list.textContent).not.toContain('build-command'); expect(list.textContent).toContain('style-guide');
  });
  it('shows the empty state when memory is enabled and no facts are recorded', async () => {
    const api = server({ ...base, memoryEnabled: true } as SettingsType); api.memory = [];
    await mount({ ...base, memoryEnabled: true } as SettingsType); await press('Workspace');
    expect(document.body.textContent).toContain('No recorded facts for this workspace.');
    expect(document.querySelector('.memory-facts')).toBeNull();
  });
  it('surfaces a fetch error inline without breaking the rest of Settings', async () => {
    const api = server(); api.intercept = (path, method) => path.startsWith('/api/memory') && method === 'GET' ? Promise.reject(new Error('memory store offline')) : undefined;
    const view = await mount(); await press('Workspace');
    expect(el('[aria-label="Agent memory"] [role="alert"]').textContent).toContain('memory store offline');
    expect(el<HTMLInputElement>('.memory-toggle input[type="checkbox"]').checked).toBe(true);
    await fill('input[placeholder="/absolute/path/to/your/project"]', '/workspace');
    api.intercept = undefined;
    await press('Save settings');
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });
  it('ignores a stale memory response after the workspace changed mid-fetch', async () => {
    const api = server(); const wait = deferred<{ facts: MemoryFactSummary[] }>();
    api.intercept = (path, method) => path.startsWith('/api/memory?') && method === 'GET' && path.includes('%2Fworkspace') && !path.includes('%2Fother') ? wait.promise : undefined;
    await mount(); await press('Workspace');
    api.memory = [{ id: 'fact-b', name: 'other-fact', description: 'Belongs to the other workspace.', pinned: false, updatedAt: Date.UTC(2026, 8, 5) }];
    await fill('input[placeholder="/absolute/path/to/your/project"]', '/other');
    expect(el('.memory-facts').textContent).toContain('other-fact');
    await act(async () => wait.resolve({ facts }));
    expect(el('.memory-facts').textContent).toContain('other-fact');
    expect(document.body.textContent).not.toContain('build-command');
  });
});

describe('memory pin controls', () => {
  it('renders a pin button per fact with the pin/unpin aria labels and a Pinned tag for pinned facts', async () => {
    const api = server(); api.memory = [
      { id: 'fact-1', name: 'build-command', description: 'Use npm run check.', pinned: true, updatedAt: Date.UTC(2026, 8, 1) },
      { id: 'fact-2', name: 'style-guide', description: 'Dense JSX.', pinned: false, updatedAt: Date.UTC(2026, 8, 3) },
    ];
    await mount(); await press('Workspace');
    expect(document.querySelector('[aria-label="Unpin fact build-command"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Pin fact style-guide"]')).not.toBeNull();
    const pinnedRow = el('.memory-fact.pinned');
    expect(pinnedRow.textContent).toContain('build-command');
    expect(pinnedRow.textContent).toContain('Pinned');
  });
  it('pins via PATCH against the exact URL and reorders pinned facts first on refresh', async () => {
    const api = server(); await mount(); await press('Workspace');
    // Initial order is the fixture order: build-command then style-guide.
    expect([...document.querySelectorAll('.memory-fact strong')].map(item => item.textContent)).toEqual(['build-command', 'style-guide']);
    await click('[aria-label="Pin fact style-guide"]');
    expect(api.memoryPatches()).toEqual([{ path: '/api/memory/style-guide?workspace=%2Fworkspace', method: 'PATCH', body: { pinned: true } }]);
    // The refetched list puts the pinned fact first and flips its control to Unpin.
    expect([...document.querySelectorAll('.memory-fact strong')].map(item => item.textContent?.replace('Pinned', ''))).toEqual(['style-guide', 'build-command']);
    expect(document.querySelector('[aria-label="Unpin fact style-guide"]')).not.toBeNull();
    await click('[aria-label="Unpin fact style-guide"]');
    expect(api.memoryPatches().at(-1)).toEqual({ path: '/api/memory/style-guide?workspace=%2Fworkspace', method: 'PATCH', body: { pinned: false } });
  });
  it('surfaces a pin failure (e.g. the 10-pin cap) inline without a stray refresh masking it', async () => {
    const api = server();
    api.intercept = (path, method) => path.startsWith('/api/memory/') && method === 'PATCH' ? Promise.reject(new Error('At most 10 facts can be pinned per workspace.')) : undefined;
    await mount(); await press('Workspace');
    const readsBefore = api.memoryReads().length;
    await click('[aria-label="Pin fact build-command"]');
    expect(el('[aria-label="Agent memory"] [role="alert"]').textContent).toContain('At most 10 facts');
    // No post-failure refetch: a refresh would clear the visible error.
    expect(api.memoryReads().length).toBe(readsBefore);
  });
});

describe('memory and history tool labels', () => {
  it('renders friendly names for the new tools in the conversation transcript', async () => {
    const detail: SessionDetail = { session: { id: 'a', title: 'Session a', workspace: '/workspace', providerId: 'fixture', model: 'model', mode: 'build', permissionMode: 'ask', createdAt: 1, updatedAt: 1, status: 'idle', archived: false }, messages: [{ id: 'message-a', sessionId: 'a', role: 'assistant', content: 'Looking back.', createdAt: 1, toolCalls: [
      { id: 't1', name: 'history_search', args: { query: 'auth refactor' }, status: 'completed' },
      { id: 't2', name: 'memory_remember', args: { name: 'build-command' }, status: 'completed' },
      { id: 't3', name: 'memory_forget', args: { name: 'stale-fact' }, status: 'completed' },
      { id: 't4', name: 'memory_recall', args: { query: 'style' }, status: 'completed' },
    ] }], todos: [], permissions: [], lastEventId: 1 };
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
    await act(async () => root.render(createElement(Conversation, { detail, connection: 'connected', onDecide: vi.fn(), onFork: vi.fn(), renderQuestion: () => null, busy: false })));
    const names = [...document.querySelectorAll('.tool-name')].map(item => item.textContent);
    expect(names).toEqual(['Search history', 'Remember fact', 'Forget fact', 'Recall memory']);
  });
});
