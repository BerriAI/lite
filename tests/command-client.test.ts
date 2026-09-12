// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/src/App';
import type { RunEvent, Session, SessionDetail, Settings } from '../shared/types';

const roots: Root[] = [];
function root() { const container = document.createElement('div'); document.body.append(container); const value = createRoot(container); roots.push(value); return value; }
function element<T extends Element = HTMLElement>(selector: string): T { const result = document.querySelector<T>(selector); expect(result, `Missing ${selector}`).not.toBeNull(); return result!; }
const input = () => element<HTMLTextAreaElement>('#message-input');
async function fill(value: string) {
  const target = input();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(name: string) { await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))); }
const popover = () => document.querySelector('#command-popover');
const options = () => [...document.querySelectorAll('#command-popover [role="option"]')].map(option => option.querySelector('strong')?.textContent);

class TestEventSource {
  static instances: TestEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  close() {}
  emit(event: RunEvent) { this.onmessage?.({ data: JSON.stringify(event), lastEventId: String(event.id ?? '') }); }
}

const settings: Settings = {
  providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: 'http://localhost', configured: true, models: ['model'] }],
  defaultProvider: 'fixture', defaultModel: 'model', workspace: '/workspace',
  permissionMode: 'ask', maxSteps: 20, theme: 'light', mcpServers: {},
};
const commands = [
  { name: 'deploy', description: 'Ship the current build', content: 'Deploy $1 then $2.' },
  { name: 'review', description: 'Review a workspace file', content: 'Check $1 with $ARGUMENTS' },
];
function session(id: string): Session {
  return { id, title: `Session ${id}`, workspace: `/workspace-${id}`, providerId: 'fixture', model: 'model', mode: 'build', permissionMode: 'ask', createdAt: 1, updatedAt: 1, status: 'idle', archived: false };
}
function detail(id: string): SessionDetail {
  return { session: session(id), messages: [{ id: `history-${id}`, sessionId: id, role: 'user', content: `History ${id}`, createdAt: 1 }], todos: [], permissions: [], queue: { items: [], paused: false }, lastEventId: 10 };
}
function appServer() {
  const details = new Map([['a', detail('a')]]);
  const posts: { path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (target: string, requestOptions?: RequestInit) => {
    const path = String(target), method = requestOptions?.method ?? 'GET';
    let data: unknown;
    if (method === 'POST') { posts.push({ path, body: JSON.parse(String(requestOptions?.body)) }); data = {}; }
    else if (path === '/api/settings') data = settings;
    else if (path.startsWith('/api/sessions?')) data = { sessions: [...details.values()].map(value => value.session) };
    else if (path.startsWith('/api/commands?')) data = { commands };
    else if (path.startsWith('/api/profiles?')) data = { revision: 'catalog-v1', profiles: [], skills: [{ id: 'testing', name: 'Test carefully', description: 'Check regressions.' }], diagnostics: [] };
    else if (path.startsWith('/api/sessions/')) { data = details.get(path.split('/').at(-1)!); if (!data) throw new Error(`Missing fixture for ${path}`); }
    else throw new Error(`Unexpected ${method} ${path}`);
    const response = JSON.stringify(data);
    return { ok: true, status: 200, json: async () => JSON.parse(response) };
  }));
  return { posts, sent: () => posts.filter(post => post.path === '/api/sessions/a/messages').map(post => post.body.content) };
}
async function mountApp() {
  const server = appServer();
  await act(async () => root().render(createElement(App)));
  expect(document.querySelector('#message-input')).not.toBeNull();
  return server;
}

