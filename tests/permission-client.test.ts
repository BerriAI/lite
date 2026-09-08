// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../client/src/Settings';
import type { PermissionRuleSet } from '../shared/permissions';
import type { Settings as SettingsType } from '../shared/types';

const roots: Root[] = [];
const base: SettingsType = { providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model'] }], defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace', permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: {}, mcpConfigRevision: 'config-a' };
const rules: PermissionRuleSet = { version: 1, rules: [{ tool: 'bash', decision: 'deny', patterns: ['rm -rf'] }, { tool: 'read_file', decision: 'allow' }] };
function el<T extends Element = HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); expect(value, selector).not.toBeNull(); return value!; }
function button(label: string, scope: ParentNode = document) { const value = [...scope.querySelectorAll('button')].find(item => item.textContent?.trim() === label); expect(value, label).toBeDefined(); return value!; }
async function press(label: string, scope: ParentNode = document) { await act(async () => button(label, scope).click()); }
async function click(selector: string) { await act(async () => el<HTMLButtonElement>(selector).click()); }
async function fill(selector: string, value: string) { const target = el<HTMLInputElement | HTMLTextAreaElement>(selector); await act(async () => { const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function choose(selector: string, value: string) { const target = el<HTMLSelectElement>(selector); await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(target, value); target.dispatchEvent(new Event('change', { bubbles: true })); }); }
function server(initial = base) {
  const calls: { path: string; method: string; body: any }[] = [];
  let saved = structuredClone(initial), failPatch: string | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input), method = options?.method ?? 'GET', body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    if (path === '/api/settings' && method === 'PATCH' && failPatch) return { ok: false, status: 400, json: async () => ({ error: failPatch }) };
    let value: unknown;
    if (path === '/api/settings' && method === 'GET') value = saved;
    else if (path === '/api/settings' && method === 'PATCH') { const { expectedMcpConfigRevision: _, ...changes } = body; saved = { ...saved, ...changes }; value = saved; }
    else if (path === '/api/mcp' && method === 'GET') value = { servers: [], configRevision: 'config-a' };
    else throw new Error(`Unexpected ${method} ${path}`);
    const json = JSON.stringify(value); return { ok: true, status: 200, json: async () => JSON.parse(json) };
  }));
  return { calls, patches: () => calls.filter(call => call.method === 'PATCH'), set failPatch(value: string | undefined) { failPatch = value; } };
}
async function mount(settings = base) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  const onSave = vi.fn(), onClose = vi.fn();
  await act(async () => root.render(createElement(Settings, { settings, onSave, onClose })));
  return { root, onSave, onClose };
}
beforeEach(() => { document.body.innerHTML = ''; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { await act(async () => roots.splice(0).forEach(root => root.unmount())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('permission rules settings editor', () => {
  it('renders existing rules with precedence and pattern help', async () => {
    await mount({ ...base, permissionRules: rules }); await press('Permissions');
    expect(el<HTMLSelectElement>('[aria-label="Rule 1 tool"]').value).toBe('bash');
    expect(el<HTMLSelectElement>('[aria-label="Rule 1 decision"]').value).toBe('deny');
    expect(el<HTMLTextAreaElement>('[aria-label="Rule 1 patterns"]').value).toBe('rm -rf');
    expect(el<HTMLSelectElement>('[aria-label="Rule 2 tool"]').value).toBe('read_file');
    expect(el<HTMLTextAreaElement>('[aria-label="Rule 2 patterns"]').value).toBe('');
    const text = document.body.textContent!;
    expect(text).toContain('Deny always wins'); expect(text).toContain('.lite/permissions.json'); expect(text).toContain('word boundary');
    expect(text).toContain('captured when the message is accepted'); expect(text).toContain('one path segment'); expect(text).toContain('not a sandbox');
  });
  it('adds a rule from the empty state and saves the exact rule set shape', async () => {
    const api = server(); const view = await mount(); await press('Permissions');
    expect(document.body.textContent).toContain('No permission rules');
    await press('Add rule'); await choose('[aria-label="Rule 1 tool"]', 'bash'); await choose('[aria-label="Rule 1 decision"]', 'allow');
    await fill('[aria-label="Rule 1 patterns"]', 'npm run *\n\ngit status');
    await press('Save settings');
    expect(api.patches()).toHaveLength(1);
    expect(api.patches()[0].body.permissionRules).toEqual({ version: 1, rules: [{ tool: 'bash', decision: 'allow', patterns: ['npm run *', 'git status'] }] });
    expect(api.patches()[0].body).not.toHaveProperty('mcpServers'); expect(api.patches()[0].body).not.toHaveProperty('mcpConfigRevision');
    expect(view.onSave).toHaveBeenCalledTimes(1); expect(view.onClose).toHaveBeenCalledTimes(1);
  });
  it('removes a rule and saves the remaining set', async () => {
    const api = server({ ...base, permissionRules: rules }); await mount({ ...base, permissionRules: rules }); await press('Permissions');
    await click('[aria-label="Remove rule 1"]'); await press('Save settings');
    expect(api.patches()[0].body.permissionRules).toEqual({ version: 1, rules: [{ tool: 'read_file', decision: 'allow' }] });
  });
  it('does not send permissionRules when rules were never edited', async () => {
    const api = server({ ...base, permissionRules: rules }); await mount({ ...base, permissionRules: rules });
    await press('Save settings');
    expect(api.patches()).toHaveLength(1); expect(api.patches()[0].body).not.toHaveProperty('permissionRules');
  });
  it('blocks save with an inline error for an over-long pattern', async () => {
    const api = server({ ...base, permissionRules: rules }); const view = await mount({ ...base, permissionRules: rules }); await press('Permissions');
    await fill('[aria-label="Rule 1 patterns"]', 'x'.repeat(401));
    expect(document.body.textContent).toContain('limited to 400 characters');
    expect(button('Save settings').disabled).toBe(true);
    await press('Save settings');
    expect(api.patches()).toHaveLength(0); expect(view.onClose).not.toHaveBeenCalled();
    await fill('[aria-label="Rule 1 patterns"]', 'x'.repeat(400));
    expect(button('Save settings').disabled).toBe(false);
  });
  it('blocks save when a rule has too many patterns', async () => {
    const api = server({ ...base, permissionRules: rules }); await mount({ ...base, permissionRules: rules }); await press('Permissions');
    await fill('[aria-label="Rule 1 patterns"]', Array.from({ length: 21 }, (_, index) => `pattern-${index}`).join('\n'));
    expect(document.body.textContent).toContain('at most 20 patterns per rule');
    expect(button('Save settings').disabled).toBe(true); expect(api.patches()).toHaveLength(0);
  });
  it('surfaces a server 400 message verbatim and keeps the draft', async () => {
    const api = server({ ...base, permissionRules: rules }); const view = await mount({ ...base, permissionRules: rules }); await press('Permissions');
    api.failPatch = 'Invalid permission rules: Patterns must be single-line printable text. at rules.0.patterns.0.';
    await fill('[aria-label="Rule 1 patterns"]', 'curl example.com');
    await press('Save settings');
    expect(document.body.textContent).toContain('Invalid permission rules: Patterns must be single-line printable text. at rules.0.patterns.0.');
    expect(view.onClose).not.toHaveBeenCalled();
    expect(el<HTMLTextAreaElement>('[aria-label="Rule 1 patterns"]').value).toBe('curl example.com');
  });
  it('preserves an unrelated provider draft while editing rules', async () => {
    const api = server(); await mount();
    await fill('input[type="password"]', 'unsaved-provider-key');
    await press('Permissions'); await press('Add rule'); await fill('[aria-label="Rule 1 patterns"]', 'git status');
    await press('Providers');
    expect(el<HTMLInputElement>('input[type="password"]').value).toBe('unsaved-provider-key');
    await press('Permissions');
    expect(el<HTMLTextAreaElement>('[aria-label="Rule 1 patterns"]').value).toBe('git status');
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
