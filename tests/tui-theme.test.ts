import { afterEach, describe, expect, it } from 'vitest';
import {
  addTheme, ansiToRgba, fromHex, generateGrayScale, generateSystem, getTheme,
  hasTheme, listThemes, luminance, resetThemeRegistry, resolveTheme, rgba,
  selectedForeground, setCustomThemes, setSystemTheme, terminalMode, tint,
  toHex, THEME_TOKENS, TRANSPARENT,
  type TerminalColors, type ThemeJson,
} from '../tui/theme.js';
import { BUILTIN_THEMES, DEFAULT_THEME_NAME } from '../tui/themes.js';

afterEach(() => resetThemeRegistry());

function minimalTheme(overrides: Record<string, unknown> = {}): ThemeJson {
  const theme: Record<string, unknown> = {};
  for (const token of THEME_TOKENS) theme[token] = '#112233';
  return { theme: { ...theme, ...overrides } } as ThemeJson;
}

describe('color primitives', () => {
  it('parses 3/4/6/8-digit hex', () => {
    expect(fromHex('#abc')).toEqual(rgba(0xaa, 0xbb, 0xcc));
    expect(fromHex('#abcd')).toEqual(rgba(0xaa, 0xbb, 0xcc, 0xdd));
    expect(fromHex('#102030')).toEqual(rgba(0x10, 0x20, 0x30));
    expect(fromHex('#10203040')).toEqual(rgba(0x10, 0x20, 0x30, 0x40));
    expect(() => fromHex('#zzz')).toThrow(/Invalid hex/);
    expect(() => fromHex('#12345')).toThrow(/Invalid hex/);
  });

  it('round-trips through toHex', () => {
    expect(toHex(fromHex('#fab283'))).toBe('#fab283');
    expect(toHex(rgba(1, 2, 3, 128))).toBe('#01020380');
  });

  it('maps the 16 base ANSI colors with the exact table values', () => {
    expect(ansiToRgba(7)).toEqual(fromHex('#c0c0c0'));
    expect(ansiToRgba(8)).toEqual(fromHex('#808080'));
    expect(ansiToRgba(1)).toEqual(fromHex('#800000'));
    expect(ansiToRgba(15)).toEqual(fromHex('#ffffff'));
  });

  it('maps the 6x6x6 cube with val(x) = x*40+55 (0 stays 0)', () => {
    expect(ansiToRgba(16)).toEqual(rgba(0, 0, 0));
    expect(ansiToRgba(231)).toEqual(rgba(255, 255, 255));
    // 196 = 16 + 36*5 → pure red 255
    expect(ansiToRgba(196)).toEqual(rgba(255, 0, 0));
    // 17 = blue index 1 → 95
    expect(ansiToRgba(17)).toEqual(rgba(0, 0, 95));
  });

  it('maps the gray ramp with (code-232)*10+8', () => {
    expect(ansiToRgba(232)).toEqual(rgba(8, 8, 8));
    expect(ansiToRgba(255)).toEqual(rgba(238, 238, 238));
  });

  it('tints with a linear blend to an opaque result', () => {
    const out = tint(rgba(0, 0, 0), rgba(100, 200, 50), 0.5);
    expect(out).toEqual(rgba(50, 100, 25));
    expect(out.a).toBe(255);
  });
});

