/** Keymap engine for the terminal client. Framework-free: chords parse into
 * KeyStroke sequences, layers register handlers per command, and a router
 * dispatches live key events through the mode stack and the timed leader.
 *
 * Grammar: `+` joins modifiers to a key ("ctrl+shift+a"), `,` separates
 * alternative chords ("ctrl+g,home"), whitespace separates sequence steps, and
 * `<leader>` prefixes a leader sequence ("<leader>n"). Legacy aliases
 * (enter→return, esc→escape, pgup→pageup, pgdown→pagedown) expand before
 * parsing; display aliases (pageup→pgup, delete→del, meta→alt) apply only
 * when formatting chords for the UI. */

import type { BindingItem, BindingObject, BindingValue, KeyStroke } from './keybinds.js';
import { commandForAction, KEYBIND_DEFAULTS, LEADER_DEFAULT, LEADER_TIMEOUT_DEFAULT } from './keybinds.js';

export const LEADER_TOKEN = 'leader';

const MODIFIERS = new Set(['ctrl', 'shift', 'meta', 'super', 'hyper', 'alt']);

/** Legacy input aliases, expanded before parse. The pattern requires the alias
 * to sit at a chord boundary so "escape" is never mangled by "esc". */
const KEY_ALIASES: Record<string, string> = {
  enter: 'return', esc: 'escape', pgdown: 'pagedown', pgup: 'pageup',
};

/** Rendering-only aliases for compact shortcut hints. */
const DISPLAY_ALIASES: Record<string, string> = {
  pageup: 'pgup', pagedown: 'pgdn', delete: 'del', meta: 'alt',
};

export function expandAliases(chord: string): string {
  let out = chord;
  for (const [alias, canonical] of Object.entries(KEY_ALIASES)) {
    out = out.replace(new RegExp(`(^|[+,\\s>])${alias}(?=$|[+,\\s<])`, 'gi'), `$1${canonical}`);
  }
  return out;
}

/** One step in a chord sequence: a resolved keystroke or the leader token. */
export type ChordStep = KeyStroke | typeof LEADER_TOKEN;

export interface ParsedBinding {
  steps: ChordStep[];
  preventDefault: boolean;
  fallthrough: boolean;
  event: 'press' | 'release';
}

function parseStroke(token: string): KeyStroke {
  const parts = token.split('+');
  const name = parts[parts.length - 1].toLowerCase();
  const stroke: KeyStroke = { name };
  for (const part of parts.slice(0, -1)) {
    const mod = part.toLowerCase();
    if (mod === 'alt' || mod === 'meta') stroke.meta = true;
    else if (mod === 'ctrl') stroke.ctrl = true;
    else if (mod === 'shift') stroke.shift = true;
    else if (mod === 'super') stroke.super = true;
    else if (mod === 'hyper') stroke.hyper = true;
    else throw new Error(`Unknown modifier "${part}" in chord "${token}"`);
  }
  // Single uppercase letters imply shift ("E" === shift+e).
  if (name.length === 1 && name !== stroke.name) stroke.shift = true;
  if (parts[parts.length - 1].length === 1 && /[A-Z]/.test(parts[parts.length - 1])) {
    stroke.shift = true;
  }
  return stroke;
}

/** Parse one chord string (no commas) into sequence steps. */
export function parseChord(chord: string): ChordStep[] {
  const expanded = expandAliases(chord.trim());
  const steps: ChordStep[] = [];
  // <leader> may be glued to the next token ("<leader>n") or spaced.
  let rest = expanded;
  while (rest.length > 0) {
    if (rest.toLowerCase().startsWith('<leader>')) {
      steps.push(LEADER_TOKEN);
      rest = rest.slice('<leader>'.length).trimStart();
      continue;
    }
    const match = rest.match(/^\S+/);
    if (!match) break;
    steps.push(parseStroke(match[0]));
    rest = rest.slice(match[0].length).trimStart();
  }
  if (steps.length === 0) throw new Error(`Empty chord "${chord}"`);
  return steps;
}

