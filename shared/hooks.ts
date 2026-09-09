// Lifecycle hooks (design note 4.3): user-configured shell commands around the
// agent loop. Configured in app Settings (Settings.hooks) and, for TRUSTED
// workspaces only, in the project's .lite/hooks.json. The contract mirrors the
// convention other harnesses use so existing hooks port: JSON payload on
// stdin, 10s timeout, and the exit code is the verdict for gating events —
// 0 = allow, 2 = block (PreToolUse only), anything else = warn notice.
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

/** One hook. `matcher` is an EXACT tool name (same v1 posture as permission
 * rule tools: exact names, no patterns) and is only meaningful for the two
 * tool events; a hook without a matcher fires for every tool. */
export interface HookConfig {
  event: HookEvent;
  command: string;
  matcher?: string;
}

export const HOOK_LIMITS = {
  hooks: 20,            // Per source (app settings / project file).
  timeoutMs: 10_000,    // Hard per-hook wall clock; timeout = warn, never block.
  stdioBytes: 8192,     // stdout and stderr are each bounded to 8 KiB.
  commandChars: 1000,
  matcherChars: 64,
  trustedWorkspaces: 50,
} as const;
