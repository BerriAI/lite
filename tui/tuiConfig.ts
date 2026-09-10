/** Terminal-client configuration loader. Config lives in `speedrail-tui.json` /
 * `speedrail-tui.jsonc` and merges, later wins:
 *   1. global config dir (~/.config/speedrail)
 *   2. SPEEDRAIL_TUI_CONFIG explicit path
 *   3. project files walking up from cwd, applied root-first so the closest
 *      file wins (suppressed by SPEEDRAIL_DISABLE_PROJECT_CONFIG)
 *   4. every `.speedrail` directory from cwd upward, plus SPEEDRAIL_CONFIG_DIR
 *
 * Files are JSONC (comments + trailing commas), with `{env:VAR}` and
 * `{file:path}` substitution (missing → empty string). A file that fails to
 * read, parse, or validate is logged and skipped — startup never crashes on a
 * bad config. Unknown keybind names are silently dropped so a config written
 * for a newer build still loads. */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { BindingValue } from './keybinds.js';
import { KEYBIND_DEFAULTS, LEADER_TIMEOUT_DEFAULT } from './keybinds.js';
import type { ThemeJson } from './theme.js';
import { isThemeJson } from './theme.js';

export const CONFIG_BASENAMES = ['speedrail-tui.json', 'speedrail-tui.jsonc'] as const;

export interface AttentionConfig {
  enabled: boolean;
  focus_only?: boolean;
  sounds?: boolean;
  sound_complete?: string;
  sound_permission?: string;
  volume?: number;
}

export interface TuiConfig {
  theme?: string;
  keybinds: Record<string, BindingValue>;
  leader_timeout: number;
  attention: AttentionConfig;
  prompt: { max_height: number; max_width: number | 'auto' };
  scroll_speed: number;
  scroll_acceleration: { enabled: boolean };
  diff_style: 'auto' | 'stacked';
  /** Undefined when no cursor block is configured — defaults apply only when
   * the object is present. */
  cursor?: { style?: 'block' | 'bar' | 'underline'; blink?: boolean };
  mouse: boolean;
}

export const CONFIG_DEFAULTS: TuiConfig = {
  theme: undefined,
  keybinds: {},
  leader_timeout: LEADER_TIMEOUT_DEFAULT,
  attention: { enabled: false },
  prompt: { max_height: 75, max_width: 'auto' },
  scroll_speed: 3,
  scroll_acceleration: { enabled: false },
  diff_style: 'auto',
  cursor: undefined,
  mouse: true,
};

// ---------------------------------------------------------------------------
// JSONC: strip comments and trailing commas without touching string contents.

export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  // Trailing commas: a comma followed only by whitespace and a closer.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// {env:VAR} / {file:path} substitution. Missing values become empty strings.

export function substituteVariables(text: string, options: { env?: Record<string, string | undefined>; baseDir?: string } = {}): string {
  const env = options.env ?? process.env;
  return text
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? '')
    .replace(/\{file:([^}]+)\}/g, (_, path: string) => {
      try {
        const full = isAbsolute(path) ? path : resolve(options.baseDir ?? '.', path);
        return readFileSync(full, 'utf8').trim();
      } catch { return ''; }
    });
}

// ---------------------------------------------------------------------------
// Merge + normalize.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeDeep(base: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    out[key] = isRecord(value) && isRecord(out[key]) ? mergeDeep(out[key] as Record<string, unknown>, value) : value;
  }
  return out;
}

/** A nested `{"tui": {...}}` wrapper is flattened; top-level keys win. */
export function normalizeShape(raw: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(raw.tui)) return raw;
  const { tui, ...top } = raw;
  return mergeDeep(tui as Record<string, unknown>, top);
}

