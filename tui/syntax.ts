/** Tree-sitter scope → style rules derived from the active theme. Pure data:
 * colors are emitted as hex strings so the module never touches the renderer's
 * native layer and every rule is unit-testable under plain Node. The renderer
 * side feeds these into SyntaxStyle.fromTheme. The subtle variant re-emits
 * every rule with the foreground alpha multiplied down to thinkingOpacity —
 * it styles collapsed-reasoning bodies so thoughts read quieter than answers. */
import { toHex, type RGBA, type Theme } from './theme.js';

export interface TokenRule {
  scope: string[];
  style: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean };
}

const fgOf = (color: RGBA) => toHex(color);

export function syntaxRules(theme: Theme): TokenRule[] {
  const rule = (scope: string[], foreground: RGBA, extra: Partial<TokenRule['style']> = {}): TokenRule =>
    ({ scope, style: { foreground: fgOf(foreground), ...extra } });
  return [
    rule(['default'], theme.text),
    rule(['prompt'], theme.accent),
    rule(['extmark.file'], theme.warning, { bold: true }),
    rule(['extmark.agent'], theme.secondary, { bold: true }),
    rule(['comment', 'comment.documentation'], theme.syntaxComment, { italic: true }),
    rule(['string', 'symbol'], theme.syntaxString),
    rule(['number', 'boolean'], theme.syntaxNumber),
    rule(['character.special'], theme.syntaxString),
    rule(['character'], theme.syntaxString),
    rule(['float'], theme.syntaxNumber),
    rule(['keyword.return', 'keyword.conditional', 'keyword.repeat', 'keyword.coroutine'], theme.syntaxKeyword, { italic: true }),
    rule(['keyword.type'], theme.syntaxType, { bold: true, italic: true }),
    rule(['keyword.function', 'function.method'], theme.syntaxFunction),
    rule(['keyword'], theme.syntaxKeyword, { italic: true }),
    rule(['keyword.import'], theme.syntaxKeyword),
    rule(['keyword.export'], theme.syntaxKeyword),
    rule(['keyword.directive', 'keyword.modifier', 'keyword.exception'], theme.syntaxKeyword, { italic: true }),
    rule(['operator', 'keyword.operator', 'punctuation.delimiter'], theme.syntaxOperator),
    rule(['keyword.conditional.ternary'], theme.syntaxOperator),
    rule(['punctuation.special'], theme.syntaxOperator),
    rule(['variable', 'variable.parameter', 'function.method.call', 'function.call'], theme.syntaxVariable),
    rule(['variable.member', 'function', 'constructor'], theme.syntaxFunction),
    rule(['type', 'module'], theme.syntaxType),
    rule(['constant'], theme.syntaxNumber),
    rule(['property'], theme.syntaxVariable),
    rule(['class'], theme.syntaxType),
    rule(['parameter'], theme.syntaxVariable),
    rule(['punctuation', 'punctuation.bracket'], theme.syntaxPunctuation),
    rule(['variable.builtin', 'type.builtin', 'function.builtin', 'module.builtin', 'constant.builtin'], theme.error),
    rule(['variable.super'], theme.error),
    rule(['string.escape', 'string.regexp'], theme.syntaxKeyword),
    rule(['markup.heading', 'markup.heading.1'], theme.markdownHeading, { bold: true, underline: true }),
    rule(['markup.heading.2', 'markup.heading.3', 'markup.heading.4', 'markup.heading.5', 'markup.heading.6'], theme.markdownHeading, { bold: true }),
    rule(['markup.bold', 'markup.strong'], theme.markdownStrong, { bold: true }),
    rule(['markup.italic'], theme.markdownEmph, { italic: true }),
    rule(['markup.list'], theme.markdownListItem),
    rule(['markup.quote'], theme.markdownBlockQuote, { italic: true }),
    rule(['markup.raw', 'markup.raw.block'], theme.markdownCode),
    rule(['markup.raw.inline'], theme.markdownCode, { background: fgOf(theme.background) }),
    rule(['markup.link'], theme.markdownLink, { underline: true }),
    rule(['markup.link.label'], theme.markdownLinkText, { underline: true }),
    rule(['markup.link.url'], theme.markdownLink, { underline: true }),
    rule(['label'], theme.markdownLinkText),
    rule(['spell', 'nospell'], theme.text),
    rule(['conceal'], theme.textMuted),
    rule(['string.special', 'string.special.url'], theme.markdownLink, { underline: true }),
    rule(['comment.error'], theme.error, { italic: true, bold: true }),
    rule(['comment.warning'], theme.warning, { italic: true, bold: true }),
    rule(['comment.todo', 'comment.note'], theme.info, { italic: true, bold: true }),
    rule(['namespace'], theme.syntaxType),
    rule(['field'], theme.syntaxVariable),
    rule(['type.definition'], theme.syntaxType, { bold: true }),
    rule(['attribute', 'annotation'], theme.warning),
    rule(['tag'], theme.error),
    rule(['tag.attribute'], theme.syntaxKeyword),
    rule(['tag.delimiter'], theme.syntaxOperator),
    rule(['markup.strikethrough'], theme.textMuted),
    rule(['markup.underline'], theme.text, { underline: true }),
    rule(['markup.list.checked'], theme.success),
    rule(['markup.list.unchecked'], theme.textMuted),
    { scope: ['diff.plus'], style: { foreground: fgOf(theme.diffAdded), background: fgOf(theme.diffAddedBg) } },
    { scope: ['diff.minus'], style: { foreground: fgOf(theme.diffRemoved), background: fgOf(theme.diffRemovedBg) } },
    { scope: ['diff.delta'], style: { foreground: fgOf(theme.diffContext), background: fgOf(theme.diffContextBg) } },
    rule(['error'], theme.error, { bold: true }),
    rule(['warning'], theme.warning, { bold: true }),
    rule(['info'], theme.info),
    rule(['debug'], theme.textMuted),
  ];
}

/** Same rules, every foreground faded to the theme's thinking opacity. */
export function subtleSyntaxRules(theme: Theme): TokenRule[] {
  const alpha = Math.max(0, Math.min(255, Math.round(theme.thinkingOpacity * 255)));
  return syntaxRules(theme).map(rule => {
    if (!rule.style.foreground) return rule;
    const hex = rule.style.foreground.slice(1);
    const rgb = hex.slice(0, 6);
    return { ...rule, style: { ...rule.style, foreground: `#${rgb}${alpha.toString(16).padStart(2, '0')}` } };
  });
}
