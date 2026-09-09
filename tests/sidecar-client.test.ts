// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../client/src/Conversation';
import type { Message, SessionDetail, Session, ToolCall } from '../shared/types';

const roots: Root[] = [];
function root() { const host = document.createElement('div'); document.body.append(host); const value = createRoot(host); roots.push(value); return value; }
function session(): Session { return { id: 'a', title: 'Session a', workspace: '/workspace', providerId: 'fixture', model: 'model', mode: 'build', permissionMode: 'ask', status: 'idle', archived: false, createdAt: 1, updatedAt: 1 }; }
function detail(tool: ToolCall): SessionDetail {
  const message: Message = { id: 'reply', sessionId: 'a', role: 'assistant', content: 'Done.', toolCalls: [tool], createdAt: 2 };
  return { session: session(), messages: [message], todos: [], permissions: [], questions: [], queue: { items: [], paused: false }, lastEventId: 10 };
}
async function mount(tool: ToolCall) {
  await act(async () => root().render(createElement(Conversation, { detail: detail(tool), connection: 'connected' as const, onDecide: vi.fn(), onFork: vi.fn(), renderQuestion: () => null, busy: false })));
}
const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({ id: 't1', name: 'write_file', args: { path: 'out.txt', content: 'hold my [redacted] token' }, status: 'completed', output: 'Wrote out.txt', ...overrides });

beforeEach(() => { document.body.innerHTML = ''; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { await act(async () => roots.splice(0).forEach(item => item.unmount())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('sidecar interception attribution on tool cards', () => {
  it('an intercepted tool renders the "modified by" tag and the original arguments above the executed ones', async () => {
    await mount(call({ intercepted: { by: 'redactor', originalArgs: { path: 'out.txt', content: 'hold my SECRET token' }, reason: 'Redacted a secret' } }));
    const tag = document.querySelector('.tool-intercepted-tag')!;
    expect(tag).not.toBeNull();
    expect(tag.textContent).toBe('modified by redactor');
    expect(tag.getAttribute('title')).toBe('Redacted a secret'); // The reason is inspectable.
    const titles = [...document.querySelectorAll('.tool-section-title')].map(item => item.textContent);
    // Original arguments render ABOVE the (modified) Arguments in the expanded body.
    expect(titles.indexOf('Original arguments')).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf('Original arguments')).toBeLessThan(titles.indexOf('Arguments'));
    const bodies = [...document.querySelectorAll('.tool-body pre')].map(item => item.textContent ?? '');
    expect(bodies[0]).toContain('hold my SECRET token');   // Original preserved.
    expect(bodies[1]).toContain('hold my [redacted] token'); // Executed args shown as Arguments.
  });

  it('an ordinary tool renders no tag and no Original arguments section', async () => {
    await mount(call());
    expect(document.querySelector('.tool-intercepted-tag')).toBeNull();
    expect([...document.querySelectorAll('.tool-section-title')].map(item => item.textContent)).not.toContain('Original arguments');
  });
});
