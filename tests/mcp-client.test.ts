// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../client/src/Settings';
import type { McpServerStatus } from '../shared/mcp';
import type { Settings as SettingsType } from '../shared/types';

const roots: Root[] = [];
const base: SettingsType = { providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model'] }], defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace', permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: { demo: { command: 'node', args: ['server.mjs'], env: { TOKEN: '••••••••' } } }, mcpConfigRevision: 'config-a' };
type Snapshot = { servers: McpServerStatus[]; configRevision: string };
function status(patch: Partial<McpServerStatus> = {}): McpServerStatus { return { name: 'demo', revision: 'demo-1', status: 'disconnected', tools: [], ...patch }; }
function snapshot(servers = [status()], configRevision = 'config-a'): Snapshot { return { servers, configRevision }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function el<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); expect(value, selector).not.toBeNull(); return value!; }
function button(label: string, scope: ParentNode = document) { const value = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label); expect(value, label).toBeDefined(); return value!; }
async function press(label: string, scope: ParentNode = document) { await act(async () => button(label, scope).click()); }
async function fill(selector: string, value: string) { const target = el<HTMLInputElement | HTMLTextAreaElement>(selector); await act(async () => { const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })); }); }
const card = (name = 'demo') => el(`[aria-label="MCP server ${name}"]`);
function server(initial = snapshot()) {
  const calls: { path: string; method: string; body: any }[] = [];
  let cache = structuredClone(initial), saved = structuredClone(base);
  let intercept: ((path: string, method: string, body: any) => unknown | Promise<unknown>) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    const custom = intercept?.(path, method, body);
    let value: unknown;
    if (custom !== undefined) value = await custom;
    else if (path === '/api/mcp' && method === 'GET') value = cache;
    else if (path === '/api/settings' && method === 'GET') value = saved;
    else if (path === '/api/settings' && method === 'PATCH') { const { expectedMcpConfigRevision: _, ...changes } = body; saved = { ...saved, ...changes, mcpConfigRevision: changes.mcpServers ? 'config-saved' : saved.mcpConfigRevision }; value = saved; }
    else if (path.startsWith('/api/mcp/') && method === 'POST') { const name = decodeURIComponent(path.split('/')[3]); cache.servers = cache.servers.map(item => item.name === name ? { ...item, status: 'connected', revision: `${item.revision}-next`, tools: [{ name: `mcp__${name}__read`, remoteName: 'read', description: 'Read a fixture value.' }] } : item); value = cache; }
    else if (path === '/api/providers/test') value = { ok: true, models: 1 };
    else throw new Error(`Unexpected ${method} ${path}`);
    const json = JSON.stringify(value); return { ok: true, status: 200, json: async () => JSON.parse(json) };
  }));
  return { calls, set cache(value: Snapshot) { cache = value; }, get cache() { return cache; }, set saved(value: SettingsType) { saved = value; }, set intercept(value: typeof intercept) { intercept = value; } };
}
async function mount(settings = base) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  const onSave = vi.fn(), onClose = vi.fn();
  await act(async () => root.render(createElement(Settings, { settings, onSave, onClose })));
  return { root, onSave, onClose, unmount: async () => { roots.splice(roots.indexOf(root), 1); await act(async () => root.unmount()); } };
}
beforeEach(() => { document.body.innerHTML = ''; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers(); });
afterEach(async () => { await act(async () => roots.splice(0).forEach(root => root.unmount())); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('cache-only MCP lifecycle controls', () => {
  it('reads only cache while visiting and polling, stops on tab exit and unmount', async () => {
    const api = server(), view = await mount(); expect(api.calls).toHaveLength(0);
    await press('Integrations'); expect(card().textContent).toContain('Configured · disconnected'); expect(card().textContent).toContain('Connection is closed');
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(api.calls).toHaveLength(4); expect(api.calls.every(call => call.path === '/api/mcp' && call.method === 'GET')).toBe(true);
    await press('Providers'); await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(api.calls).toHaveLength(4);
    await press('Integrations'); expect(api.calls).toHaveLength(5); await view.unmount(); await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(api.calls).toHaveLength(5);
  });
  it('connects explicitly with both reviewed revisions and no editor configuration or credentials', async () => {
    const api = server(); await mount(); await fill('input[type="password"]', 'typed-provider-key'); await press('Integrations'); await press('Connect', card());
    expect(api.calls.filter(call => call.method === 'POST')).toEqual([{ path: '/api/mcp/demo/reconnect', method: 'POST', body: { expectedRevision: 'demo-1', expectedConfigRevision: 'config-a' } }]);
    expect(card().textContent).toContain('Connected'); expect(card().textContent).toContain('mcp__demo__read');
    expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).toContain('••••••••'); await press('Providers'); expect(el<HTMLInputElement>('input[type="password"]').value).toBe('typed-provider-key');
    expect(api.calls.some(call => call.path === '/api/settings' && call.method === 'PATCH')).toBe(false);
  });
  it('refreshes and reconnects only on explicit clicks, with newly cached server revisions', async () => {
    const api = server(snapshot([status({ status: 'connected' })])); await mount(); await press('Integrations'); await press('Refresh status');
    expect(api.calls.some(call => call.method === 'POST')).toBe(false);
    await press('Refresh tools', card()); await press('Reconnect', card());
    expect(api.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body.expectedRevision])).toEqual([['/api/mcp/demo/refresh', 'demo-1'], ['/api/mcp/demo/reconnect', 'demo-1-next']]);
  });
  it('uses synchronous same-server guards while permitting independent saved-server actions', async () => {
    const api = server(snapshot([status(), status({ name: 'other', revision: 'other-1' })])), wait = deferred<Snapshot>();
    api.intercept = (path, method) => method === 'POST' && path === '/api/mcp/demo/reconnect' ? wait.promise : undefined;
    await mount(); await press('Integrations');
    await act(async () => { button('Connect', card()).click(); button('Connect', card()).click(); });
    expect(card().textContent).toContain('Loading · action in progress'); expect(button('Connect', card()).disabled).toBe(true); expect(button('Save settings').disabled).toBe(true);
    await press('Connect', card('other')); expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(2);
    await act(async () => wait.resolve(api.cache)); expect(button('Connect', card()).disabled).toBe(false);
  });
  it('blocks invalid or changed editor JSON without auto-saving, and preserves it across polling', async () => {
    const api = server(); await mount(); await press('Integrations'); await fill('[aria-label="MCP servers"]', '{ keep this incomplete draft');
    await press('Connect', card()); await press('Refresh status'); await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(api.calls.every(call => call.method === 'GET')).toBe(true); expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).toBe('{ keep this incomplete draft');
    expect(document.body.textContent).toContain('Save settings before connecting');
  });
  it('refresh failures preserve drafts and GET actual status, without automatically retrying', async () => {
    const api = server(snapshot([status({ status: 'connected' })])); api.intercept = (path, method) => method === 'POST' ? Promise.reject(new Error('MCP request failed (502).')) : undefined;
    await mount(); await press('Integrations'); api.cache = snapshot([status({ status: 'error', error: 'Connection closed.', revision: 'demo-error' })]);
    await press('Refresh tools', card()); expect(card().textContent).toContain('MCP request failed (502)'); expect(card().textContent).toContain('Connection closed.');
    await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1); expect(button('Reconnect', card()).disabled).toBe(false);
  });
  it('allows tool refresh only when connected or stale and requires reconnect after an error', async () => {
    const api = server(snapshot([status({ status: 'error', error: 'Connection failed.' })]));
    await mount(); await press('Integrations');
    expect(button('Refresh tools', card()).disabled).toBe(true);
    expect(button('Reconnect', card()).disabled).toBe(false);
    await press('Refresh tools', card()); expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await press('Reconnect', card()); expect(api.calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/mcp/demo/reconnect']);
    expect(button('Refresh tools', card()).disabled).toBe(false);
    api.cache = snapshot([status({ status: 'stale', revision: 'demo-stale' })]); await press('Refresh status');
    expect(button('Refresh tools', card()).disabled).toBe(false);
    await press('Refresh tools', card()); expect(api.calls.filter(call => call.method === 'POST').at(-1)?.path).toBe('/api/mcp/demo/refresh');
  });
  it('shows cached loading, disabled, stale and error states with inert metadata', async () => {
    const states: McpServerStatus['status'][] = ['disabled', 'connecting', 'connected', 'refreshing', 'stale', 'error'];
    server(snapshot(states.map(state => status({ name: state, status: state, reason: '<img src=x onerror=bad()>', error: state === 'error' ? '<script>bad()</script>' : undefined, tools: [{ name: 'tool-name', remoteName: 'original', description: '<script>description</script>' }] }))));
    await mount(); await press('Integrations');
    for (const state of ['disabled', 'connecting', 'refreshing']) expect(button('Reconnect', card(state)).disabled).toBe(true);
    expect(card('stale').textContent).toContain('unavailable to new turns'); expect(card('stale').textContent).toContain('not currently available');
    expect(document.querySelector('img,script')).toBeNull(); expect(card('error').textContent).toContain('<script>bad()</script>');
    expect(document.body.textContent).toContain('trusted executable code'); expect(document.body.textContent).toContain('does not guarantee a remote mutation stopped');
  });
});

