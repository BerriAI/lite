import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Draft, DraftStorage } from './controller.js';

/** A private local cache. Drafts are namespaced by server and session. */
export class TerminalStorage implements DraftStorage {
  private pending = new Map<string, Draft>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly directory = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'litespeed', 'tui')) {}
  private path(key: string) { return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`); }
  load(key: string): Draft {
    if (this.pending.has(key)) return this.pending.get(key)!;
    try {
      const value = JSON.parse(readFileSync(this.path(key), 'utf8'));
      if (typeof value.text === 'string' && Array.isArray(value.attachments)) return { text: value.text, attachments: value.attachments.filter((item: unknown) => typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string') };
    } catch { /* A missing or invalid cache never prevents startup. */ }
    return { text: '', attachments: [] };
  }
  save(key: string, draft: Draft) {
    this.pending.set(key, draft);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; try { this.flush(); } catch { /* Retain pending drafts for the next write/exit. */ } }, 250);
  }
  private write(path: string, value: unknown) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  }
  preferences(): { theme?: string; mode?: 'system' | 'light' | 'dark' } {
    try { const value = JSON.parse(readFileSync(join(this.directory, 'preferences.json'), 'utf8')); return { ...(typeof value.theme === 'string' ? { theme: value.theme } : {}), ...(['system', 'light', 'dark'].includes(value.mode) ? { mode: value.mode } : {}) }; } catch { return {}; }
  }
  savePreferences(value: { theme?: string; mode?: 'system' | 'light' | 'dark' }) { this.write(join(this.directory, 'preferences.json'), value); }
  history(): string[] {
    try { const value = JSON.parse(readFileSync(join(this.directory, 'history.json'), 'utf8')); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-200) : []; } catch { return []; }
  }
  remember(text: string) {
    if (!text.trim()) return;
    this.write(join(this.directory, 'history.json'), [...this.history().filter(item => item !== text), text.slice(0, 100000)].slice(-200));
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const [key, draft] of this.pending) { this.write(this.path(key), draft); this.pending.delete(key); }
  }
}