function isKeyStroke(item: BindingItem): item is KeyStroke {
  return typeof item === 'object' && 'name' in item && !('key' in item);
}

function isBindingObject(item: BindingItem): item is BindingObject {
  return typeof item === 'object' && 'key' in item;
}

/** Normalize one BindingValue into parsed alternatives. `false`/"none" → []. */
export function parseBinding(value: BindingValue): ParsedBinding[] {
  if (value === false || value === 'none') return [];
  const items = Array.isArray(value) ? value : [value];
  const out: ParsedBinding[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      for (const chord of item.split(',')) {
        if (!chord.trim()) continue;
        out.push({ steps: parseChord(chord), preventDefault: true, fallthrough: false, event: 'press' });
      }
    } else if (isKeyStroke(item)) {
      out.push({ steps: [{ ...item, name: expandAliases(item.name) }], preventDefault: true, fallthrough: false, event: 'press' });
    } else if (isBindingObject(item)) {
      const steps = typeof item.key === 'string' ? parseChord(item.key) : [{ ...item.key, name: expandAliases(item.key.name) }];
      out.push({
        steps,
        preventDefault: item.preventDefault !== false,
        fallthrough: item.fallthrough === true,
        event: item.event ?? 'press',
      });
    }
  }
  return out;
}

export interface KeyEvent {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  super?: boolean;
  hyper?: boolean;
  baseCode?: string;
}

export function strokeMatches(stroke: KeyStroke, event: KeyEvent): boolean {
  const nameMatches = stroke.name === event.name.toLowerCase()
    || (event.baseCode !== undefined && stroke.name === event.baseCode.toLowerCase());
  return nameMatches
    && Boolean(stroke.ctrl) === Boolean(event.ctrl)
    && Boolean(stroke.shift) === Boolean(event.shift)
    && Boolean(stroke.meta) === Boolean(event.meta)
    && Boolean(stroke.super) === Boolean(event.super)
    && Boolean(stroke.hyper) === Boolean(event.hyper);
}

// ---------------------------------------------------------------------------
// Formatting for shortcut hints and the which-key panel.

export function formatStroke(stroke: KeyStroke): string {
  const parts: string[] = [];
  if (stroke.ctrl) parts.push('ctrl');
  if (stroke.meta) parts.push(DISPLAY_ALIASES.meta);
  if (stroke.super) parts.push('super');
  if (stroke.hyper) parts.push('hyper');
  if (stroke.shift) parts.push('shift');
  parts.push(DISPLAY_ALIASES[stroke.name] ?? stroke.name);
  return parts.join('+');
}

/** Render a parsed chord; the leader token displays as its configured chord. */
export function formatChord(steps: ChordStep[], leaderChord: string = LEADER_DEFAULT): string {
  return steps.map(step => step === LEADER_TOKEN ? formatStroke(parseChord(leaderChord)[0] as KeyStroke) : formatStroke(step)).join(' ');
}

// ---------------------------------------------------------------------------
// Router: layers + mode stack + timed leader.

export interface LayerBinding {
  binding: ParsedBinding;
  command: string;
  action: string;
}

export interface Layer {
  name: string;
  /** Layers without a mode stay active across mode changes. */
  mode?: string;
  bindings: LayerBinding[];
  /** Extra gate evaluated at dispatch time (e.g. managed-textarea focus). */
  enabled?: () => boolean;
}

export const BASE_MODE = 'base';

interface ModeEntry { mode: string; token: symbol }

export interface DispatchResult {
  command?: string;
  action?: string;
  handled: boolean;
  /** True while a multi-step sequence (leader) is pending. */
  pending: boolean;
  preventDefault: boolean;
}

