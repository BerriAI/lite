// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { migrateBrowserStorage } from '../client/src/migrate-storage';
const localStorage = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window.localStorage;
beforeEach(() => localStorage.clear());
it.each(['lite', 'speedrail'])('carries over drafts and layout without replacing new preferences or resurrecting consumed drafts', (legacy) => {
  localStorage.setItem(`${legacy}:draft:v1:session`, 'original draft');
  localStorage.setItem(`${legacy}.workspace-panel-open`, 'false');
  localStorage.setItem('litespeed.workspace-panel-open', 'true');
  localStorage.setItem('unrelated-app', 'unchanged');
  migrateBrowserStorage(localStorage);
  expect(localStorage.getItem('litespeed:draft:v1:session')).toBe('original draft');
  expect(localStorage.getItem('litespeed.workspace-panel-open')).toBe('true');
  localStorage.removeItem('litespeed:draft:v1:session'); migrateBrowserStorage(localStorage);
  expect(localStorage.getItem('litespeed:draft:v1:session')).toBeNull();
  expect(localStorage.getItem('unrelated-app')).toBe('unchanged');
});