describe('reviewed saved MCP configuration', () => {
  it.each(['command', 'env'] as const)('does not authorize unseen %s changes from a fresh status revision', async field => {
    const api = server(snapshot([status({ revision: 'fresh-unseen' })], 'config-b'));
    api.saved = { ...base, mcpConfigRevision: 'config-b', mcpServers: { demo: { ...base.mcpServers.demo, ...(field === 'command' ? { command: 'new-command' } : {}) } } };
    await mount(); await press('Integrations'); expect(button('Connect', card()).disabled).toBe(true); await press('Refresh status'); await press('Connect', card());
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await press('Review saved MCP configuration'); expect(el('[aria-label="Saved MCP configuration preview"]').textContent).toContain(field === 'command' ? 'new-command' : '••••••••');
    expect(button('Connect', card()).disabled).toBe(true); await press('Use reviewed configuration'); expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await press('Connect', card()); expect(api.calls.find(call => call.method === 'POST')!.body).toEqual({ expectedRevision: 'fresh-unseen', expectedConfigRevision: 'config-b' });
  });
  it('preserves dirty provider credentials and context edits while adopting only reviewed MCP configuration', async () => {
    const api = server(snapshot([status()], 'config-b')); api.saved = { ...base, mcpConfigRevision: 'config-b', mcpServers: { demo: { command: 'reviewed' } } };
    await mount(); await fill('input[type="password"]', 'unsaved-provider-key'); await press('Add context limit'); await fill('[aria-label="Model ID 1"]', 'custom-model'); await fill('[aria-label="Context window tokens 1"]', '12000');
    await press('Integrations'); await press('Review saved MCP configuration'); await press('Use reviewed configuration'); expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).toContain('reviewed');
    await press('Providers'); expect(el<HTMLInputElement>('input[type="password"]').value).toBe('unsaved-provider-key'); expect(el<HTMLInputElement>('[aria-label="Model ID 1"]').value).toBe('custom-model');
  });
  it('does not discard a dirty MCP draft when reviewing newer saved configuration', async () => {
    const api = server(snapshot([status()], 'config-b')); api.saved = { ...base, mcpConfigRevision: 'config-b' };
    await mount(); await press('Integrations'); const draft = '{"demo":{"command":"local-unsaved"}}'; await fill('[aria-label="MCP servers"]', draft);
    await press('Review saved MCP configuration'); expect(button('Use reviewed configuration').disabled).toBe(true); await press('Use reviewed configuration');
    expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).toBe(draft); expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('sends guarded MCP saves with masked values intact, never writable revision metadata', async () => {
    const api = server(), view = await mount(); await press('Integrations'); const changed = { ...base.mcpServers, demo: { ...base.mcpServers.demo, enabled: false } };
    await fill('[aria-label="MCP servers"]', JSON.stringify(changed)); await press('Save settings');
    const write = api.calls.find(call => call.method === 'PATCH')!;
    expect(write.body.expectedMcpConfigRevision).toBe('config-a'); expect(write.body.mcpServers.demo.env.TOKEN).toBe('••••••••'); expect(write.body).not.toHaveProperty('mcpConfigRevision');
    expect(view.onSave).toHaveBeenCalledTimes(1); expect(view.onClose).toHaveBeenCalledTimes(1); expect(api.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('retains dirty JSON after save conflict and does not adopt the current token from its refresh', async () => {
    const api = server(); api.intercept = (_, method) => method === 'PATCH' ? Promise.reject(new Error('MCP configuration changed (409).')) : undefined;
    const view = await mount(); await press('Integrations'); const draft = '{"demo":{"command":"mine"}}'; await fill('[aria-label="MCP servers"]', draft); api.cache = snapshot([status()], 'config-b');
    await press('Save settings'); expect(document.body.textContent).toContain('MCP configuration changed (409)'); expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).toBe(draft); expect(view.onClose).not.toHaveBeenCalled();
    await press('Save settings'); expect(api.calls.filter(call => call.method === 'PATCH').map(call => call.body.expectedMcpConfigRevision)).toEqual(['config-a', 'config-a']);
  });
  it('an unrelated provider save cannot silently adopt unseen saved executable configuration', async () => {
    const api = server(); api.saved = { ...base, mcpConfigRevision: 'config-b', mcpServers: { demo: { command: 'unseen-server' } } }; api.cache = snapshot([status()], 'config-b');
    await mount(); await fill('input[type="password"]', 'provider-draft'); await press('Save & test connection'); await press('Integrations');
    expect(button('Connect', card()).disabled).toBe(true); expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).not.toContain('unseen-server');
    expect(api.calls.find(call => call.method === 'PATCH')!.body).not.toHaveProperty('mcpServers');
  });
  it('requires explicit reviewed metadata when opened with a legacy Settings snapshot', async () => {
    const api = server(), legacy = { ...base }; delete legacy.mcpConfigRevision;
    await mount(legacy); await press('Integrations'); expect(button('Connect', card()).disabled).toBe(true);
    await press('Review saved MCP configuration'); await press('Use reviewed configuration'); await press('Connect', card());
    expect(api.calls.find(call => call.method === 'POST')!.body.expectedConfigRevision).toBe('config-a');
  });
});

describe('MCP asynchronous safety', () => {
  it('ignores a stale poll resolving after an explicit action and authoritative status refresh', async () => {
    const api = server(), old = deferred<Snapshot>(); await mount(); await press('Integrations'); let delay = true;
    api.intercept = (path, method) => path === '/api/mcp' && method === 'GET' && delay ? old.promise : undefined;
    await press('Refresh status'); delay = false; await press('Connect', card()); expect(card().textContent).toContain('Connected');
    await act(async () => old.resolve(snapshot())); expect(card().textContent).toContain('Connected'); expect(button('Refresh tools', card()).disabled).toBe(false);
  });
  it('ignores old tab reads when returning to Integrations', async () => {
    const api = server(), old = deferred<Snapshot>(); api.intercept = path => path === '/api/mcp' ? old.promise : undefined;
    await mount(); await press('Integrations'); await press('Providers'); api.intercept = undefined; api.cache = snapshot([status({ status: 'stale', reason: 'New tools available' })]);
    await press('Integrations'); await act(async () => old.resolve(snapshot())); expect(card().textContent).toContain('New tools available'); expect(card().textContent).not.toContain('Configured · disconnected');
  });
  it('does not auto-refresh, mutate callbacks or retry when a lifecycle action settles after unmount', async () => {
    const api = server(), wait = deferred<Snapshot>(); api.intercept = (_, method) => method === 'POST' ? wait.promise : undefined;
    const view = await mount(); await press('Integrations'); await press('Connect', card()); await view.unmount(); const count = api.calls.length;
    await act(async () => wait.reject(new Error('Late failure'))); await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(api.calls).toHaveLength(count); expect(view.onSave).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
  });
  it('holds the same-server lock until the post-action cache refresh settles', async () => {
    const api = server(), wait = deferred<Snapshot>(); await mount(); await press('Integrations');
    api.intercept = (path, method) => path === '/api/mcp' && method === 'GET' ? wait.promise : undefined;
    await press('Connect', card()); expect(button('Connect', card()).disabled).toBe(true); expect(button('Save settings').disabled).toBe(true);
    await press('Connect', card()); expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    await act(async () => wait.resolve(api.cache)); expect(button('Reconnect', card()).disabled).toBe(false);
  });
  it('does not adopt a late saved-config preview from an earlier tab visit', async () => {
    const api = server(), wait = deferred<SettingsType>(); api.intercept = (path, method) => path === '/api/settings' && method === 'GET' ? wait.promise : undefined;
    await mount(); await press('Integrations'); await press('Review saved MCP configuration'); await press('Providers'); await press('Integrations');
    await act(async () => wait.resolve({ ...base, mcpConfigRevision: 'late-config', mcpServers: { demo: { command: 'late-command' } } }));
    expect(document.querySelector('[aria-label="Saved MCP configuration preview"]')).toBeNull();
    expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).not.toContain('late-command');
  });
  it('does not discard edits typed while an MCP action is in flight', async () => {
    const api = server(), wait = deferred<Snapshot>(); api.intercept = (_, method) => method === 'POST' ? wait.promise : undefined;
    await mount(); await press('Integrations'); await press('Connect', card()); await fill('[aria-label="MCP servers"]', '{ typed during connection');
    await press('Providers'); await fill('input[type="password"]', 'typed-during-action');
    await act(async () => wait.resolve(snapshot([status({ status: 'connected' })]))); await press('Integrations');
    expect(el<HTMLTextAreaElement>('[aria-label="MCP servers"]').value).toBe('{ typed during connection');
    await press('Providers'); expect(el<HTMLInputElement>('input[type="password"]').value).toBe('typed-during-action');
  });
  it('keeps drafts and feedback through a lifecycle revision conflict, with explicit retry only', async () => {
    const api = server(); api.intercept = (_, method) => method === 'POST' ? Promise.reject(new Error('MCP server revision changed (409).')) : undefined;
    await mount(); await press('Integrations'); await press('Connect', card());
    expect(card().textContent).toContain('revision changed (409)'); expect(api.calls.filter(call => call.path === '/api/mcp')).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
});
