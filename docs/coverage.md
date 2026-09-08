# Feature coverage

This document distinguishes implemented behavior from planned work. A feature's existence is not evidence of complete ecosystem parity.

## Implemented foundation

| Area | Current behavior | Verification |
| --- | --- | --- |
| Provider loop | Streaming text/reasoning, fragmented tool calls, real execution and continuation | Mock HTTP API/provider tests; actual gateway CLI response and browser read → write → test → report loop |
| Permissions | Ask, allow once, allow same tool for the current run, deny, auto mode; Plan removes mutable tools | API integration tests |
| Cancellation | Abort model stream and pending approvals; process-group shell termination | API/tools tests |
| Persistence | SQLite sessions/messages/todos/events/file snapshots; restart recovery | Store tests |
| File tools | Read/write/edit, search, glob, bounded shell/web retrieval | Isolated filesystem/process tests |
| MCP | Stdio discovery/calls, HTTP transport and SSE fallback, status, cancellation | Real fixture subprocess tests; remote transports not yet exercised end to end |
| Provider auth | Server-side API keys; explicit ChatGPT device/browser protocol | Mock auth/provider tests; no live subscription account validation |
| Undo | Restore all recorded file-tool changes for a session, external-edit conflict guard | API tests; not per-turn undo/redo |
| CLI | Serve, run, sessions, models, export, JSON events | Actual help and real gateway run; fuller automation tests pending |
| UI | React workspace, sessions, composer, model/settings/file/review controls | Nine browser E2E scenarios passing; desktop/mobile/dark screenshots inspected |

## Known gaps and next work

- Interactive terminal/TUI, persistent terminal pane, IDE/ACP integrations, and remote authenticated attach are not implemented.
- Automatic context compaction, bounded transient retries, message queue/steering, and repeat-tool-loop guard need dedicated implementation and tests.
- Configurable agents/subagents, rich permission pattern rules, skills, LSP diagnostics, and formatters are not yet integrated.
- Undo is session-wide recorded-file restoration, not per-user-turn history undo/redo. Shell changes are not captured.
- MCP OAuth, resources/prompts, tool-list updates, and automatic reconnection require additional work.
- Git worktree metadata outside the workspace is currently rejected by strict path checks.
- Config is local SQLite plus environment defaults, not a layered JSONC/managed policy system.
- Public sharing, plugins, hosted CI integrations, and usage dashboards are not implemented.

## Evidence policy

Only update a verification entry after actually running the corresponding test. Keep screenshots and private integration artifacts in ignored local storage. Never commit API credentials, subscription tokens, or real prompt data that should remain private.