beforeEach(() => {
  const dom = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom;
  vi.stubGlobal('localStorage', dom.window.localStorage);
  document.body.innerHTML = ''; localStorage.clear();
  window.history.replaceState(null, '', '/#session/a');
  TestEventSource.instances = [];
  vi.stubGlobal('EventSource', TestEventSource);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
  await act(async () => { for (const mounted of roots.splice(0)) mounted.unmount(); });
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('composer slash-command autocomplete', () => {
  it('opens on "/", filters by prefix, and inserts the highlighted command with ArrowDown+Enter', async () => {
    const server = await mountApp();
    await fill('/');
    expect(popover()).not.toBeNull();
    expect(options()).toEqual(expect.arrayContaining(['/models', '/setup', '/skills', '/deploy', '/review', '/testing']));
    expect(input().getAttribute('aria-activedescendant')).toBe('command-option-0');
    await fill('/re');
    expect(options()).toEqual(['/review']);
    await fill('/');
    for (let index=0;index<options().indexOf('/review');index++) await key('ArrowDown');
    expect(element('#command-popover [aria-selected="true"] strong').textContent).toBe('/review');
    await key('Enter');
    expect(input().value).toBe('/review ');
    expect(popover()).toBeNull();
    expect(server.sent()).toEqual([]);
    expect(document.querySelector('.command-hint')?.textContent).toContain('Command: review — Review a workspace file');
  });

  it('does not steal Enter while the popover is closed', async () => {
    const server = await mountApp();
    await fill('hello there');
    expect(popover()).toBeNull();
    await key('Enter');
    expect(server.sent()).toEqual(['hello there']);
  });

  it('accepts a command with Tab and closes with Escape without clearing the draft', async () => {
    const server = await mountApp();
    await fill('/dep');
    expect(options()).toEqual(['/deploy']);
    await key('Tab');
    expect(input().value).toBe('/deploy ');
    await fill('/dep');
    await key('Escape');
    expect(popover()).toBeNull();
    expect(input().value).toBe('/dep');
    expect(server.sent()).toEqual([]);
  });

  it('Escape closes the popover and Enter then submits the literal text', async () => {
    const server = await mountApp();
    await fill('/dep');
    expect(popover()).not.toBeNull();
    await key('Escape');
    expect(popover()).toBeNull();
    await key('Enter');
    expect(server.sent()).toEqual(['/dep']);
  });
});

describe('slash-command expansion at send', () => {
  it('substitutes $1 and $ARGUMENTS before the POST so downstream sees the expanded text', async () => {
    const server = await mountApp();
    await fill('/review file.ts fast');
    expect(popover()).toBeNull();
    expect(document.querySelector('.command-hint')?.textContent).toContain('Command: review');
    await key('Enter');
    expect(server.sent()).toEqual(['Check file.ts with file.ts fast']);
  });

  it('treats a quoted argument as one positional and substitutes missing positionals as empty', async () => {
    const server = await mountApp();
    await fill('/deploy "two words"');
    await key('Enter');
    expect(server.sent()).toEqual(['Deploy two words then .']);
  });

  it('sends an unknown /name literally without expansion or errors', async () => {
    const server = await mountApp();
    await fill('/nope hello');
    expect(popover()).toBeNull();
    expect(document.querySelector('.command-hint')).toBeNull();
    await key('Enter');
    expect(server.sent()).toEqual(['/nope hello']);
    expect(document.querySelector('.global-alert')).toBeNull();
  });

  it('keeps the selected skill in the composer and sends its invocation with arguments', async () => {
    const server = await mountApp();
    await fill('/test'); await key('Enter');
    expect(input().value).toBe('/testing ');expect(server.posts).toEqual([]);
    await fill('/testing check the parser');await key('Enter');
    expect(server.posts).toEqual([{path:'/api/sessions/a/messages',body:{content:'/testing check the parser',attachments:[],skills:{skillIds:['testing'],catalogRevision:'catalog-v1'}}}]);
    expect(input().value).toBe('');
  });

  it('invokes a bare skill after autocomplete and supports a leading dollar reference', async () => {
    const server = await mountApp();
    await fill('/testing');await key('Enter');
    expect(input().value).toBe('/testing ');expect(server.posts).toEqual([]);
    await key('Enter');
    expect(server.sent()).toEqual(['/testing']);
    await fill('$testing check again');await key('Enter');
    expect(server.posts[1].body.skills.skillIds).toEqual(['testing']);
    expect(server.posts.every(post=>post.path.endsWith('/messages'))).toBe(true);
  });

  it('keeps colliding skill ids out of autocomplete so templates and builtins stay first', async () => {
    await mountApp();
    await fill('/testing');
    expect(options()).toEqual(['/testing']);
    expect(document.querySelector('#command-popover [role="option"]')?.textContent).toContain('Use skill');
    await fill('/review');
    expect(options()).toEqual(['/review']);
    expect(document.querySelector('.command-hint')?.textContent).toContain('Command: review');
  });
});
