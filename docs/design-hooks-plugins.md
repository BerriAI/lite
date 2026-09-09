# Design note: lifecycle hooks, plugin packages, and sidecar extensions

Status: proposed → implementing (4.3 → 4.4 → 4.5 in that order).

## 4.3 Lifecycle hooks

Shell-command hooks around the agent loop, configured in two places: app Settings (`Settings.hooks`) and project `.lite/hooks.json` — project hooks run **only for a workspace the user has marked trusted** (one-time per-workspace prompt persisted in settings; the trust decision names the workspace path).

Events (v1): `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`. Each hook: `{event, command, matcher?}` where matcher is a tool-name pattern for the tool events (same matcher syntax as permission-rule tools: exact names only, v1). Contract mirrors the convention other harnesses use so existing hooks port: JSON payload on stdin (`{event, sessionId, workspace, tool?, args?, output?}`), 10s timeout, and the **exit code is the verdict** for gating events: 0 = allow, 2 = block (PreToolUse only; the tool result becomes the hook's stderr, honestly attributed: "Blocked by PreToolUse hook"), anything else = warn (surfaced in the session as a system notice, never blocks). Hook stdout is captured, bounded (8 KiB), and attached to the transcript as an auditable notice when nonempty.

Ordering with existing layers: permission rules and approval decide first; PreToolUse hooks run **after** approval, immediately before execution (a hook cannot approve what the user denied — it can only block what was approved). Hooks never run for researcher children (their five-read ceiling doesn't warrant it, and project hooks would be an authority leak into an unattended context — v1 keeps children hermetic).

## 4.4 Plugin packages (install-time trust)

`lite plugin install <git-url|path>` (CLI) and Settings → Plugins (UI): a package is a directory with `lite-plugin.json` (`{name, version, description, skills?, commands?, mcpServers?, hooks?}`) whose entries are relative paths/config fragments. Install = **dry-run plan first** (exact list: which files land in `.lite/skills/`, `.lite/commands/`, which MCP servers and hooks would be added to settings with their commands visible), then explicit confirm. Provenance recorded per installed item (`installedBy: <plugin>@<version>`) so uninstall is exact. MCP servers from a plugin land **disabled** — connecting stays the explicit act it is today. Hooks from a plugin land under the same workspace-trust gate. Compatible manifests (`.claude-plugin/plugin.json`) are read where the shapes map.

## 4.5 Sidecar extensions (deferred to after 4.4 ships)

Out-of-process sidecars with tool-call interception get designed against the hook substrate: a sidecar is a long-lived hook with a JSON-RPC stream instead of one-shot exec. v1 of this note commits only to the constraint already agreed: interception must be **visible** — a modified call renders "modified by <plugin>" on the activity card, and the unmodified original is preserved in the transcript metadata. Full protocol design happens after hooks + packages prove the trust flow.
