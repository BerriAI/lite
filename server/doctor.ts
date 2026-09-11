import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.js';

/** REDACTED diagnostics report (5.2). Everything here is shareable by
 * construction: NO keys, NO env values, NO file contents, NO message content,
 * and provider URLs are reduced to host only. Redaction happens at COLLECTION
 * (the sensitive value never enters the report object), not at render time. */
export interface DoctorReport {
  version: string;
  node: string;
  platform: string;
  database: { path: string; exists: boolean; sizeBytes: number; sessions: number; messages: number; integrity: string };
  settings: {
    providers: { id: string; kind: string; host: string; hasKey: boolean }[];
    mcpServers: { name: string; transport: 'stdio' | 'http' | 'unknown' }[];
    memoryEnabled: boolean;
    hookCount: number;
    sidecarCount: number;
    pluginCount: number;
    permissionRuleCount: number;
  };
  workspace: { path: string; exists: boolean; isGit: boolean };
}

/** Host only, never the full URL: a base URL can carry a path segment or
 * query that identifies a private gateway route or embeds a token. */
const hostOnly = (url: string): string => { try { return new URL(url).hostname || 'invalid-url'; } catch { return 'invalid-url'; } };

const packageVersion = (): string => {
  try {
    // Works from both server/ (dev, tsx) and dist/server/ (build): walk up
    // until a package.json appears. Bounded to 4 levels; version only.
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let up = 0; up < 4; up++) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate)) return String(JSON.parse(readFileSync(candidate, 'utf8')).version ?? 'unknown');
      directory = resolve(directory, '..');
    }
  } catch { /* fall through */ }
  return 'unknown';
};

/** Synchronous and read-only: safe to call on a live server. integrity runs
 * SQLite's own PRAGMA integrity_check (first row; 'ok' on a healthy file). */
export function collectDiagnostics(store: Store): DoctorReport {
  const settings = store.settings();
  const databasePath = join(store.directory, 'litespeed.db');
  let sizeBytes = 0, exists = false;
  try { const info = statSync(databasePath); exists = true; sizeBytes = info.size; } catch { /* honest false/0 */ }
  let sessions = 0, messages = 0, integrity = 'unavailable';
  try {
    sessions = Number((store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count);
    messages = Number((store.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count);
    const row = store.db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    integrity = String(Object.values(row ?? {})[0] ?? 'unavailable');
  } catch { /* a broken database is exactly what doctor must still report on */ }
  let workspaceExists = false, isGit = false;
  try { workspaceExists = statSync(settings.workspace).isDirectory(); isGit = existsSync(join(settings.workspace, '.git')); } catch { /* honest false */ }
  return {
    version: packageVersion(),
    node: process.version,
    platform: process.platform,
    database: { path: databasePath, exists, sizeBytes, sessions, messages, integrity },
    settings: {
      providers: settings.providers.map(provider => ({ id: provider.id, kind: provider.kind, host: hostOnly(provider.baseUrl), hasKey: Boolean(provider.apiKey) })),
      // Names + transport only: command lines and URLs can carry secrets.
      mcpServers: Object.entries(settings.mcpServers ?? {}).map(([name, config]) => ({ name, transport: config.command ? 'stdio' as const : config.url ? 'http' as const : 'unknown' as const })),
      memoryEnabled: Boolean(settings.memoryEnabled),
      hookCount: settings.hooks?.length ?? 0,
      sidecarCount: settings.sidecars?.length ?? 0,
      pluginCount: Object.keys(settings.plugins ?? {}).length,
      permissionRuleCount: settings.permissionRules?.rules?.length ?? 0,
    },
    workspace: { path: settings.workspace, exists: workspaceExists, isGit },
  };
}
