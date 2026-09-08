# Feature coverage

This document distinguishes implemented behavior from planned work. A feature's existence is not evidence of complete ecosystem parity.

## Implemented foundation

| Area | Current behavior | Verification |
| --- | --- | --- |
| Provider loop | Streaming text/reasoning, fragmented tool calls, real execution and continuation | Mock HTTP API/provider tests; actual gateway CLI response and browser read → write → test → report loop |
| Permissions | Ask, allow once, remembered tool grants scoped to session/workspace, revoke, deny, auto; changed MCP config invalidates grants; Plan removes mutable tools | API/store and browser tests |
| Cancellation | Abort model stream, retry backoff, compaction, and pending approvals; process-group shell termination | API/provider/tools tests |
| Recovery | Two bounded retries for explicit transient HTTP failures only; third identical tool batch blocked; one-shot context-overflow summary/recovery with archived original history and intact latest user turn | Provider, context, API and transactional store tests |
| Terminal | Real per-session PTY, hide/reconnect/replay, resize, Ctrl+C, explicit exit, bounded queues and idle expiry | 30 terminal tests including real PTY; actual Chrome terminal lifecycle on desktop/mobile |
| Persistence | SQLite sessions/messages/todos/events/file snapshots; restart recovery | Store tests |
| File tools | Read/write/edit, search, glob, bounded shell/web retrieval | Isolated filesystem/process tests |
| MCP | Stdio discovery/calls, HTTP transport and SSE fallback, status, cancellation | Real fixture subprocess tests; remote transports not yet exercised end to end |
| Provider auth | Server-side API keys; explicit ChatGPT device/browser protocol | Mock auth/provider tests; no live subscription account validation |
| Undo | Session mutation lock, all-target preflight, per-file content/inode rechecks, protected-path guard, retained pending snapshots on partial conflicts | API/tools tests, including late edits and symlink/inode replacement; not per-turn undo/redo or cross-file atomic |
| History boundaries | Snapshot-only attachments and inert imports; forks trim incomplete tool groups | API/store/context tests |
| Follow-up queue | Persistent FIFO snapshots, Pause/Resume/remove, success-only drain, explicit restart/error/cancellation holds; transactional acceptance | Store/API tests, six browser queue/draft scenarios, actual gateway browser write → two queued follow-ups with no duplicate turns |
| Drafts | Session-isolated browser text/attachment persistence with bounded storage, memory-only fallback warning, no stale-response clearing | Browser switching/reload/submission/failure scenarios |
| CLI | Serve, run, sessions, models, export, JSON events, strict flags, error exit codes and interrupt cancellation | 54 spawned CLI tests; actual gateway run; production CLI lifecycle on Node 22.13.0 |
| Production runtime | Built server/static UI, persisted streaming tool workflow, CLI restart and native PTY | Opt-in isolated production test passed on exact Node 22.13.0, macOS arm64 |
| UI | React workspace, sessions, composer, model/settings/file/review/terminal/queue controls | 21 browser scenarios including streaming reload/isolation, permissions, queue/drafts, fork, inert import/export, terminal lifecycle, settings and responsive layouts |

## Known gaps and next work

- Full standalone TUI, IDE/ACP integrations, and remote authenticated attach are not implemented. Terminal shells are process-local, macOS/Linux only, with bounded raw replay rather than a full-screen snapshot.
- Mid-response steering and proactive token-budget compaction are not yet implemented. The queue sends a separate next turn, never rewrites an active request. Context recovery is reactive to explicit overflow, once per run; very large latest turns still need a larger model or smaller attachments.
- Queues do not replay an already accepted turn after a process restart. Pending items require explicit Resume. Draft storage is browser-local convenience, not durable shared storage; large drafts or storage failures are shown as memory-only.
- Configurable agents/subagents, rich permission pattern rules, skills, LSP diagnostics, and formatters are not yet integrated.
- Undo is session-wide recorded-file restoration, not per-user-turn history undo/redo. Shell changes are not captured.
- MCP OAuth, resources/prompts, tool-list updates, and automatic reconnection require additional work.
- Standard registered Git worktrees are supported through a narrow Git-only metadata validation path. Config includes, object alternates, and symlinked metadata are deliberately rejected; disabled filters can affect status for filtered files. This does not relax file-tool workspace boundaries.
- Config is local SQLite plus environment defaults, not a layered JSONC/managed policy system.
- Public sharing, plugins, hosted CI integrations, and usage dashboards are not implemented.

## Evidence policy

Only update a verification entry after actually running the corresponding test. Keep screenshots and private integration artifacts in ignored local storage. Never commit API credentials, subscription tokens, or real prompt data that should remain private.
