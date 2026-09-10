# Multi-model architectures

Lite treats the arrangement of models as a session setting. The web picker exposes Single model, Sidekick Fusion, Team Fusion, and Expert Fusion. Models are configurable routes to connected providers, not models bundled with Lite. File Pipeline is not implemented.

The aim is to reserve stronger models for the work that benefits from them while cheaper models handle suitable assignments. Persistent sidekick context is inspired by [Cognition’s Devin Fusion](https://cognition.com/blog/devin-fusion). Quality, cost, and latency need to be measured for each model combination and task.

## Arrangements

- **Single model:** the existing general-purpose tool loop.
- **Sidekick Fusion:** the lead plans, delegates, and reviews; a write-capable sidekick retains context across compatible handoffs. Foreground calls wait for its report while the server remains responsive to events, steering, approvals, and cancellation. The two model calls do not run simultaneously during a handoff.
- **Team Fusion:** the lead uses `delegate` for fresh task-scoped workers. Each receives a self-contained brief with relevant paths, constraints, and acceptance criteria. Source editing belongs to workers; the lead inspects the result and uses `verify` for combined checks.
- **Expert Fusion:** a cheaper driver uses fresh strong experts for implementation and repairs, then runs verification itself. An expert receives the selected brief and workspace tools, not a fork of the driver conversation. It cannot delegate or ask the user questions.

Team and Expert drivers cannot invoke arbitrary Bash or connected tools to bypass their role. Their `verify` tool accepts a small grammar of foreground test, typecheck, lint, and build commands, and runs through the normal Bash permission and interception policy. Test scripts remain executable workspace code, not an operating-system sandbox. After a worker failure, `takeover` records a reason and exact file paths and allows at most three driver file edits in that turn. Source-edit tools are advertised only while that recorded takeover has edits remaining. A repair names the failed invocation with `repairOf`; unresolved assignments stay visible.

## Configuration and policy

`shared/architectures.ts` defines the selection union, role metadata, and route helpers; `server/app.ts` validates API input. A selection is:

```json
{"kind":"sidekick-fusion","sidekick":{"providerId":"gateway","model":"fast-model"}}
{"kind":"team-fusion","worker":{"providerId":"gateway","model":"fast-model"}}
{"kind":"expert-fusion","expert":{"providerId":"gateway","model":"strong-model"}}
```

The picker starts with an architecture dropdown and displays only its required model rows. Every row has its own searchable model menu and per-model reasoning control. Below a divider, the optional Planner model switch reveals the Plan-mode route. Output style is a compact separate row. First-use workspaces default to Single model.

The session's `providerId`/`model` remain the lead or driver. Clearing `architecture` selects Single model. Configuration changes require an idle session and advance its revision; queued messages pause for explicit review and resume. Workspace preferences remember the most recently selected model arrangement without changing existing sessions or copying credentials.

A turn captures its workspace, model routes, permission rules, reasoning preferences, guidance, style, profile, and hooks at acceptance. Child actions use that policy, not stale settings in a persisted child. Model effort is saved per provider/model pair. Provider default omits the override. Catalog-advertised efforts constrain the picker and preflight; when capability metadata is missing, an explicit override is passed through and provider rejection gives recovery guidance. Model names do not imply capability or context-window size.

Plan mode uses the selected main model or optional planner, exposes read-only tools, and launches no write-capable workers. Returning to Build restores the arrangement. Profiles with tool restrictions incompatible with Fusion are rejected before accepting the task.

## Contexts and immutable handoffs

Every handoff has a new invocation ID, origin tool call, terminal report, and transcript slice. Sidekick alone can reuse a completed context whose captured configuration, workspace, and history remain compatible. Failed, cancelled, or incompatible contexts are retired. Undo/Redo and recovery advance the history revision so a later call cannot silently revive abandoned context.

Worker compaction preserves the current assignment and archives earlier raw messages privately. Every completed handoff retains its own transcript even after later compaction. Root history archives remain ordinary archived sessions. The database migration removes the old unique-child restriction without deleting transcripts; old Sidekick records that cannot reconstruct overwritten origins are marked as legacy context associations.

## Ownership and lifecycle

Worker file-tool changes belong to the root turn with actor and invocation attribution. Foreground commands save a source observation before execution and reconcile file changes afterward. An interrupted observation requires recovery and does not replay the command. Undo/Redo covers supported recorded source files and refuses intervening edits; history notices identify effects outside that guarantee.

Approvals belong to the root UI and name the actual action and actor. Worker PreToolUse/PostToolUse hooks inherit the captured parent policy. Sidecar configurations are captured at acceptance; changing them during a response blocks remaining intercepted calls until a new response. Sidecar modifications retain original arguments and pass approval again. Read-only researchers retain their stricter tool ceiling and do not inherit mutating hooks.

Stop aborts active child requests and approvals and waits for owned background jobs to stop before settling their reports. A worker that returns with unfinished background commands is failed and those commands are stopped. Approval wait time is excluded from worker execution time limits. Steering is recorded before acknowledgement and sent to the driver, stopping active delegated work so the driver can apply the new instruction. A note that arrives too late remains visible for continuation; recovery restores acknowledged notes even if the process stopped before delivery.

All Fusion workers share a per-root-turn budget: eight invocations, 120 model steps, and 30 cumulative active minutes. Each invocation is limited to 50 steps, ten active minutes, 16 MiB of transcript, and a 64 KiB report; the configured max-step ceiling may be lower. These limits bound repair and fallback activity. Read-only research has its separate, smaller budget.

## Isolated worker execution

Team and Expert run all independent `delegate` calls requested together in parallel by default, within the turn budget. An optional concurrency limit of one to four caps simultaneous workers; remaining calls run in subsequent groups. Driver tool calls retain their original order. Each worker starts in a private copy of the current workspace, including dirty source files, with its own Git baseline and a 256 MiB copy limit. Existing installed `node_modules` may be linked for execution; generated/dependency directories are outside source history and this is not a hostile-code sandbox.

New steering invalidates pending publication. After all workers stop, Lite compares each candidate patch with the captured baseline and current root files. Overlapping worker paths and external root edits are conflicts, so those assignments do not overwrite root files. Unsupported binary/large changes are retained for review. Successful text patches are applied through root history intents. A partial integration interrupted by cancellation or a crash uses ordinary file-history recovery. Only integrated changes and checks in the root workspace count as root verification evidence; tests inside a copy do not establish combined correctness. Failed/conflicting workspaces remain available at their reported local paths.

## Evidence and accounting

Each uninterrupted stretch of tool calls appears live, then collapses into one work log when the assistant adds text or finishes. Requested workers and experts have separate numbered cards, including while queued, with their own briefs, models, status, reports, and tool transcripts. Runtime activity comes from the executing worker. Verification receipts are based on recorded tools and observed file effects, not a worker's prose. A later successful identical check supersedes the earlier failure without removing its historical record. Unresolved checks, assignments, and missing driver verification remain visible.

A durable request ledger attributes usage to the root turn, actor, model, and phase, including worker calls, retries, compaction, and goal review. Repeated cumulative usage chunks update one request. The footer appears once after the root response and expands into a role/model breakdown. Missing usage stays unreported; a partly priced task has no fabricated total cost. No architecture promises a quality, latency, quota, or cost improvement without measurement.

## Validation

Runner integration tests exercise persistent versus fresh context, parent approvals and edits, repairs, cancellation, hooks, compaction, concurrent private workspaces, conflicts, and integrated verification. Storage tests cover migration, immutable records, recovery, and usage. Browser tests cover selection, task details, history, and the existing session flows. The [terminal client](tui.md) uses the same runner and is covered by real PTY workflows for all four architectures. Existing CLI session execution remains supported.

For an opt-in live smoke comparison against connected providers, run:

```sh
node scripts/fusion-smoke.mjs --strong-provider PROVIDER_ID --strong-model MODEL_ID --cheap-provider PROVIDER_ID --cheap-model MODEL_ID
```

The script uses a separate identical CSV-parser fixture for each arrangement, restores its independent acceptance tests before scoring, cancels timed-out runs, archives test sessions, and records provider-reported family usage, failed or denied root tools, and takeovers. It checks host completion holds separately from independent test success. Pass `--architecture expert-fusion` (or another arrangement ID) to run only that arrangement. It writes a JSON report and retains fixture workspaces for inspection. One small task is not a general quality or cost benchmark. See the [delivery audit](fusion-implementation.md) for recorded results.
