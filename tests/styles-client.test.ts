// @vitest-environment jsdom
// The output style picker (5.7): lives in the same surface as the model/
// planner picker, lists default + builtins + workspace .lite/styles names, and
// reports changes through the same onSelection path that PATCHes the session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { Composer } from '../client/src/Composer.js';
import type { Settings } from '../shared/types.js';

const settings: Settings = { providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: 'http://127.0.0.1:9' }], defaultProvider: 'test', defaultModel: 'model', workspace: '/tmp', permissionMode: 'ask', maxSteps: 40, theme: 'system', mcpServers: {} };

describe('output style picker', () => {
  let root: Root, container: HTMLElement;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = String(input);
      const value = path.startsWith('/api/styles') ? { styles: ['house'] } : path.startsWith('/api/models') ? { models: [] } : {};
      return { ok: true, status: 200, json: async () => value };
    }));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  const render = async (outputStyle?: string, onSelection = vi.fn()) => {
    await act(async () => {
      root.render(React.createElement(Composer, {
        settings, selection: { providerId: 'test', model: 'model', mode: 'build', permissionMode: 'ask', outputStyle }, onSelection,
        onSend: async () => true, onCancel: () => {}, running: false, disabled: false, workspace: '/tmp',
        text: '', setText: () => {}, attachments: [], setAttachments: () => {}, onSettings: () => {},
      } as any));
    });
    // Open the model picker surface that hosts the style select.
    await act(async () => { (container.querySelector('.model-trigger') as HTMLButtonElement).click(); });
    return onSelection;
  };
  const select = () => document.querySelector('[aria-label="Output style"]') as HTMLSelectElement;

  it('renders default + builtins + workspace styles in the model picker surface and reflects the current value', async () => {
    await render('learning');
    expect(select()).not.toBeNull();
    const options = [...select().options].map(option => option.value);
    expect(options).toEqual(['', 'concise', 'explanatory', 'learning', 'house']);
    expect(select().value).toBe('learning');
  });
  it('reports a chosen style and clears with null through onSelection', async () => {
    const onSelection = await render(undefined);
    await act(async () => { select().value = 'concise'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({ outputStyle: 'concise' }));
    const clearing = await render('concise');
    await act(async () => { select().value = ''; select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(clearing).toHaveBeenCalledWith(expect.objectContaining({ outputStyle: null }));
  });
});
