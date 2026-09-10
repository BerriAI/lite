// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { migrateBrowserStorage } from '../client/src/migrate-storage';
const localStorage = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window.localStorage;
beforeEach(() => localStorage.clear());
it('carries over drafts and layout without replacing new preferences or resurrecting consumed drafts', () => {
  localStorage.setItem('lite:draft:v1:session', 'original draft');
  localStorage.setItem('lite.workspace-panel-open', 'false');
  localStorage.setItem('speedrail.workspace-panel-open', 'true');
  localStorage.setItem('unrelated-app', 'unchanged');
  migrateBrowserStorage(localStorage);
  expect(localStorage.getItem('speedrail:draft:v1:session')).toBe('original draft');
  expect(localStorage.getItem('speedrail.workspace-panel-open')).toBe('true');
  localStorage.removeItem('speedrail:draft:v1:session'); migrateBrowserStorage(localStorage);
  expect(localStorage.getItem('speedrail:draft:v1:session')).toBeNull();
  expect(localStorage.getItem('unrelated-app')).toBe('unchanged');
});
