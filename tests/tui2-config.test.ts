import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_DEFAULTS, configFilePaths, discoverCustomThemes, dropUnknownKeybinds,
  loadTuiConfig, mergeDeep, normalizeShape, parseJsonc, resolvePlatform,
  substituteVariables, validateConfig,
  type LoadOptions, type TuiConfig,
} from '../tui2/tuiConfig.js';
import { KEYBIND_DEFAULTS } from '../tui2/keybinds.js';

function fakeFs(files: Record<string, string>): Pick<LoadOptions, 'exists' | 'readFile'> {
  return {
    exists: path => path in files,
    readFile: path => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

describe('parseJsonc', () => {
  it('strips line and block comments outside strings', () => {
    const text = `{
      // line comment
      "a": 1, /* block
      spanning lines */ "b": "has // no comment /* inside */"
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 'has // no comment /* inside */' });
  });

  it('tolerates trailing commas in objects and arrays', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 3,},}')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it('keeps escaped quotes inside strings intact', () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // ok"}')).toEqual({ a: 'say "hi" // ok' });
  });

  it('still rejects genuinely invalid JSON', () => {
    expect(() => parseJsonc('{oops}')).toThrow();
  });
});

describe('substituteVariables', () => {
  it('replaces {env:NAME} and leaves missing vars empty', () => {
    const out = substituteVariables('theme={env:MY_THEME} gap={env:MISSING}!', { env: { MY_THEME: 'lite' } });
    expect(out).toBe('theme=lite gap=!');
  });

  it('replaces {file:path} relative to baseDir, trimmed, missing → empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-config-'));
    try {
      writeFileSync(join(dir, 'token.txt'), '  secret-value \n');
      const out = substituteVariables('x={file:token.txt} y={file:nope.txt}', { baseDir: dir });
      expect(out).toBe('x=secret-value y=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('normalizeShape / mergeDeep', () => {
  it('flattens a {"tui": {...}} wrapper with top-level keys winning', () => {
    const out = normalizeShape({ tui: { theme: 'inner', scroll_speed: 5 }, theme: 'outer' });
    expect(out).toEqual({ theme: 'outer', scroll_speed: 5 });
  });

  it('merges nested records and skips undefined', () => {
    const out = mergeDeep({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 }, b: undefined as unknown as number, c: 4 });
    expect(out).toEqual({ a: { x: 1, y: 3 }, b: 1, c: 4 });
  });
});

describe('validateConfig', () => {
  it('drops bad fields individually and keeps good ones', () => {
    const warnings: string[] = [];
    const out = validateConfig({
      theme: 'lite',
      leader_timeout: -5,
      scroll_speed: 'fast',
      diff_style: 'stacked',
      mouse: false,
    }, m => warnings.push(m));
    expect(out.theme).toBe('lite');
    expect(out.leader_timeout).toBeUndefined();
    expect(out.scroll_speed).toBeUndefined();
    expect(out.diff_style).toBe('stacked');
    expect(out.mouse).toBe(false);
  });

  it('requires leader_timeout to be a positive integer', () => {
    const warn = () => {};
    expect(validateConfig({ leader_timeout: 1500 }, warn).leader_timeout).toBe(1500);
    expect(validateConfig({ leader_timeout: 1.5 }, warn).leader_timeout).toBeUndefined();
    expect(validateConfig({ leader_timeout: 0 }, warn).leader_timeout).toBeUndefined();
  });

  it('warns when the root is not an object', () => {
    const warnings: string[] = [];
    expect(validateConfig([1, 2], m => warnings.push(m))).toEqual({});
    expect(warnings).toEqual(['Config root must be an object']);
  });
});

describe('dropUnknownKeybinds', () => {
  it('keeps known names including dotted ones and drops the rest', () => {
    const warnings: string[] = [];
    const out = dropUnknownKeybinds(
      { app_exit: 'ctrl+q', 'dialog.select.prev': 'k', made_up: 'x' },
      m => warnings.push(m),
    );
    expect(Object.keys(out)).toEqual(['app_exit', 'dialog.select.prev']);
    expect(warnings).toEqual(['Unrecognized keybind: made_up']);
  });

  it('pluralizes the warning', () => {
    const warnings: string[] = [];
    dropUnknownKeybinds({ nope: 'a', also_nope: 'b' }, m => warnings.push(m));
    expect(warnings).toEqual(['Unrecognized keybinds: nope, also_nope']);
  });

  it('stays silent when everything is known', () => {
    const warnings: string[] = [];
    dropUnknownKeybinds({ app_exit: 'ctrl+q' }, m => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

describe('resolvePlatform', () => {
  const base: TuiConfig = { ...CONFIG_DEFAULTS, keybinds: {} };

  it('is a no-op when the terminal can suspend', () => {
    const out = resolvePlatform({ ...base, keybinds: { terminal_suspend: 'ctrl+q' } }, { terminalSuspend: true });
    expect(out.keybinds.terminal_suspend).toBe('ctrl+q');
    expect(out.keybinds.input_undo).toBeUndefined();
  });

  it('forces terminal_suspend off even when explicitly configured', () => {
    const out = resolvePlatform({ ...base, keybinds: { terminal_suspend: 'ctrl+q' } }, { terminalSuspend: false });
    expect(out.keybinds.terminal_suspend).toBe('none');
  });

  it('prepends ctrl+z to the default undo chord with dedupe', () => {
    const out = resolvePlatform(base, { terminalSuspend: false });
    expect(out.keybinds.input_undo).toBe(`ctrl+z,${String(KEYBIND_DEFAULTS.input_undo)}`);
    // No duplicate ctrl+z entries.
    const chords = String(out.keybinds.input_undo).split(',');
    expect(chords.filter(c => c === 'ctrl+z')).toHaveLength(1);
  });

  it('leaves an explicit input_undo verbatim', () => {
    const config = { ...base, keybinds: { input_undo: 'super+u' } };
    const out = resolvePlatform(config, { terminalSuspend: false });
    expect(out.keybinds.input_undo).toBe('super+u');
  });

  it('does not mutate its input', () => {
    const config = { ...base, keybinds: {} };
    resolvePlatform(config, { terminalSuspend: false });
    expect(config.keybinds).toEqual({});
  });
});

describe('configFilePaths', () => {
  const cwd = '/repo/pkg/app';
  const globalDir = '/home/u/.config/lite';

  it('orders global → explicit → project ancestors root-first → .lite → extra dir', () => {
    const files = fakeFs({
      [`${globalDir}/lite-tui.json`]: '{}',
      '/explicit/conf.jsonc': '{}',
      '/repo/lite-tui.json': '{}',
      '/repo/pkg/app/lite-tui.jsonc': '{}',
      '/repo/.lite/lite-tui.json': '{}',
      '/extra/lite-tui.json': '{}',
    });
    const paths = configFilePaths({
      cwd, globalConfigDir: globalDir, ...files,
      env: { LITE_TUI_CONFIG: '/explicit/conf.jsonc', LITE_CONFIG_DIR: '/extra' },
    });
    expect(paths).toEqual([
      `${globalDir}/lite-tui.json`,
      '/explicit/conf.jsonc',
      '/repo/lite-tui.json',
      '/repo/pkg/app/lite-tui.jsonc',
      '/repo/.lite/lite-tui.json',
      '/extra/lite-tui.json',
    ]);
  });

  it('suppresses project ancestor files under LITE_DISABLE_PROJECT_CONFIG', () => {
    const files = fakeFs({ '/repo/lite-tui.json': '{}', '/repo/.lite/lite-tui.json': '{}' });
    const paths = configFilePaths({
      cwd, globalConfigDir: globalDir, ...files,
      env: { LITE_DISABLE_PROJECT_CONFIG: '1' },
    });
    expect(paths).toEqual(['/repo/.lite/lite-tui.json']);
  });

  it('keeps only the highest-priority position for a duplicate path', () => {
    const files = fakeFs({ '/repo/lite-tui.json': '{}' });
    const paths = configFilePaths({
      cwd, globalConfigDir: globalDir, ...files,
      env: { LITE_TUI_CONFIG: '/repo/lite-tui.json' },
    });
    expect(paths).toEqual(['/repo/lite-tui.json']);
  });
});

describe('loadTuiConfig', () => {
  const cwd = '/repo/pkg/app';
  const globalDir = '/home/u/.config/lite';

  it('merges files in priority order — closest project file wins', () => {
    const files = fakeFs({
      [`${globalDir}/lite-tui.json`]: '{"theme": "global", "scroll_speed": 9}',
      '/repo/lite-tui.json': '{"theme": "root", "leader_timeout": 900}',
      '/repo/pkg/app/lite-tui.json': '{"theme": "closest"}',
    });
    const config = loadTuiConfig({ cwd, globalConfigDir: globalDir, env: {}, platform: 'darwin', ...files });
    expect(config.theme).toBe('closest');
    expect(config.leader_timeout).toBe(900);
    expect(config.scroll_speed).toBe(9);
  });

  it('merges keybinds across layers instead of replacing the whole table', () => {
    const files = fakeFs({
      [`${globalDir}/lite-tui.json`]: '{"keybinds": {"app_exit": "ctrl+q", "session_new": "ctrl+n"}}',
      '/repo/lite-tui.json': '{"keybinds": {"app_exit": "ctrl+shift+q"}}',
    });
    const config = loadTuiConfig({ cwd, globalConfigDir: globalDir, env: {}, platform: 'darwin', ...files });
    expect(config.keybinds.app_exit).toBe('ctrl+shift+q');
    expect(config.keybinds.session_new).toBe('ctrl+n');
  });

  it('applies substitution with the env and file base dir of each config', () => {
    const files = fakeFs({
      '/repo/lite-tui.json': '{"theme": "{env:LITE_THEME_PICK}"}',
    });
    const config = loadTuiConfig({
      cwd, globalConfigDir: globalDir, platform: 'darwin', ...files,
      env: { LITE_THEME_PICK: 'tokyonight' },
    });
    expect(config.theme).toBe('tokyonight');
  });

  it('warns and skips an unreadable or invalid file without crashing', () => {
    const warnings: string[] = [];
    const files = fakeFs({
      '/repo/lite-tui.json': '{not json at all',
      '/repo/pkg/app/lite-tui.json': '{"theme": "ok"}',
    });
    const config = loadTuiConfig({
      cwd, globalConfigDir: globalDir, env: {}, platform: 'darwin', ...files,
      warn: m => warnings.push(m),
    });
    expect(config.theme).toBe('ok');
    expect(warnings.some(w => w.includes('Skipping /repo/lite-tui.json'))).toBe(true);
  });

  it('applies platform rules: win32 gets ctrl+z undo and forced suspend-off', () => {
    const files = fakeFs({});
    const win = loadTuiConfig({ cwd, globalConfigDir: globalDir, env: {}, platform: 'win32', ...files });
    expect(win.keybinds.terminal_suspend).toBe('none');
    expect(String(win.keybinds.input_undo).startsWith('ctrl+z,')).toBe(true);
    const mac = loadTuiConfig({ cwd, globalConfigDir: globalDir, env: {}, platform: 'darwin', ...files });
    expect(mac.keybinds.terminal_suspend).toBeUndefined();
    expect(mac.keybinds.input_undo).toBeUndefined();
  });

  it('returns pure defaults when nothing exists', () => {
    const config = loadTuiConfig({ cwd, globalConfigDir: globalDir, env: {}, platform: 'darwin', ...fakeFs({}) });
    expect(config.theme).toBeUndefined();
    expect(config.leader_timeout).toBe(2000);
    expect(config.prompt).toEqual({ max_height: 75, max_width: 'auto' });
    expect(config.mouse).toBe(true);
  });
});

describe('discoverCustomThemes', () => {
  it('reads only .json files from themes/ dirs, deepest .lite wins', () => {
    const root = mkdtempSync(join(tmpdir(), 'lite-themes-'));
    try {
      const globalDir = join(root, 'global');
      const repo = join(root, 'repo');
      const app = join(repo, 'pkg', 'app');
      mkdirSync(join(globalDir, 'themes'), { recursive: true });
      mkdirSync(join(repo, '.lite', 'themes'), { recursive: true });
      mkdirSync(join(app, '.lite', 'themes'), { recursive: true });
      const theme = (primary: string) => JSON.stringify({ theme: { primary } });
      writeFileSync(join(globalDir, 'themes', 'mine.json'), theme('#111111'));
      writeFileSync(join(repo, '.lite', 'themes', 'mine.json'), theme('#222222'));
      writeFileSync(join(app, '.lite', 'themes', 'mine.json'), theme('#333333'));
      writeFileSync(join(app, '.lite', 'themes', 'other.json'), theme('#444444'));
      writeFileSync(join(app, '.lite', 'themes', 'skipped.jsonc'), theme('#555555'));
      writeFileSync(join(app, '.lite', 'themes', 'invalid.json'), '{"nope": true}');

      const warnings: string[] = [];
      const out = discoverCustomThemes({ cwd: app, globalConfigDir: globalDir, env: {}, warn: m => warnings.push(m) });
      expect(Object.keys(out).sort()).toEqual(['mine', 'other']);
      expect((out.mine.theme as Record<string, unknown>).primary).toBe('#333333');
      expect(warnings.some(w => w.includes('invalid.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors LITE_CONFIG_DIR as the final overriding directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'lite-themes-'));
    try {
      const extra = join(root, 'extra');
      const repo = join(root, 'repo');
      mkdirSync(join(extra, 'themes'), { recursive: true });
      mkdirSync(join(repo, '.lite', 'themes'), { recursive: true });
      writeFileSync(join(repo, '.lite', 'themes', 'mine.json'), JSON.stringify({ theme: { primary: '#111111' } }));
      writeFileSync(join(extra, 'themes', 'mine.json'), JSON.stringify({ theme: { primary: '#999999' } }));
      const out = discoverCustomThemes({ cwd: repo, globalConfigDir: join(root, 'global'), env: { LITE_CONFIG_DIR: extra } });
      expect((out.mine.theme as Record<string, unknown>).primary).toBe('#999999');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
