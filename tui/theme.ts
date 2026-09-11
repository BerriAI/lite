/** Theme engine for the terminal client. Framework-free: pure data in, resolved
 * RGBA tokens out, so every rule is unit-testable without a renderer.
 *
 * A theme file is `{ defs?: Record<string,ColorValue>, theme: Record<token,ColorValue> }`.
 * Color values may be hex strings, ANSI 0-255 numbers, references to defs or
 * other tokens (with cycle detection), or `{ dark, light }` pairs picked by the
 * active mode. The `system` theme is generated live from the terminal's
 * reported palette and background. */

export interface RGBA { r: number; g: number; b: number; a: number }

export type ThemeMode = 'dark' | 'light';

export type ColorValue = string | number | RGBA | { dark: ColorValue; light: ColorValue };

/** Every color token a theme resolves to. Kept in one tuple so the schema and
 * the resolver can never drift apart. */
export const THEME_TOKENS = [
  // Semantic
  'primary', 'secondary', 'accent', 'error', 'warning', 'success', 'info',
  // Text
  'text', 'textMuted', 'selectedListItemText',
  // Backgrounds
  'background', 'backgroundPanel', 'backgroundElement', 'backgroundMenu',
  // Borders
  'border', 'borderActive', 'borderSubtle',
  // Diff
  'diffAdded', 'diffRemoved', 'diffContext', 'diffHunkHeader',
  'diffHighlightAdded', 'diffHighlightRemoved', 'diffAddedBg', 'diffRemovedBg',
  'diffContextBg', 'diffLineNumber', 'diffAddedLineNumberBg', 'diffRemovedLineNumberBg',
  // Markdown
  'markdownText', 'markdownHeading', 'markdownLink', 'markdownLinkText',
  'markdownCode', 'markdownBlockQuote', 'markdownEmph', 'markdownStrong',
  'markdownHorizontalRule', 'markdownListItem', 'markdownListEnumeration',
  'markdownImage', 'markdownImageText', 'markdownCodeBlock',
  // Syntax
  'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
  'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export type Theme = Record<ThemeToken, RGBA> & { thinkingOpacity: number; hasSelectedListItemText: boolean };

export interface ThemeJson {
  defs?: Record<string, ColorValue>;
  theme: Partial<Record<ThemeToken, ColorValue>> & Record<string, ColorValue>;
  thinkingOpacity?: number;
}

/** Tokens a theme file may omit; everything else is required. */
const OPTIONAL_TOKENS = new Set<ThemeToken>(['selectedListItemText', 'backgroundMenu']);

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function rgba(r: number, g: number, b: number, a = 255): RGBA {
  return { r, g, b, a };
}

export function fromHex(hex: string): RGBA {
  const raw = hex.replace(/^#/, '');
  const size = raw.length === 3 || raw.length === 4 ? 1 : 2;
  const parse = (i: number) => {
    const piece = raw.slice(i * size, i * size + size);
    const value = parseInt(size === 1 ? piece + piece : piece, 16);
    if (Number.isNaN(value)) throw new Error(`Invalid hex color "${hex}"`);
    return value;
  };
  const count = raw.length / size;
  if (count !== 3 && count !== 4) throw new Error(`Invalid hex color "${hex}"`);
  return rgba(parse(0), parse(1), parse(2), count === 4 ? parse(3) : 255);
}

export function toHex(color: RGBA): string {
  const piece = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${piece(color.r)}${piece(color.g)}${piece(color.b)}${color.a === 255 ? '' : piece(color.a)}`;
}

/** xterm 256-color index → RGBA: 16 fixed, 216 cube, 24 grays. */
export function ansiToRgba(code: number): RGBA {
  const table = [
    '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
    '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
  ];
  if (code >= 0 && code <= 15) return fromHex(table[code]);
  if (code >= 16 && code <= 231) {
    const index = code - 16;
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    return rgba(val(Math.floor(index / 36)), val(Math.floor(index / 6) % 6), val(index % 6));
  }
  if (code >= 232 && code <= 255) {
    const gray = (code - 232) * 10 + 8;
    return rgba(gray, gray, gray);
  }
  return rgba(0, 0, 0);
}

/** Linear blend of overlay onto base; result is opaque. */
export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const mix = (b: number, o: number) => Math.round(b + (o - b) * alpha);
  return rgba(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b));
}

export function luminance(color: RGBA): number {
  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255;
}

/** Foreground to paint on a selected row: explicit token, else black/white by
 * contrast when the background is transparent, else the background color. */
export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  if (theme.hasSelectedListItemText) return theme.selectedListItemText;
  if (theme.background.a === 0) {
    return luminance(bg ?? theme.primary) > 0.5 ? rgba(0, 0, 0) : rgba(255, 255, 255);
  }
  return theme.background;
}

function isRgba(value: unknown): value is RGBA {
  return typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value && 'a' in value;
}

/** Resolve one color value against defs + partially-resolved theme, following
 * references with cycle detection. */
function resolveColor(value: ColorValue, defs: Record<string, ColorValue>, theme: Record<string, ColorValue>, mode: ThemeMode, chain: string[]): RGBA {
  if (typeof value === 'number') return ansiToRgba(value);
  if (isRgba(value)) return value;
  if (typeof value === 'object') return resolveColor(value[mode], defs, theme, mode, chain);
  if (value === 'transparent' || value === 'none') return TRANSPARENT;
  if (value.startsWith('#')) return fromHex(value);
  // Defs and theme tokens are separate namespaces: a token may legally point
  // at a def of the same name, so cycle keys carry the namespace while the
  // error message shows plain names.
  const inDefs = value in defs;
  const key = `${inDefs ? 'def' : 'theme'}:${value}`;
  if (chain.includes(key)) {
    const names = [...chain, key].map(entry => entry.slice(entry.indexOf(':') + 1));
    throw new Error(`Circular color reference: ${names.join(' -> ')}`);
  }
  const target = inDefs ? defs[value] : theme[value];
  if (target === undefined) throw new Error(`Color reference "${value}" not found in defs or theme`);
  return resolveColor(target, defs, theme, mode, [...chain, key]);
}

/** Resolve a theme file into a full token table for the given mode. */
export function resolveTheme(json: ThemeJson, mode: ThemeMode): Theme {
  const defs = json.defs ?? {};
  const out = {} as Record<string, RGBA> & { thinkingOpacity: number; hasSelectedListItemText: boolean };
  for (const token of THEME_TOKENS) {
    const value = json.theme[token];
    if (value === undefined) {
      if (!OPTIONAL_TOKENS.has(token)) throw new Error(`Theme is missing required token "${token}"`);
      continue;
    }
    out[token] = resolveColor(value, defs, json.theme, mode, [`theme:${token}`]);
  }
  out.hasSelectedListItemText = out.selectedListItemText !== undefined;
  out.selectedListItemText ??= out.background;
  out.backgroundMenu ??= out.backgroundElement;
  out.thinkingOpacity = json.thinkingOpacity ?? 0.6;
  return out as Theme;
}

// ---------------------------------------------------------------------------
// System theme generation from the live terminal palette.

export interface TerminalColors {
  defaultBackground?: RGBA;
  defaultForeground?: RGBA;
  palette: (RGBA | undefined)[];
}

/** Light/dark from the OSC-11 background only; undefined when unreported. */
export function terminalMode(colors: TerminalColors): ThemeMode | undefined {
  if (!colors.defaultBackground) return undefined;
  return luminance(colors.defaultBackground) > 0.5 ? 'light' : 'dark';
}

/** 12-step ramp from the terminal background toward the opposite pole. */
export function generateGrayScale(bg: RGBA, mode: ThemeMode): RGBA[] {
  const lum = luminance(bg) * 255;
  const grays: RGBA[] = [];
  for (let i = 0; i < 12; i++) {
    const factor = i / 12;
    if (mode === 'dark') {
      if (lum < 10) {
        const v = Math.floor(factor * 0.4 * 255);
        grays.push(rgba(v, v, v));
      } else {
        const target = lum + (255 - lum) * factor * 0.4;
        const ratio = target / Math.max(lum, 1);
        grays.push(rgba(Math.min(255, Math.round(bg.r * ratio)), Math.min(255, Math.round(bg.g * ratio)), Math.min(255, Math.round(bg.b * ratio))));
      }
    } else if (lum > 245) {
      const v = Math.round(255 - factor * 0.4 * 255);
      grays.push(rgba(v, v, v));
    } else {
      const ratio = 1 - factor * 0.4;
      grays.push(rgba(Math.max(0, Math.round(bg.r * ratio)), Math.max(0, Math.round(bg.g * ratio)), Math.max(0, Math.round(bg.b * ratio))));
    }
  }
  return grays;
}

function generateMutedText(bg: RGBA, mode: ThemeMode): RGBA {
  const lum = luminance(bg) * 255;
  if (mode === 'dark') {
    if (lum < 10) return rgba(180, 180, 180);
    const v = Math.min(Math.floor(160 + lum * 0.3), 200);
    return rgba(v, v, v);
  }
  if (lum > 245) return rgba(75, 75, 75);
  const v = Math.max(Math.floor(100 - (255 - lum) * 0.2), 60);
  return rgba(v, v, v);
}

/** Build the `system` theme from the terminal's palette + background. The
 * background token keeps the terminal's RGB with alpha 0 so transparency in
 * the emulator is preserved. */
export function generateSystem(colors: TerminalColors, mode: ThemeMode): Theme {
  const col = (i: number) => colors.palette[i] ?? ansiToRgba(i);
  const bg = colors.defaultBackground ?? col(0);
  const fg = colors.defaultForeground ?? col(7);
  const grays = generateGrayScale(bg, mode);
  const red = col(1), green = col(2), yellow = col(3), blue = col(4), magenta = col(5), cyan = col(6);
  const diffAlpha = mode === 'dark' ? 0.22 : 0.14;
  const diffContextBg = grays[2];
  const theme: Record<ThemeToken, RGBA> = {
    primary: cyan, secondary: magenta, accent: cyan,
    error: red, warning: yellow, success: green, info: cyan,
    text: fg, textMuted: generateMutedText(bg, mode), selectedListItemText: bg,
    background: { ...bg, a: 0 },
    backgroundPanel: grays[2], backgroundElement: grays[3], backgroundMenu: grays[3],
    border: grays[7], borderActive: grays[8], borderSubtle: grays[6],
    diffAdded: green, diffRemoved: red, diffContext: grays[7], diffHunkHeader: grays[7],
    diffHighlightAdded: col(10), diffHighlightRemoved: col(9),
    diffAddedBg: tint(bg, green, diffAlpha), diffRemovedBg: tint(bg, red, diffAlpha),
    diffContextBg, diffLineNumber: generateMutedText(bg, mode),
    diffAddedLineNumberBg: tint(diffContextBg, green, diffAlpha),
    diffRemovedLineNumberBg: tint(diffContextBg, red, diffAlpha),
    markdownText: fg, markdownHeading: fg, markdownLink: blue, markdownLinkText: cyan,
    markdownCode: fg, markdownBlockQuote: generateMutedText(bg, mode), markdownEmph: fg, markdownStrong: fg,
    markdownHorizontalRule: generateMutedText(bg, mode), markdownListItem: fg,
    markdownListEnumeration: fg, markdownImage: blue, markdownImageText: cyan, markdownCodeBlock: fg,
    syntaxComment: generateMutedText(bg, mode), syntaxKeyword: magenta, syntaxFunction: blue,
    syntaxVariable: fg, syntaxString: green, syntaxNumber: yellow, syntaxType: cyan,
    syntaxOperator: cyan, syntaxPunctuation: fg,
  };
  return { ...theme, thinkingOpacity: 0.6, hasSelectedListItemText: true };
}

// ---------------------------------------------------------------------------
// Registry: built-ins < plugin themes < custom (disk) themes < system.

const pluginThemes = new Map<string, ThemeJson>();
const customThemes = new Map<string, ThemeJson>();
let systemTheme: { dark: Theme; light: Theme } | undefined;
const listeners = new Set<() => void>();

function notify() { for (const listener of listeners) listener(); }

export function subscribeThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isThemeJson(value: unknown): value is ThemeJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as ThemeJson).theme === 'object' && (value as ThemeJson).theme !== null && !Array.isArray((value as ThemeJson).theme);
}

export function setCustomThemes(themes: Record<string, ThemeJson>): void {
  customThemes.clear();
  for (const [name, theme] of Object.entries(themes)) if (isThemeJson(theme)) customThemes.set(name, theme);
  notify();
}

export function setSystemTheme(theme: { dark: Theme; light: Theme } | undefined): void {
  systemTheme = theme;
  notify();
}

export function getSystemTheme(): { dark: Theme; light: Theme } | undefined { return systemTheme; }

/** Plugin install: first writer wins; invalid shapes are refused. */
export function addTheme(name: string, theme: ThemeJson): boolean {
  if (!isThemeJson(theme) || hasTheme(name)) return false;
  pluginThemes.set(name, theme);
  notify();
  return true;
}

export function upsertTheme(name: string, theme: ThemeJson): void {
  if (!isThemeJson(theme)) return;
  (customThemes.has(name) ? customThemes : pluginThemes).set(name, theme);
  notify();
}

export function listThemes(builtins: Record<string, ThemeJson>): string[] {
  const names = new Set<string>([...Object.keys(builtins), ...pluginThemes.keys(), ...customThemes.keys()]);
  if (systemTheme) names.add('system');
  return [...names];
}

export function hasTheme(name: string, builtins?: Record<string, ThemeJson>): boolean {
  if (name === 'system') return systemTheme !== undefined;
  return Boolean(builtins?.[name]) || pluginThemes.has(name) || customThemes.has(name);
}

/** Resolve the active theme by name; `system` reads the generated pair. Custom
 * themes shadow plugin themes shadow built-ins; `system` is unshadowable. */
export function getTheme(name: string, mode: ThemeMode, builtins: Record<string, ThemeJson>): Theme | undefined {
  if (name === 'system') return systemTheme?.[mode];
  const json = customThemes.get(name) ?? pluginThemes.get(name) ?? builtins[name];
  return json ? resolveTheme(json, mode) : undefined;
}

/** Test hook: reset module-level registry state. */
export function resetThemeRegistry(): void {
  pluginThemes.clear();
  customThemes.clear();
  systemTheme = undefined;
  listeners.clear();
}
