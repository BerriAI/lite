import { z } from 'zod';
import type { PermissionDecision, PermissionRule, PermissionRuleSet, RuleMatch } from '../shared/permissions.js';
import { PERMISSION_LIMITS } from '../shared/permissions.js';

// Tools a rule may target. Exact names only — a rule can never invent a tool,
// auto-approve a connected (mcp_*) tool, or bypass the researcher/task checks.
export const RULE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'web_fetch', 'todo_read', 'todo_write', 'task', 'memory_remember', 'memory_forget', 'memory_recall'] as const;
const pattern = z.string().min(1).max(PERMISSION_LIMITS.patternLength).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value), 'Patterns must be single-line printable text.');
const ruleSchema = z.object({
  tool: z.enum(RULE_TOOLS),
  decision: z.enum(['allow', 'ask', 'deny']),
  patterns: z.array(pattern).min(1).max(PERMISSION_LIMITS.patternsPerRule).optional(),
}).strict();
export const ruleSetSchema = z.object({ version: z.literal(1), rules: z.array(ruleSchema).max(PERMISSION_LIMITS.rules) }).strict();

export function validateRuleSet(value: unknown): PermissionRuleSet {
  const parsed = ruleSetSchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(`Invalid permission rules: ${parsed.error.issues[0]?.message ?? 'unknown error'} at ${parsed.error.issues[0]?.path.join('.') || 'root'}.`), { status: 400 });
  return parsed.data;
}

/** The argument a rule pattern is matched against. File tools match their
 * workspace-relative lexical path argument; bash matches the command text.
 * Tools without a subject (todo tools, task) only match pattern-free rules. */
export function ruleSubject(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'bash') return typeof args.command === 'string' ? args.command : undefined;
  if (['read_file', 'write_file', 'edit_file'].includes(tool)) return typeof args.path === 'string' ? args.path : undefined;
  if (tool === 'glob' || tool === 'grep') return typeof args.path === 'string' ? args.path : typeof args.pattern === 'string' ? String(args.pattern) : '';
  if (tool === 'web_fetch') return typeof args.url === 'string' ? args.url : undefined;
  return undefined;
}

// Glob-style matching compiled to an anchored regular expression. `**` always
// matches anything. A single `*` stays within one unit: for paths/URLs it will
// not cross `/` or whitespace; for bash commands it spans words and flags but
// never shell control operators, so `npm run *` covers `npm run lint -- --fix`
// without also covering `npm run lint && curl evil`.
function compile(glob: string, single: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` spans zero or more leading directories (gitignore-style), so a
        // deny like `**/*.secret` also covers a workspace-root `deploy.secret`.
        if (glob[index + 2] === '/') { source += '(?:[\\s\\S]*/)?'; index += 2; }
        else { source += '[\\s\\S]*'; index++; }
      } else source += single;
    } else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
const compiled = new Map<string, RegExp>();
function matchesGlob(subject: string, glob: string, tool: string): boolean {
  const single = tool === 'bash' ? '[^;&|<>`$(){}\\n]*' : '[^/\\s]*';
  const key = `${single}\0${glob}`;
  let expression = compiled.get(key);
  if (!expression) { expression = compile(glob, single); if (compiled.size > 2000) compiled.clear(); compiled.set(key, expression); }
  return expression.test(subject);
}

/** A wildcard-free bash pattern matches as a word-boundary command prefix:
 * "git status" matches "git status" and "git status --short", not "git statusx".
 * Any other tool's wildcard-free pattern must equal the subject exactly. */
export function matchesPattern(tool: string, subject: string, glob: string): boolean {
  if (!glob.includes('*')) {
    if (tool !== 'bash') return subject === glob;
    return subject === glob || (subject.startsWith(glob) && /[\s;&|<>(]/.test(subject[glob.length]));
  }
  return matchesGlob(subject, glob, tool);
}

const severity: Record<PermissionDecision, number> = { deny: 2, ask: 1, allow: 0 };

/** Decide one tool call. Deny anywhere wins; a project rule outranks an app
 * rule at equal severity; the most severe decision wins within one source. A
 * bash command containing shell control operators never auto-allows through a
 * pattern rule unless the full command text matches — command matching is a
 * documented convenience, not a parser or a sandbox. No decisive rule returns
 * undefined and the caller falls back to the ordinary permission mode. */
export function decide(sources: { source: RuleMatch['source']; rules: readonly PermissionRule[] }[], tool: string, args: Record<string, unknown>): RuleMatch | undefined {
  const subject = ruleSubject(tool, args);
  let best: RuleMatch | undefined;
  for (const { source, rules } of sources) {
    for (const rule of rules) {
      if (rule.tool !== tool) continue;
      let match: RuleMatch | undefined;
      if (!rule.patterns) match = { decision: rule.decision, source, tool };
      else if (subject !== undefined) {
        const hit = rule.patterns.find(value => matchesPattern(tool, subject, value));
        if (hit !== undefined) match = { decision: rule.decision, source, tool, pattern: hit };
      }
      if (!match) continue;
      if (match.decision === 'allow' && tool === 'bash' && match.pattern !== undefined && subject !== undefined && subjectHasControlOperators(subject) && !exactAllow(rule, subject)) match = { ...match, decision: 'ask' };
      if (!best || severity[match.decision] > severity[best.decision] || (severity[match.decision] === severity[best.decision] && best.source === 'app' && source === 'project')) best = match;
    }
  }
  return best;
}
const subjectHasControlOperators = (command: string) => /[;&|`$(){}<>\n]|\$\(/.test(command);
const exactAllow = (rule: PermissionRule, subject: string) => (rule.patterns ?? []).some(value => !value.includes('*') && value === subject);
