import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_MODE, buildBindings, expandAliases, formatChord, formatStroke,
  KeymapRouter, LEADER_TOKEN, parseBinding, parseChord, resolveLeader,
  strokeMatches,
  type KeyEvent, type Layer,
} from '../tui/keymap.js';
import { KEYBIND_DEFAULTS, LEADER_DEFAULT } from '../tui/keybinds.js';

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ...mods };
}

function layerFor(action: string, chord: string, extra: Partial<Layer> = {}): Layer {
  return {
    name: `test:${action}`,
    bindings: buildBindings({ [action]: chord }, [action]),
    ...extra,
  };
}

describe('expandAliases', () => {
  it('expands legacy aliases at chord boundaries only', () => {
    expect(expandAliases('enter')).toBe('return');
    expect(expandAliases('ctrl+enter,esc')).toBe('ctrl+return,escape');
    expect(expandAliases('<leader>pgup pgdown')).toBe('<leader>pageup pagedown');
    // "escape" must never be mangled by the "esc" alias.
    expect(expandAliases('escape')).toBe('escape');
    expect(expandAliases('shift+escape')).toBe('shift+escape');
  });
});

describe('parseChord', () => {
  it('parses modifiers, sequences, and glued/spaced leader', () => {
    expect(parseChord('ctrl+shift+a')).toEqual([{ name: 'a', ctrl: true, shift: true }]);
    expect(parseChord('<leader>n')).toEqual([LEADER_TOKEN, { name: 'n' }]);
    expect(parseChord('<leader> n')).toEqual([LEADER_TOKEN, { name: 'n' }]);
    expect(parseChord('ctrl+g home')).toEqual([{ name: 'g', ctrl: true }, { name: 'home' }]);
  });

  it('maps alt to meta and uppercase letters imply shift', () => {
    expect(parseChord('alt+f')).toEqual([{ name: 'f', meta: true }]);
    expect(parseChord('E')).toEqual([{ name: 'e', shift: true }]);
    expect(parseChord('shift+i')).toEqual([{ name: 'i', shift: true }]);
  });

  it('throws on empty chords and unknown modifiers', () => {
    expect(() => parseChord('   ')).toThrow(/Empty chord/);
    expect(() => parseChord('bogus+x')).toThrow(/Unknown modifier "bogus"/);
  });
});

describe('parseBinding', () => {
  it('returns [] for false and "none"', () => {
    expect(parseBinding(false)).toEqual([]);
    expect(parseBinding('none')).toEqual([]);
  });

  it('splits comma alternatives from a string', () => {
    const out = parseBinding('ctrl+c,ctrl+d,<leader>q');
    expect(out).toHaveLength(3);
    expect(out[0].steps).toEqual([{ name: 'c', ctrl: true }]);
    expect(out[2].steps).toEqual([LEADER_TOKEN, { name: 'q' }]);
    expect(out.every(b => b.preventDefault && !b.fallthrough && b.event === 'press')).toBe(true);
  });

  it('accepts KeyStroke, object form, and arrays', () => {
    expect(parseBinding({ name: 'f5' })[0].steps).toEqual([{ name: 'f5' }]);
    const object = parseBinding({ key: 'ctrl+v', preventDefault: false })[0];
    expect(object.steps).toEqual([{ name: 'v', ctrl: true }]);
    expect(object.preventDefault).toBe(false);
    const release = parseBinding({ key: 'space', event: 'release', fallthrough: true })[0];
    expect(release.event).toBe('release');
    expect(release.fallthrough).toBe(true);
    expect(parseBinding(['a', 'b'])).toHaveLength(2);
  });
});

describe('strokeMatches', () => {
  it('requires exact modifier state', () => {
    expect(strokeMatches({ name: 'a', ctrl: true }, key('a', { ctrl: true }))).toBe(true);
    expect(strokeMatches({ name: 'a', ctrl: true }, key('a', { ctrl: true, shift: true }))).toBe(false);
    expect(strokeMatches({ name: 'a' }, key('A'))).toBe(true);
  });

  it('falls back to baseCode for non-US layouts', () => {
    expect(strokeMatches({ name: 'z', ctrl: true }, key('y', { ctrl: true, baseCode: 'z' }))).toBe(true);
    expect(strokeMatches({ name: 'z' }, key('y'))).toBe(false);
  });
});

