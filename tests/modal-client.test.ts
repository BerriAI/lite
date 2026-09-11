// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from '../client/src/ui';

let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<button id="opener">Settings</button><div id="root"></div>';
  document.getElementById('opener')!.focus();
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('keeps focus on a credential field selected immediately after opening', async () => {
  await act(async () => root.render(createElement(Modal, { title: 'Settings', onClose: () => {}, children: [
    createElement('input', { key: 'name', id: 'name', defaultValue: 'Gateway' }),
    createElement('input', { key: 'key', id: 'key', type: 'password' }),
  ] })));
  const key = document.getElementById('key')!;
  key.focus();
  await act(async () => vi.advanceTimersByTime(100));
  expect(document.activeElement).toBe(key);
  await act(async () => root.unmount());
  expect(document.activeElement).toBe(document.getElementById('opener'));
});
