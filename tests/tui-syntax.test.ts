import { describe, expect, it } from 'vitest';
import { getTheme } from '../tui/theme.js';
import { BUILTIN_THEMES } from '../tui/themes.js';
import { subtleSyntaxRules, syntaxRules } from '../tui/syntax.js';

const theme = getTheme('lite', 'dark', BUILTIN_THEMES);
if (!theme) throw new Error('lite theme missing');

describe('syntaxRules', () => {
  const rules = syntaxRules(theme);
  const byScope = (scope: string) => rules.find(rule => rule.scope.includes(scope));

  it('covers the core scope groups', () => {
    for (const scope of [
      'default', 'prompt', 'comment', 'string', 'number', 'keyword', 'type',
      'function', 'variable', 'operator', 'punctuation', 'variable.builtin',
      'markup.heading', 'markup.bold', 'markup.italic', 'markup.raw.inline',
      'markup.link', 'diff.plus', 'diff.minus', 'diff.delta', 'error', 'warning',
    ]) {
      expect(byScope(scope), `missing scope ${scope}`).toBeTruthy();
    }
  });

  it('emits colors as hex strings usable as renderer ColorInput', () => {
    for (const rule of rules) {
      if (rule.style.foreground) expect(rule.style.foreground).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
      if (rule.style.background) expect(rule.style.background).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    }
  });

  it('styles structural scopes with the expected weight', () => {
    expect(byScope('comment')?.style.italic).toBe(true);
    expect(byScope('markup.heading')?.style.bold).toBe(true);
    expect(byScope('markup.heading')?.style.underline).toBe(true);
    expect(byScope('markup.heading.2')?.style.underline).toBeUndefined();
    expect(byScope('markup.link')?.style.underline).toBe(true);
    expect(byScope('extmark.file')?.style.bold).toBe(true);
    expect(byScope('error')?.style.bold).toBe(true);
  });

  it('gives diff scopes both foreground and background', () => {
    for (const scope of ['diff.plus', 'diff.minus', 'diff.delta']) {
      const rule = byScope(scope);
      expect(rule?.style.foreground).toBeTruthy();
      expect(rule?.style.background).toBeTruthy();
    }
  });

  it('routes builtins to the error color', () => {
    const builtin = byScope('variable.builtin');
    const error = byScope('error');
    expect(builtin?.style.foreground).toBe(error?.style.foreground);
  });
});

describe('subtleSyntaxRules', () => {
  it('appends the thinking-opacity alpha to every foreground', () => {
    const alpha = Math.round(theme.thinkingOpacity * 255).toString(16).padStart(2, '0');
    const subtle = subtleSyntaxRules(theme);
    for (const rule of subtle) {
      if (!rule.style.foreground) continue;
      expect(rule.style.foreground).toMatch(new RegExp(`^#[0-9a-f]{6}${alpha}$`));
    }
  });

  it('preserves scope lists and non-color attributes', () => {
    const base = syntaxRules(theme);
    const subtle = subtleSyntaxRules(theme);
    expect(subtle.length).toBe(base.length);
    for (let i = 0; i < base.length; i++) {
      expect(subtle[i].scope).toEqual(base[i].scope);
      expect(subtle[i].style.bold).toBe(base[i].style.bold);
      expect(subtle[i].style.italic).toBe(base[i].style.italic);
    }
  });
});