describe('resolveTheme', () => {
  it('resolves refs through defs and theme tokens', () => {
    const json = minimalTheme({ primary: 'brand', accent: 'primary' });
    json.defs = { brand: '#fab283' };
    const theme = resolveTheme(json, 'dark');
    expect(toHex(theme.primary)).toBe('#fab283');
    expect(toHex(theme.accent)).toBe('#fab283');
  });

  it('throws on circular references with the chain in the message', () => {
    const json = minimalTheme({ primary: 'a' });
    json.defs = { a: 'b', b: 'a' };
    expect(() => resolveTheme(json, 'dark')).toThrow(/Circular color reference: .*a -> b -> a/);
  });

  it('throws on unknown references and missing required tokens', () => {
    expect(() => resolveTheme(minimalTheme({ primary: 'nope' }), 'dark')).toThrow(/"nope" not found/);
    const missing = minimalTheme();
    delete (missing.theme as Record<string, unknown>).primary;
    expect(() => resolveTheme(missing, 'dark')).toThrow(/missing required token "primary"/);
  });

  it('resolves transparent, none, ANSI numbers, and dark/light variants', () => {
    const json = minimalTheme({
      primary: { dark: '#111111', light: '#eeeeee' },
      accent: 'transparent', info: 'none', warning: 3,
    });
    const dark = resolveTheme(json, 'dark');
    const light = resolveTheme(json, 'light');
    expect(toHex(dark.primary)).toBe('#111111');
    expect(toHex(light.primary)).toBe('#eeeeee');
    expect(dark.accent).toEqual(TRANSPARENT);
    expect(dark.info).toEqual(TRANSPARENT);
    expect(dark.warning).toEqual(fromHex('#808000'));
  });

  it('applies optional-token fallbacks and thinkingOpacity default', () => {
    const json = minimalTheme({ background: '#0a0a0a', backgroundElement: '#1e1e1e' });
    delete (json.theme as Record<string, unknown>).selectedListItemText;
    delete (json.theme as Record<string, unknown>).backgroundMenu;
    const theme = resolveTheme(json, 'dark');
    expect(theme.selectedListItemText).toEqual(theme.background);
    expect(theme.backgroundMenu).toEqual(theme.backgroundElement);
    expect(theme.hasSelectedListItemText).toBe(false);
    expect(theme.thinkingOpacity).toBe(0.6);
    expect(resolveTheme({ ...json, thinkingOpacity: 0.4 }, 'dark').thinkingOpacity).toBe(0.4);
  });
});

describe('selectedForeground', () => {
  it('prefers the explicit token, then contrast on transparent bg, then bg', () => {
    const explicit = resolveTheme(minimalTheme({ selectedListItemText: '#123456' }), 'dark');
    expect(toHex(selectedForeground(explicit))).toBe('#123456');

    const transparent = resolveTheme(minimalTheme({ background: 'transparent' }), 'dark');
    transparent.hasSelectedListItemText = false;
    expect(selectedForeground(transparent, rgba(250, 250, 250))).toEqual(rgba(0, 0, 0));
    expect(selectedForeground(transparent, rgba(10, 10, 10))).toEqual(rgba(255, 255, 255));

    const opaque = resolveTheme(minimalTheme({ background: '#101010' }), 'dark');
    opaque.hasSelectedListItemText = false;
    expect(toHex(selectedForeground(opaque))).toBe('#101010');
  });
});

describe('built-in themes', () => {
  it('ships the default theme plus a full catalog that all resolve', () => {
    expect(DEFAULT_THEME_NAME).toBe('lite');
    expect(Object.keys(BUILTIN_THEMES).length).toBe(33);
    for (const [name, json] of Object.entries(BUILTIN_THEMES)) {
      for (const mode of ['dark', 'light'] as const) {
        const theme = resolveTheme(json, mode);
        expect(theme.primary, `${name} ${mode}`).toBeDefined();
        expect(theme.background, `${name} ${mode}`).toBeDefined();
      }
    }
  });
});