/** Drop keybind names that no build of Speedrail defines; the rest still applies. */
export function dropUnknownKeybinds(keybinds: Record<string, unknown>, warn: (message: string) => void): Record<string, BindingValue> {
  const out: Record<string, BindingValue> = {};
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(keybinds)) {
    if (name in KEYBIND_DEFAULTS) out[name] = value as BindingValue;
    else unknown.push(name);
  }
  if (unknown.length > 0) warn(`Unrecognized keybind${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  return out;
}

/** Validate one parsed file into a partial config; bad fields are dropped
 * individually so one typo never discards the whole file. */
export function validateConfig(raw: unknown, warn: (message: string) => void): Partial<TuiConfig> {
  if (!isRecord(raw)) { warn('Config root must be an object'); return {}; }
  const shaped = normalizeShape(raw);
  const out: Partial<TuiConfig> = {};
  if (typeof shaped.theme === 'string') out.theme = shaped.theme;
  if (isRecord(shaped.keybinds)) out.keybinds = dropUnknownKeybinds(shaped.keybinds, warn);
  if (typeof shaped.leader_timeout === 'number' && Number.isInteger(shaped.leader_timeout) && shaped.leader_timeout > 0) {
    out.leader_timeout = shaped.leader_timeout;
  }
  if (isRecord(shaped.attention)) out.attention = { enabled: false, ...shaped.attention } as AttentionConfig;
  if (isRecord(shaped.prompt)) {
    out.prompt = { ...CONFIG_DEFAULTS.prompt };
    if (typeof shaped.prompt.max_height === 'number' && Number.isFinite(shaped.prompt.max_height) && shaped.prompt.max_height >= 10 && shaped.prompt.max_height <= 85) out.prompt.max_height = shaped.prompt.max_height;
    if ((typeof shaped.prompt.max_width === 'number' && Number.isInteger(shaped.prompt.max_width) && shaped.prompt.max_width >= 20) || shaped.prompt.max_width === 'auto') out.prompt.max_width = shaped.prompt.max_width;
  }
  if (typeof shaped.scroll_speed === 'number' && shaped.scroll_speed > 0) out.scroll_speed = shaped.scroll_speed;
  if (isRecord(shaped.scroll_acceleration) && typeof shaped.scroll_acceleration.enabled === 'boolean') {
    out.scroll_acceleration = { enabled: shaped.scroll_acceleration.enabled };
  }
  if (shaped.diff_style === 'auto' || shaped.diff_style === 'stacked') out.diff_style = shaped.diff_style;
  if (isRecord(shaped.cursor)) out.cursor = shaped.cursor as TuiConfig['cursor'];
  if (typeof shaped.mouse === 'boolean') out.mouse = shaped.mouse;
  return out;
}

// ---------------------------------------------------------------------------
// Platform conditionals.

/** Apply platform rules without mutating the input. When the terminal cannot
 * suspend (Windows): terminal_suspend is forced off even if configured, and
 * ctrl+z is prepended to the default undo chord unless the user set one. */
export function resolvePlatform(config: TuiConfig, options: { terminalSuspend: boolean }): TuiConfig {
  const keybinds = { ...config.keybinds };
  if (!options.terminalSuspend) {
    keybinds.terminal_suspend = 'none';
    if (!('input_undo' in config.keybinds)) {
      const base = String(KEYBIND_DEFAULTS.input_undo);
      const chords = ['ctrl+z', ...base.split(',')].filter((chord, i, all) => all.indexOf(chord) === i);
      keybinds.input_undo = chords.join(',');
    }
  }
  return { ...config, keybinds };
}

// ---------------------------------------------------------------------------
// Discovery + load.

export interface LoadOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  globalConfigDir?: string;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
  /** Test hook: substitute file reads. */
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}

function defaultGlobalConfigDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? join(xdg, 'speedrail') : join(homedir(), '.config', 'speedrail');
}

function firstConfigIn(dir: string, exists: (path: string) => boolean): string[] {
  return CONFIG_BASENAMES.map(name => join(dir, name)).filter(exists);
}

/** Directories from cwd up to the filesystem root, root-first. */
function ancestors(cwd: string): string[] {
  const chain: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.reverse();
}

/** Enumerate config file paths in merge order (earliest = lowest priority). */
export function configFilePaths(options: LoadOptions = {}): string[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? ((path: string) => {
    try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
  });
  const paths: string[] = [];
  paths.push(...firstConfigIn(options.globalConfigDir ?? defaultGlobalConfigDir(env), exists));
  const explicit = env.SPEEDRAIL_TUI_CONFIG;
  if (explicit && exists(explicit)) paths.push(explicit);
  if (!env.SPEEDRAIL_DISABLE_PROJECT_CONFIG) {
    for (const dir of ancestors(cwd)) paths.push(...firstConfigIn(dir, exists));
  }
  for (const dir of ancestors(cwd)) paths.push(...firstConfigIn(join(dir, '.speedrail'), exists));
  const extra = env.SPEEDRAIL_CONFIG_DIR;
  if (extra) paths.push(...firstConfigIn(extra, exists));
  // The same file reachable twice keeps only its highest-priority position.
  return paths.filter((path, i) => paths.lastIndexOf(path) === i);
}

/** Load, merge, validate, and platform-resolve the effective TUI config. */
export function loadTuiConfig(options: LoadOptions = {}): TuiConfig {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`[speedrail-tui] ${message}\n`));
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const env = options.env ?? process.env;
  let merged: Record<string, unknown> = {};
  for (const path of configFilePaths(options)) {
    try {
      const text = substituteVariables(read(path), { env, baseDir: dirname(path) });
      const parsed = parseJsonc(text);
      const valid = validateConfig(parsed, message => warn(`${path}: ${message}`));
      merged = mergeDeep(merged, valid as Record<string, unknown>);
    } catch (error) {
      warn(`Skipping ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const config: TuiConfig = {
    ...CONFIG_DEFAULTS,
    ...merged,
    keybinds: { ...(merged.keybinds as Record<string, BindingValue> | undefined) },
    prompt: { ...CONFIG_DEFAULTS.prompt, ...(merged.prompt as TuiConfig['prompt'] | undefined) },
    attention: { ...CONFIG_DEFAULTS.attention, ...(merged.attention as AttentionConfig | undefined) },
    scroll_acceleration: { ...CONFIG_DEFAULTS.scroll_acceleration, ...(merged.scroll_acceleration as TuiConfig['scroll_acceleration'] | undefined) },
  };
  const platform = options.platform ?? process.platform;
  return resolvePlatform(config, { terminalSuspend: platform !== 'win32' });
}

