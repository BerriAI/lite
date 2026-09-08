// Explicit permission rules decide allow/ask/deny for tool calls before the
// session's generic permission mode. They never widen tool availability: Plan
// mode, profile allowlists, and the researcher ceiling remain independent
// outer bounds. Deny always wins and is final for the turn.
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** One explicit rule. `tool` is an exact built-in tool name (never a pattern).
 * `patterns` apply to that tool's sensitive argument — the command for bash,
 * the workspace-relative path for file mutations — and are ignored for tools
 * with no pattern subject. A rule with no patterns matches every call of the
 * tool. Matching is documented convenience, not a sandbox. */
export interface PermissionRule {
  tool: string;
  decision: PermissionDecision;
  /** Case-sensitive glob-style patterns: `*` matches within one path/word
   * segment, `**` matches across segments. For bash the subject is the whole
   * command text; a pattern without wildcards matches as a word-boundary
   * command prefix (e.g. "git status" matches "git status --short" but not
   * "git statusx"). */
  patterns?: string[];
}

export interface PermissionRuleSet {
  version: 1;
  rules: PermissionRule[];
}

/** Where a decisive rule came from, for honest UI/result reporting. */
export interface RuleMatch {
  decision: PermissionDecision;
  source: 'project' | 'app';
  tool: string;
  pattern?: string;
}

export const PERMISSION_LIMITS = {
  rules: 200,
  patternLength: 400,
  patternsPerRule: 20,
} as const;
