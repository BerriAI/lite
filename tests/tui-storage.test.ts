import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalStorage } from '../tui/storage.js';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function storage() { const directory = mkdtempSync(join(tmpdir(), 'lite-draft-test-')); directories.push(directory); return new TerminalStorage(directory); }
describe('terminal drafts', () => {
  it('restores unsent text and attachments after restart without sharing between servers', () => {
    const cache = storage(), key = JSON.stringify(['http://one', 'session']);
    const draft = { text: 'Résumé\n你好 👩🏽‍💻', attachments: [{ name: 'source.ts', path: 'src/source.ts' }] };
    cache.save(key, draft); cache.flush();
    const next = new TerminalStorage(cache.directory);
    expect(next.load(key)).toEqual(draft);
    expect(next.load(JSON.stringify(['http://two', 'session']))).toEqual({ text: '', attachments: [] });
    expect(statSync(cache.directory).mode & 0o077).toBe(0);
    next.save(key, { text: '', attachments: [] }); next.flush();
    expect(new TerminalStorage(cache.directory).load(key).text).toBe('');
  });
  it('bounds history, deduplicates repeated prompts, and persists appearance', () => {
    const cache = storage(); for (let i = 0; i < 210; i++) cache.remember(String(i)); cache.remember('207');
    expect(cache.history()).toHaveLength(200); expect(cache.history().at(-1)).toBe('207');
    expect(cache.history().filter(text => text === '207')).toHaveLength(1);
    cache.savePreferences({ theme: 'lite', mode: 'light' });
    expect(new TerminalStorage(cache.directory).preferences()).toEqual({ theme: 'lite', mode: 'light' });
  });
});