describe('formatting', () => {
  it('applies display aliases', () => {
    expect(formatStroke({ name: 'pageup' })).toBe('pgup');
    expect(formatStroke({ name: 'pagedown', ctrl: true })).toBe('ctrl+pgdn');
    expect(formatStroke({ name: 'delete', meta: true })).toBe('alt+del');
  });

  it('renders the leader token as the configured chord', () => {
    expect(formatChord(parseChord('<leader>n'))).toBe('ctrl+x n');
    expect(formatChord(parseChord('<leader>n'), 'ctrl+space')).toBe('ctrl+space n');
  });
});

describe('KeymapRouter', () => {
  let router: KeymapRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    router = new KeymapRouter();
  });

  afterEach(() => {
    router.dispose();
    vi.useRealTimers();
  });

  it('dispatches single-step bindings on active layers', () => {
    router.addLayer(layerFor('session_new', 'ctrl+n'));
    const hit = router.dispatch(key('n', { ctrl: true }));
    expect(hit).toMatchObject({ handled: true, command: 'session.new', action: 'session_new', preventDefault: true });
    expect(router.dispatch(key('n')).handled).toBe(false);
  });

  it('honors preventDefault:false from the object form', () => {
    router.addLayer({ name: 'paste', bindings: buildBindings({}, ['input_paste']) });
    const hit = router.dispatch(key('v', { ctrl: true }));
    expect(hit.handled).toBe(true);
    expect(hit.preventDefault).toBe(false);
  });

  it('completes a leader sequence within the timeout', () => {
    router.addLayer(layerFor('session_new', '<leader>n'));
    const pending = router.dispatch(key('x', { ctrl: true }));
    expect(pending).toMatchObject({ handled: true, pending: true });
    expect(router.pending).toEqual([LEADER_TOKEN]);
    const hit = router.dispatch(key('n'));
    expect(hit).toMatchObject({ handled: true, pending: false, command: 'session.new' });
    expect(router.pending).toEqual([]);
  });

  it('expires a pending sequence after the leader timeout', () => {
    router.addLayer(layerFor('session_new', '<leader>n'));
    router.dispatch(key('x', { ctrl: true }));
    vi.advanceTimersByTime(2001);
    expect(router.pending).toEqual([]);
    // After expiry the follow-up key is no longer part of a sequence.
    expect(router.dispatch(key('n')).handled).toBe(false);
  });

  it('escape cancels and backspace pops one token', () => {
    router.addLayer(layerFor('session_new', '<leader>n'));
    router.dispatch(key('x', { ctrl: true }));
    expect(router.dispatch(key('escape'))).toMatchObject({ handled: true, pending: false });
    expect(router.pending).toEqual([]);

    router.dispatch(key('x', { ctrl: true }));
    expect(router.dispatch(key('backspace'))).toMatchObject({ handled: true, pending: false });
    expect(router.pending).toEqual([]);
    // A fully popped sequence releases keys back to normal dispatch.
    expect(router.dispatch(key('n')).handled).toBe(false);
  });

  it('swallows a non-matching key after the leader', () => {
    router.addLayer(layerFor('session_new', '<leader>n'));
    router.dispatch(key('x', { ctrl: true }));
    const miss = router.dispatch(key('z'));
    expect(miss).toMatchObject({ handled: true, pending: false });
    expect(miss.command).toBeUndefined();
    expect(router.pending).toEqual([]);
  });

  it('matches multi-alternative defaults like app_exit', () => {
    router.addLayer({ name: 'app', bindings: buildBindings({}, ['app_exit']) });
    expect(router.dispatch(key('c', { ctrl: true })).command).toBe('app.exit');
    expect(router.dispatch(key('d', { ctrl: true })).command).toBe('app.exit');
    router.dispatch(key('x', { ctrl: true }));
    expect(router.dispatch(key('q')).command).toBe('app.exit');
  });

  it('respects the mode stack: modal layers gate, modeless layers stay active', () => {
    router.addLayer(layerFor('session_new', 'ctrl+n', { mode: BASE_MODE }));
    router.addLayer(layerFor('app_exit', 'ctrl+c'));
    router.addLayer(layerFor('diff_close', 'q', { mode: 'diff' }));

    expect(router.dispatch(key('n', { ctrl: true })).handled).toBe(true);
    expect(router.dispatch(key('q')).handled).toBe(false);

    const token = router.pushMode('diff');
    expect(router.mode).toBe('diff');
    expect(router.dispatch(key('q')).command).toBe('diff.close');
    // Base-mode layer deactivates under the pushed mode; modeless survives.
    expect(router.dispatch(key('n', { ctrl: true })).handled).toBe(false);
    expect(router.dispatch(key('c', { ctrl: true })).command).toBe('app.exit');

    router.popMode(token);
    expect(router.mode).toBe(BASE_MODE);
    expect(router.dispatch(key('n', { ctrl: true })).handled).toBe(true);
  });

  it('pops modes by symbol identity, out of order, safely', () => {
    const a = router.pushMode('dialog');
    const b = router.pushMode('permission');
    router.popMode(a);
    expect(router.mode).toBe('permission');
    router.popMode(a); // double pop is a no-op
    router.popMode(b);
    expect(router.mode).toBe(BASE_MODE);
  });

  it('later-registered layers win and disposers unregister', () => {
    router.addLayer(layerFor('session_new', 'ctrl+n'));
    const dispose = router.addLayer(layerFor('session_rename', 'ctrl+n'));
    expect(router.dispatch(key('n', { ctrl: true })).command).toBe('session.rename');
    dispose();
    expect(router.dispatch(key('n', { ctrl: true })).command).toBe('session.new');
  });

  it('gates layers through enabled()', () => {
    let focused = false;
    router.addLayer(layerFor('input_submit', 'return', { enabled: () => focused }));
    expect(router.dispatch(key('return')).handled).toBe(false);
    focused = true;
    expect(router.dispatch(key('return')).command).toBe('input.submit');
  });

  it('notifies subscribers on pending/mode changes', () => {
    const seen: string[] = [];
    router.subscribe(() => seen.push(router.mode));
    const token = router.pushMode('diff');
    router.popMode(token);
    expect(seen).toEqual(['diff', 'base']);
  });

  it('supports a custom leader chord and "none" disables sequences', () => {
    const custom = new KeymapRouter('ctrl+space');
    custom.addLayer(layerFor('session_new', '<leader>n'));
    expect(custom.dispatch(key('space', { ctrl: true })).pending).toBe(true);
    expect(custom.dispatch(key('n')).command).toBe('session.new');
    custom.dispose();

    const disabled = new KeymapRouter('none');
    disabled.addLayer(layerFor('session_new', '<leader>n'));
    expect(disabled.dispatch(key('x', { ctrl: true })).handled).toBe(false);
    disabled.dispose();
  });
});

