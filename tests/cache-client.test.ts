// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../client/src/Conversation';
import type { CacheDiagnostics } from '../shared/cache';
import type { ContextSnapshot, Message, SessionDetail, Session } from '../shared/types';

const roots: Root[] = [];
function root() { const host = document.createElement('div'); document.body.append(host); const value = createRoot(host); roots.push(value); return value; }
function el<T extends Element = HTMLElement>(selector: string): T { const found = document.querySelector<T>(selector); expect(found, selector).not.toBeNull(); return found!; }
function session(): Session { return { id: 'a', title: 'Session a', workspace: '/workspace', providerId: 'fixture', model: 'model', mode: 'build', permissionMode: 'ask', status: 'idle', archived: false, createdAt: 1, updatedAt: 1 }; }
const cache = (overrides: Partial<CacheDiagnostics> = {}): CacheDiagnostics => ({ shape: { systemHash: 'aa', toolsHash: 'bb', prefixHash: 'cc', toolSchemaTokens: 1234 }, prefixChanged: false, reasons: [], ...overrides });
const snapshot = (overrides: Partial<ContextSnapshot> = {}): ContextSnapshot => ({ providerId: 'fixture', model: 'model', estimatedInputTokens: 8192, contextWindow: 16384, outputReserve: 4096, limitSource: 'override', uncertain: false, action: 'continue', ...overrides });
function detail(context: ContextSnapshot): SessionDetail {
  const message: Message = { id: 'reply', sessionId: 'a', role: 'assistant', content: 'Done.', context, createdAt: 2 };
  return { session: session(), messages: [message], todos: [], permissions: [], questions: [], queue: { items: [], paused: false }, lastEventId: 10 };
}
async function mount(context: ContextSnapshot) {
  await act(async () => root().render(createElement(Conversation, { detail: detail(context), connection: 'connected' as const, onDecide: vi.fn(), onFork: vi.fn(), renderQuestion: () => null, busy: false })));
}
const indicator = () => el('details[aria-label="Context estimate"]');
const summary = () => indicator().querySelector('summary')!.textContent ?? '';
const row = (label: string) => { const entry = [...indicator().querySelectorAll('dl > div')].find(item => item.querySelector('dt')?.textContent === label); expect(entry, `Missing row ${label}`).toBeDefined(); return entry!.querySelector('dd')!.textContent; };

beforeEach(() => { document.body.innerHTML = ''; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { await act(async () => roots.splice(0).forEach(item => item.unmount())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('prompt cache diagnostics in the context estimate', () => {
  it('renders cached-of-input with a rounded percent and the tool schema size', async () => {
    await mount(snapshot({ cache: cache({ cachedTokens: 6100, inputTokens: 8192 }) }));
    expect(row('Prompt cache')).toBe('≈6,100 cached of 8,192 input (74%)');
    expect(row('Tool schemas')).toBe('≈1,234 tokens');
  });

  it('reports honestly when the provider gave no cache usage', async () => {
    await mount(snapshot({ cache: cache({ inputTokens: 8192 }) }));
    expect(row('Prompt cache')).toBe('Not reported by provider');
  });

  it('describes a stable prefix without inventing reasons', async () => {
    await mount(snapshot({ cache: cache({ prefixChanged: false, reasons: [] }) }));
    expect(row('Prefix')).toBe('Stable since previous request');
  });

  it('joins human labels for combined prefix-change reasons', async () => {
    await mount(snapshot({ cache: cache({ prefixChanged: true, reasons: ['system', 'history_edited'] }) }));
    expect(row('Prefix')).toBe('System text changed · History edited (undo/redo)');
  });

  it('labels a first-request prefix change', async () => {
    await mount(snapshot({ cache: cache({ prefixChanged: true, reasons: ['first_turn'] }) }));
    expect(row('Prefix')).toBe('First request of this process');
  });

  it('appends the cache hit percent to the collapsed summary only when a hit is reported', async () => {
    await mount(snapshot({ cache: cache({ cachedTokens: 6100, inputTokens: 8192 }) }));
    expect(summary()).toContain('cache hit 74%');
  });

  it('keeps the collapsed summary unchanged when cache usage is unavailable or zero', async () => {
    await mount(snapshot({ cache: cache({ inputTokens: 8192 }) }));
    expect(summary()).not.toContain('cache hit');
    document.body.innerHTML = '';
    await mount(snapshot({ cache: cache({ cachedTokens: 0, inputTokens: 8192 }) }));
    expect(summary()).not.toContain('cache hit');
    document.body.innerHTML = '';
    await mount(snapshot());
    expect(summary()).not.toContain('cache hit');
  });

  it('keeps existing context rows and omits cache rows when diagnostics are absent', async () => {
    await mount(snapshot({ cache: cache({ cachedTokens: 6100, inputTokens: 8192 }) }));
    expect([...indicator().querySelectorAll('dt')].map(item => item.textContent)).toEqual(['Estimated input', 'Context window', 'Output reserve', 'Limit source', 'Model', 'Provider', 'Prompt cache', 'Prefix', 'Tool schemas']);
    expect(summary()).toContain('Context estimate · ≈8,192 input tokens');
    document.body.innerHTML = '';
    await mount(snapshot());
    expect([...indicator().querySelectorAll('dt')].map(item => item.textContent)).toEqual(['Estimated input', 'Context window', 'Output reserve', 'Limit source', 'Model', 'Provider']);
  });
});