export class KeymapRouter {
  private layers: Layer[] = [];
  private modeStack: ModeEntry[] = [];
  private pendingSteps: KeyEvent[] = [];
  private leaderTimer: ReturnType<typeof setTimeout> | undefined;
  private leaderSteps: ChordStep[] = [];
  private readonly leaderBinding: ParsedBinding[];
  readonly leaderTimeoutMs: number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly leaderChord: string = LEADER_DEFAULT,
    leaderTimeoutMs: number = LEADER_TIMEOUT_DEFAULT,
  ) {
    this.leaderTimeoutMs = leaderTimeoutMs;
    this.leaderBinding = leaderChord === 'none' ? [] : parseBinding(leaderChord);
  }

  get mode(): string {
    return this.modeStack.length > 0 ? this.modeStack[this.modeStack.length - 1].mode : BASE_MODE;
  }

  get pending(): ChordStep[] { return [...this.leaderSteps]; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() { for (const listener of this.listeners) listener(); }

  /** Push a mode; the returned token pops it (symbol identity makes
   * out-of-order pops safe). */
  pushMode(mode: string): symbol {
    const token = Symbol(mode);
    this.modeStack.push({ mode, token });
    this.notify();
    return token;
  }

  popMode(token: symbol): void {
    const index = this.modeStack.findIndex(entry => entry.token === token);
    if (index >= 0) this.modeStack.splice(index, 1);
    this.notify();
  }

  addLayer(layer: Layer): () => void {
    this.layers.push(layer);
    this.notify();
    return () => {
      const index = this.layers.indexOf(layer);
      if (index >= 0) this.layers.splice(index, 1);
      this.notify();
    };
  }

  private activeLayers(): Layer[] {
    const mode = this.mode;
    // Later-registered layers win, so scan in reverse.
    return [...this.layers].reverse().filter(layer =>
      (layer.mode === undefined || layer.mode === mode) && (layer.enabled?.() ?? true));
  }

  private clearLeader(): void {
    if (this.leaderTimer) clearTimeout(this.leaderTimer);
    this.leaderTimer = undefined;
    this.leaderSteps = [];
    this.pendingSteps = [];
    this.notify();
  }

  /** Feed one key event; returns what matched. */
  dispatch(event: KeyEvent): DispatchResult {
    const none: DispatchResult = { handled: false, pending: false, preventDefault: false };

    if (this.leaderSteps.length > 0) {
      // Escape cancels a pending sequence; backspace steps back one token.
      if (event.name === 'escape' && !event.ctrl && !event.meta && !event.shift) {
        this.clearLeader();
        return { handled: true, pending: false, preventDefault: true };
      }
      if (event.name === 'backspace' && !event.ctrl && !event.meta && !event.shift) {
        this.leaderSteps.pop();
        this.pendingSteps.pop();
        if (this.leaderSteps.length === 0) this.clearLeader();
        else this.armLeaderTimer();
        this.notify();
        return { handled: true, pending: this.leaderSteps.length > 0, preventDefault: true };
      }
      const sequence = [...this.leaderSteps, this.eventToStep(event)];
      const match = this.findSequenceMatch(sequence);
      if (match === 'exact') {
        const result = this.resolveSequence(sequence);
        this.clearLeader();
        return result ?? { handled: true, pending: false, preventDefault: true };
      }
      if (match === 'prefix') {
        this.leaderSteps = sequence;
        this.pendingSteps.push(event);
        this.armLeaderTimer();
        this.notify();
        return { handled: true, pending: true, preventDefault: true };
      }
      this.clearLeader();
      return { handled: true, pending: false, preventDefault: true };
    }

    // Leader press starts a sequence.
    if (this.leaderBinding.some(binding => binding.steps.length === 1 && binding.steps[0] !== LEADER_TOKEN && strokeMatches(binding.steps[0], event))) {
      this.leaderSteps = [LEADER_TOKEN];
      this.pendingSteps = [event];
      this.armLeaderTimer();
      this.notify();
      return { handled: true, pending: true, preventDefault: true };
    }

    // Single-step bindings across active layers.
    for (const layer of this.activeLayers()) {
      for (const entry of layer.bindings) {
        const { steps } = entry.binding;
        if (steps.length !== 1 || steps[0] === LEADER_TOKEN) continue;
        if (strokeMatches(steps[0], event)) {
          return {
            command: entry.command, action: entry.action, handled: true,
            pending: false, preventDefault: entry.binding.preventDefault,
          };
        }
      }
    }
    return none;
  }

  private eventToStep(event: KeyEvent): KeyStroke {
    const stroke: KeyStroke = { name: event.name.toLowerCase() };
    if (event.ctrl) stroke.ctrl = true;
    if (event.shift) stroke.shift = true;
    if (event.meta) stroke.meta = true;
    if (event.super) stroke.super = true;
    if (event.hyper) stroke.hyper = true;
    return stroke;
  }

  private stepsMatch(bindingSteps: ChordStep[], sequence: ChordStep[]): 'exact' | 'prefix' | 'none' {
    if (sequence.length > bindingSteps.length) return 'none';
    for (let i = 0; i < sequence.length; i++) {
      const want = bindingSteps[i];
      const have = sequence[i];
      if (want === LEADER_TOKEN || have === LEADER_TOKEN) {
        if (want !== have) return 'none';
        continue;
      }
      if (!strokeMatches(want, { ...have })) return 'none';
    }
    return sequence.length === bindingSteps.length ? 'exact' : 'prefix';
  }

  private findSequenceMatch(sequence: ChordStep[]): 'exact' | 'prefix' | 'none' {
    let sawPrefix = false;
    for (const layer of this.activeLayers()) {
      for (const entry of layer.bindings) {
        const result = this.stepsMatch(entry.binding.steps, sequence);
        if (result === 'exact') return 'exact';
        if (result === 'prefix') sawPrefix = true;
      }
    }
    return sawPrefix ? 'prefix' : 'none';
  }

  private resolveSequence(sequence: ChordStep[]): DispatchResult | undefined {
    for (const layer of this.activeLayers()) {
      for (const entry of layer.bindings) {
        if (this.stepsMatch(entry.binding.steps, sequence) === 'exact') {
          return {
            command: entry.command, action: entry.action, handled: true,
            pending: false, preventDefault: entry.binding.preventDefault,
          };
        }
      }
    }
    return undefined;
  }

  private armLeaderTimer(): void {
    if (this.leaderTimer) clearTimeout(this.leaderTimer);
    this.leaderTimer = setTimeout(() => this.clearLeader(), this.leaderTimeoutMs);
  }

  dispose(): void {
    if (this.leaderTimer) clearTimeout(this.leaderTimer);
    this.layers = [];
    this.modeStack = [];
    this.listeners.clear();
  }
}

/** Build layer bindings from a keybind table (defaults merged with overrides
 * per action; an override fully replaces that action's chord list). */
export function buildBindings(overrides: Record<string, BindingValue> = {}, actions?: string[]): LayerBinding[] {
  const out: LayerBinding[] = [];
  const names = actions ?? Object.keys(KEYBIND_DEFAULTS);
  for (const action of names) {
    if (action === LEADER_TOKEN) continue;
    const value = overrides[action] ?? KEYBIND_DEFAULTS[action];
    if (value === undefined) continue;
    for (const binding of parseBinding(value)) {
      out.push({ binding, command: commandForAction(action), action });
    }
  }
  return out;
}

/** The effective leader chord: the override when set, "none" to disable. */
export function resolveLeader(overrides: Record<string, BindingValue> = {}): string {
  const value = overrides[LEADER_TOKEN] ?? KEYBIND_DEFAULTS[LEADER_TOKEN];
  if (value === false || value === 'none') return 'none';
  if (typeof value === 'string') return value.split(',')[0].trim();
  return LEADER_DEFAULT;
}
