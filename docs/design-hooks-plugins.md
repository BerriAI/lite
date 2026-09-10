# Design note: lifecycle hooks, plugin packages, and sidecar extensions

Status: implemented (4.3, 4.4, 4.5).

## 4.3 Lifecycle hooks

Shell-command hooks around the agent loop, configured in two places: app Settings (`Settings.hooks`) and project `.lite/hooks.json` — project hooks run **only for a workspace the user has marked trusted** (one-time per-workspace prompt persisted in settings; the trust decision names the workspace path).

Events (v1): `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`. Each hook: `{event, command, matcher?}` where matcher is a tool-name pattern for the tool events (same matcher syntax as permission-rule tools: exact names only, v1). Contract mirrors the convention other harnesses use so existing hooks port: JSON payload on stdin (`{event, sessionId, workspace, tool?, args?, output?}`), 10s timeout, and the **exit code is the verdict** for gating events: 0 = allow, 2 = block (PreToolUse only; the tool result becomes the hook's stderr, honestly attributed: "Blocked by PreToolUse hook"), anything else = warn (surfaced in the session as a system notice, never blocks). Hook stdout is captured, bounded (8 KiB), and attached to the transcript as an auditable notice when nonempty.

Ordering with existing layers: permission rules and approval decide first; PreToolUse hooks run **after** approval, immediately before execution (a hook cannot approve what the user denied — it can only block what was approved). Hooks never run for researcher children (their five-read ceiling doesn't warrant it, and project hooks would be an authority leak into an unattended context — v1 keeps children hermetic).

## 4.4 Plugin packages (install-time trust)

`lite plugin install <git-url|path>` (CLI) and Settings → Plugins (UI): a package is a directory with `lite-plugin.json` (`{name, version, description, skills?, commands?, mcpServers?, hooks?}`) whose entries are relative paths/config fragments. Install = **dry-run plan first** (exact list: which files land in `.lite/skills/`, `.lite/commands/`, which MCP servers and hooks would be added to settings with their commands visible), then explicit confirm. Provenance recorded per installed item (`installedBy: <plugin>@<version>`) so uninstall is exact. MCP servers from a plugin land **disabled** — connecting stays the explicit act it is today. Hooks from a plugin land under the same workspace-trust gate. Compatible manifests (`.claude-plugin/plugin.json`) are read where the shapes map.

## 4.5 Sidecar extensions

Out-of-process sidecars with tool-call interception, designed against the hook substrate: a sidecar is a long-lived hook with a JSON-RPC stream instead of one-shot exec. The agreed constraint holds: interception must be **visible** — a modified call renders "modified by <name>" on the activity card, and the unmodified original is preserved in the transcript metadata (`ToolCall.intercepted = {by, originalArgs, reason}`). v1 is deliberately small — this is the last extensibility surface, not a platform.

**Configuration** (`Settings.sidecars`, max 3): `{name: slug, command: <=1000 chars, events: ['tool_call']}`. App-level ONLY — a project-level sidecar would need the workspace-trust gate project hooks use; deferred. Settings PATCH is the whole surface (zod validated, 400 on violation); no dedicated routes. Installing a sidecar in Settings IS the authorization (install-time trust, like plugin packages).

**Protocol**: per-config lazy spawn (`/bin/bash -c`, harness-credential-stripped environment, killed on shutdown), newline-delimited JSON-RPC 2.0 over stdio. On each intercepted call the host sends `{method:'tool_call', params:{sessionId, tool, args}}` and expects within 3s: `{result:{action:'pass'}}`, `{result:{action:'modify', args, reason<=200}}`, or `{result:{action:'block', reason<=200}}`. Timeout, malformed output, or a crash all resolve to **pass with a warn notice** — a broken sidecar never breaks the loop. A crashed sidecar respawns on next use, at most 3 times per server process, then is disabled with one notice for the process lifetime.

**Interception point and order**: approval → PreToolUse hooks → sidecars → execute. Hooks are cheap one-shot gates that keep first refusal; sidecars are the heavier long-lived layer and only see calls every cheaper gate allowed. `block` → the call is denied with `Blocked by sidecar <name>: <reason>`. `modify` → the modified args execute (re-validated by the normal execution path — bad args throw an ordinary tool error) and the original is preserved. A `modify` revalidates the changed arguments and runs permission checks again before execution. First non-pass sidecar wins; no modify chains.

**Whitelist (v1)**: only `read_file, write_file, edit_file, bash, glob, grep, web_fetch, todo_write` are interceptable. Sidecars never see `capability`/`mcp_*` calls (lease identity complexities), `task`, `ask_user`, `update_goal`, or `memory_*`. Read-only researchers never run sidecars. Write-capable Fusion workers inherit the captured parent policy.

**Configuration capture**: the sidecar configuration is captured at turn acceptance. A mid-turn settings change blocks remaining intercepted calls and asks for a new response, so a shared process pool cannot silently switch policy or respawn a superseded command for an older run.