describe('buildBindings / resolveLeader', () => {
  it('an override fully replaces the default chord list', () => {
    const bindings = buildBindings({ app_exit: 'ctrl+q' }, ['app_exit']);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].binding.steps).toEqual([{ name: 'q', ctrl: true }]);
  });

  it('false/none overrides remove all bindings for the action', () => {
    expect(buildBindings({ app_exit: false }, ['app_exit'])).toEqual([]);
    expect(buildBindings({ app_exit: 'none' }, ['app_exit'])).toEqual([]);
  });

  it('skips the leader pseudo-action and maps dotted actions to themselves', () => {
    const all = buildBindings();
    expect(all.some(b => b.action === 'leader')).toBe(false);
    const dotted = buildBindings({}, ['dialog.select.prev']);
    expect(dotted[0].command).toBe('dialog.select.prev');
  });

  it('covers every bindable default without throwing', () => {
    const all = buildBindings();
    const bound = new Set(all.map(b => b.action));
    // Every non-"none" action appears; "none" actions are bindable but unbound.
    for (const [action, value] of Object.entries(KEYBIND_DEFAULTS)) {
      if (action === 'leader' || value === 'none' || value === false) continue;
      expect(bound.has(action), action).toBe(true);
    }
  });

  it('resolves the leader from overrides, first alternative only', () => {
    expect(resolveLeader()).toBe(LEADER_DEFAULT);
    expect(resolveLeader({ leader: 'ctrl+space' })).toBe('ctrl+space');
    expect(resolveLeader({ leader: 'ctrl+space,ctrl+b' })).toBe('ctrl+space');
    expect(resolveLeader({ leader: false })).toBe('none');
    expect(resolveLeader({ leader: 'none' })).toBe('none');
  });
});
