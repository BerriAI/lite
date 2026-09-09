// Sidecar extensions (design note 4.5): user-installed long-lived interceptor
// processes — "a sidecar is a long-lived hook with a JSON-RPC stream instead
// of one-shot exec". v1 is DELIBERATELY SMALL — this is the last
// extensibility surface, not a platform: app-level configuration ONLY
// (project-level sidecars would need the same workspace-trust gate project
// hooks use; deferred), exactly ONE event ('tool_call', the interception
// point), at most 3 sidecars, first-interceptor-wins. Installing a sidecar in
// Settings IS the authorization (install-time trust, like plugin packages);
// what keeps that honest is that every interception is VISIBLE — the activity
// card shows "modified by <name>" and the unmodified original arguments are
// preserved in the transcript metadata (ToolCall.intercepted).
export const SIDECAR_EVENTS = ['tool_call'] as const;
export type SidecarEvent = typeof SIDECAR_EVENTS[number];

/** One sidecar. `name` is a lowercase slug (it appears verbatim in the
 * "modified by <name>" attribution); `command` starts the long-lived process
 * (/bin/bash -c, same posture as hooks and background jobs). */
export interface SidecarConfig {
  name: string;
  command: string;
  events: SidecarEvent[];
}

export const SIDECAR_LIMITS = {
  sidecars: 3,          // App-level total; small on purpose.
  commandChars: 1000,   // Same command bound as hooks.
  nameChars: 64,
  reasonChars: 200,     // modify/block reason shown to the model and the user.
  timeoutMs: 3000,      // Per tool_call round trip; timeout = pass + warn, never block.
  respawns: 3,          // Per sidecar per process; then disabled with a notice.
} as const;