describe('system theme', () => {
  const darkColors: TerminalColors = { defaultBackground: rgba(10, 10, 10), defaultForeground: rgba(238, 238, 238), palette: [] };

  it('detects mode from OSC-11 background only', () => {
    expect(terminalMode(darkColors)).toBe('dark');
    expect(terminalMode({ defaultBackground: rgba(250, 250, 250), palette: [] })).toBe('light');
    expect(terminalMode({ palette: [rgba(0, 0, 0)] })).toBeUndefined();
  });

  it('builds a near-black gray ramp as pure grays', () => {
    const grays = generateGrayScale(rgba(5, 5, 5), 'dark');
    expect(grays).toHaveLength(12);
    expect(grays[0]).toEqual(rgba(0, 0, 0));
    expect(grays[6]).toEqual(rgba(51, 51, 51)); // floor(6/12*0.4*255)
  });

  it('lightens a colored dark background per-channel by ratio', () => {
    const grays = generateGrayScale(rgba(40, 30, 60), 'dark');
    expect(grays[0]).toEqual(rgba(40, 30, 60));
    // Ratios keep the hue direction: channels scale together.
    expect(grays[6].r).toBeGreaterThan(40);
    expect(grays[6].b).toBeGreaterThan(grays[6].r);
  });

  it('generates the semantic slots from ANSI palette positions', () => {
    const palette: TerminalColors['palette'] = [];
    palette[1] = rgba(200, 0, 0); palette[2] = rgba(0, 200, 0); palette[3] = rgba(200, 200, 0);
    palette[5] = rgba(200, 0, 200); palette[6] = rgba(0, 200, 200);
    const theme = generateSystem({ ...darkColors, palette }, 'dark');
    expect(theme.primary).toEqual(palette[6]);
    expect(theme.accent).toEqual(palette[6]);
    expect(theme.info).toEqual(palette[6]);
    expect(theme.secondary).toEqual(palette[5]);
    expect(theme.error).toEqual(palette[1]);
    expect(theme.success).toEqual(palette[2]);
    expect(theme.warning).toEqual(palette[3]);
    // Transparent background keeps the terminal's RGB with alpha 0.
    expect(theme.background).toEqual({ r: 10, g: 10, b: 10, a: 0 });
    // Missing palette slots fall back to ansiToRgba.
    expect(generateSystem(darkColors, 'dark').error).toEqual(fromHex('#800000'));
  });

  it('uses diff alpha 0.22 dark and 0.14 light', () => {
    const dark = generateSystem(darkColors, 'dark');
    const light = generateSystem({ defaultBackground: rgba(250, 250, 250), defaultForeground: rgba(20, 20, 20), palette: [] }, 'light');
    const darkBlend = tint(rgba(10, 10, 10), fromHex('#008000'), 0.22);
    const lightBlend = tint(rgba(250, 250, 250), fromHex('#008000'), 0.14);
    expect(dark.diffAddedBg).toEqual(darkBlend);
    expect(light.diffAddedBg).toEqual(lightBlend);
  });
});

describe('theme registry', () => {
  it('resolves custom over plugin over built-in, system unshadowable', () => {
    const builtins: Record<string, ThemeJson> = { lite: minimalTheme({ primary: '#111111' }) };
    expect(toHex(getTheme('lite', 'dark', builtins)!.primary)).toBe('#111111');

    expect(addTheme('lite', minimalTheme({ primary: '#222222' }))).toBe(true);
    expect(toHex(getTheme('lite', 'dark', builtins)!.primary)).toBe('#222222');
    // First writer wins: a second plugin registration of the same name is refused.
    expect(addTheme('lite', minimalTheme({ primary: '#999999' }))).toBe(false);
    expect(toHex(getTheme('lite', 'dark', builtins)!.primary)).toBe('#222222');

    setCustomThemes({ lite: minimalTheme({ primary: '#333333' }) });
    expect(toHex(getTheme('lite', 'dark', builtins)!.primary)).toBe('#333333');

    expect(getTheme('system', 'dark', builtins)).toBeUndefined();
    const system = generateSystem({ defaultBackground: rgba(0, 0, 0), palette: [] }, 'dark');
    setSystemTheme({ dark: system, light: system });
    expect(getTheme('system', 'dark', builtins)).toBe(system);
    // A custom theme named "system" never shadows the generated one.
    setCustomThemes({ system: minimalTheme({ primary: '#444444' }) });
    expect(getTheme('system', 'dark', builtins)).toBe(system);
  });

  it('lists and reports themes including system when generated', () => {
    const builtins: Record<string, ThemeJson> = { lite: minimalTheme() };
    expect(listThemes(builtins)).toEqual(['lite']);
    expect(hasTheme('system')).toBe(false);
    const system = generateSystem({ defaultBackground: rgba(0, 0, 0), palette: [] }, 'dark');
    setSystemTheme({ dark: system, light: system });
    expect(listThemes(builtins)).toContain('system');
    expect(hasTheme('system')).toBe(true);
  });

  it('rejects invalid theme shapes', () => {
    expect(addTheme('bad', {} as ThemeJson)).toBe(false);
    setCustomThemes({ bad: { theme: null } as unknown as ThemeJson });
    expect(hasTheme('bad')).toBe(false);
  });
});

describe('luminance', () => {
  it('uses the 0.299/0.587/0.114 weights', () => {
    expect(luminance(rgba(255, 255, 255))).toBeCloseTo(1);
    expect(luminance(rgba(0, 0, 0))).toBe(0);
    expect(luminance(rgba(255, 0, 0))).toBeCloseTo(0.299);
    expect(luminance(rgba(0, 255, 0))).toBeCloseTo(0.587);
  });
});
