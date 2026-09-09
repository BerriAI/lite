// @vitest-environment jsdom
// The Steer control: visible only while a response is running, posts the
// composer text to /steer, and clears the composer without touching the queue.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { Composer } from '../client/src/Composer.js';
import type { QueueState, Settings } from '../shared/types.js';

const settings: Settings = { providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: 'http://127.0.0.1:9' }], defaultProvider: 'test', defaultModel: 'model', workspace: '/tmp', permissionMode: 'ask', maxSteps: 40, theme: 'system', mcpServers: {} };
const queue: QueueState = { items: [], paused: false };

describe('mid-turn steering control', () => {
  let root: Root, container: HTMLElement;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = (running: boolean, text: string, onSteer = vi.fn(async () => true), setText = vi.fn()) => {
    act(() => {
      root.render(React.createElement(Composer, {
        settings, selection: { providerId: 'test', model: 'model', mode: 'build' }, onSelection: () => {},
        onSend: async () => true, onQueue: async () => true, onSteer, queue, queueBusy: false,
        onQueueAction: () => {}, onCancel: () => {}, running, disabled: false, workspace: '/tmp',
        text, setText, attachments: [], setAttachments: () => {}, onSettings: () => {},
      } as any));
    });
    return { onSteer, setText };
  };
  const steerButton = () => container.querySelector('.steer-button') as HTMLButtonElement | null;

  it('is absent while idle and present while running', () => {
    render(false, 'note text');
    expect(steerButton()).toBeNull();
    render(true, 'note text');
    expect(steerButton()).not.toBeNull();
    expect(steerButton()!.getAttribute('aria-label')).toBe('Steer the running response');
  });
  it('is disabled with an empty composer and sends then clears when clicked', async () => {
    const first = render(true, '   ');
    expect(steerButton()!.disabled).toBe(true);
    expect(first.onSteer).not.toHaveBeenCalled();
    const { onSteer, setText } = render(true, 'Focus on the tests.');
    expect(steerButton()!.disabled).toBe(false);
    await act(async () => { steerButton()!.click(); });
    expect(onSteer).toHaveBeenCalledWith('Focus on the tests.');
    expect(setText).toHaveBeenCalledWith('');
  });
  it('keeps the composer text when steering fails', async () => {
    const { setText } = render(true, 'Important draft', vi.fn(async () => false));
    await act(async () => { steerButton()!.click(); });
    expect(setText).not.toHaveBeenCalledWith('');
  });
});