// ---------------------------------------------------------------------------
// Custom theme discovery: <config dir>/themes/*.json, non-recursive, dotfiles
// and symlinks included, .jsonc NOT discovered. Later directories overwrite
// earlier ones, so the deepest .speedrail/themes/ (nearest cwd) wins.

export function themeDirectories(options: LoadOptions = {}): string[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const dirs: string[] = [options.globalConfigDir ?? defaultGlobalConfigDir(env)];
  for (const dir of ancestors(cwd)) dirs.push(join(dir, '.speedrail'));
  const extra = env.SPEEDRAIL_CONFIG_DIR;
  if (extra) dirs.push(extra);
  return dirs;
}

export function discoverCustomThemes(options: LoadOptions = {}): Record<string, ThemeJson> {
  const warn = options.warn ?? (() => {});
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const out: Record<string, ThemeJson> = {};
  for (const dir of themeDirectories(options)) {
    const themesDir = join(dir, 'themes');
    let entries: string[];
    try { entries = readdirSync(themesDir); } catch { continue; }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const path = join(themesDir, entry);
      try {
        const parsed = parseJsonc(read(path));
        if (isThemeJson(parsed)) out[basename(entry, '.json')] = parsed;
        else warn(`Skipping theme ${path}: not a valid theme file`);
      } catch (error) {
        warn(`Skipping theme ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return out;
}
