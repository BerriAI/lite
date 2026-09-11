# Fusion delivery audit

September 10, 2026. Implements the approved product plan on top of `33f45d6` using the compact UI principles. File Pipeline remains deferred. TUI work was deferred for this Fusion delivery and is now covered by the [terminal replacement audit](tui-parity-plan.md). Single model, Plan/Build, provider configuration, read-only research, and existing sessions remain supported.

## Requirement-by-requirement evidence

| Completed requirement | Implementation | Verification |
| --- | --- | --- |
| Persistent compatible Sidekick context and immutable handoffs | `server/delegations.ts`, `server/store.ts`: each handoff has its own identity, report, transcript range, and evidence. Compatible handoffs share the worker session. Migration preserves old data with a legacy-context label. | `tests/delegation-store.test.ts`, `tests/sidekick-runner.test.ts`, and `tests/e2e/sidekick.spec.ts` cover migration, reuse, immutable earlier transcripts, and changing context. |
| Current policy and routes at acceptance | `server/runner.ts` captures workspace, tools, permission rules, model routes, reasoning, profile, guidance, hooks, sidecars, reviewer, and output style. Compatibility includes history revision and provider configuration. | Runner tests cover changed workspace, permissions, providers, reasoning, history, and stale children. Client tests reject stale configuration updates. |
| Root-owned changes and supported Undo/Redo | `server/history.ts`, `server/workspace-snapshot.ts`: worker file edits and observed foreground-command source changes belong to the root turn, with actor attribution and conflict checks. | Sidekick, receipts, accounting, history, and parallel-worker tests cover root Undo/Redo, external edits, interrupted shell reconciliation, and partial integration recovery. Browser Fusion flows undo the actual worker-created file. |
| Cancellation, steering, approval, restart, and interception | `server/runner.ts`, `server/jobs.ts`, `server/hooks.ts`: the root owns the task family and waits for child/job cleanup. Steering is saved before acknowledgement and recovered once after interruption. Workers run applicable hooks and sidecars; modified actions are revalidated and reapproved. | Runner suites cover child cancellation, approval waits, background-job cleanup, live steering, durable recovery, and hook/sidecar modification. Mid-turn sidecar changes block affected actions until a new response. |
| Sustained context and bounded recovery | Private worker archives preserve raw transcripts through compaction; current policy is supplied separately from generated summaries. Shared invocation, step, and active-time budgets bound workers and repairs. | Compaction/rehydration, approval-wait timing, fresh repair, recorded takeover, and failed-finalization tests in the runner suites. |
| Team Fusion | Fresh scoped workers use the configured worker route. The driver delegates implementation and records its own verification. Source edits require an explicit bounded takeover after failure. | Runner and browser Fusion tests verify role ownership, tool restrictions, integration, and root verification. |
| Expert Fusion | A cheaper driver supplies a fresh brief to a stronger implementation worker and verifies its result. Repairs create fresh invocations with selected failure evidence. | Tests cover fresh contexts, failure resolved by `repairOf`, explicit takeover, source-edit boundaries, and the complete browser flow. |
| Simple model configuration | `client/src/ModelPicker.tsx`: four-option architecture dropdown with one-line explanations; role-specific searchable model menus; aligned reasoning; optional planner below a divider; compact output style and Team concurrency. | Desktop and 390px browser tests configure and persist choices. Light and dark screenshots were inspected with menus closed/expanded and the planner enabled. |
| Workspace preferences and Plan/profile compatibility | `server/workspace-preferences.ts`, `server/app.ts`, `client/src/App.tsx`: validated workspace defaults, preserved existing sessions, stale-update protection, and preflight compatibility checks. Plan does not launch mutating workers. | Configuration tests and browser flows cover new-session defaults, persisted routes/reasoning, separate planning models, and incompatible profiles. |
| One coherent response, live status, usage, and evidence | `shared/conversation.ts`, `server/usage.ts`, `client/src/Conversation.tsx`, `client/src/TaskCard.tsx`: one work log and family-level usage footer, immutable invocation details, live actor/phase, and request accounting across retries/compaction/review. | Accounting, events, receipts, and browser tests cover cumulative usage, system notices, invocation details, verification, and the expanded usage display. |
| Isolated parallel Team workers | `server/parallel-workers.ts`: private copies of the current source baseline; a completion barrier; guarded text integration; retained conflict/failure evidence. | Parallel-worker and runner integration tests cover successful batches, overlapping paths, external edits, cancellation, steering invalidation, and a fault during publication followed by recovery/Undo/Redo. |
| Editable profiles in normal Settings | `client/src/ProfileEditor.tsx`, `client/src/ProfilePicker.tsx`, `client/src/Settings.tsx`, `server/profiles.ts`: create/edit project profiles, save safely, then explicitly apply pinned instructions. Other profile/skill declarations are preserved. | Profile server/client/browser suites cover round trips, invalid or changed manifests, stale saves, file aliases, preserving other definitions, explicit application, and switching Settings tabs without losing the editor draft. |
| Sidebar cleanup | `client/src/App.tsx`, `client/src/styles.css`: less space above Your sessions, bottom Settings gear, removed Search anything row. Existing ⌘K command palette remains. | Navigation/settings browser flows pass; sidebar and settings layouts inspected during visual checks. |
| Product documentation | Top-level `README.md` describes Litespeed as a harness for multi-model agents, lists all four arrangements, and explains the opening workflow. Architecture, profile, interception, and UI documentation describe the delivered behavior. | Documentation and diff audit; the original product plan is updated to the delivered UI and scope. |

## Validation

- `npm run check`: TypeScript passed; **1,590 tests passed, one skipped** across 80 files; production client/server build passed. Vite reports its bundle-size advisory.
- `npm run test:e2e`: **123 browser tests passed**. The suite covers provider setup, sessions, Sidekick, Team, Expert, configuration, approvals, questions, queues, profiles, history, MCP, terminal, and stream recovery.
- After the last presentation refinements, **23 targeted browser checks passed** across the picker, profiles, and Team/Expert flows. The profile tab-navigation check initially used an incorrect test selector (`General` instead of the visible `Workspace` tab); it passed after correcting the selector, with no application change.
- Light and dark desktop/mobile screenshots were inspected, including expanded model search, the architecture menu, enabled planning, and profile creation/editing.
- The live Expert trace prompted one final refinement: hide source-edit tools until takeover. Typecheck, **21 runner regressions**, **four complete Fusion browser flows**, and a fresh production build passed after that change. The tests verify both normal tool exclusion and availability after a recorded takeover.
- `scripts/fusion-smoke.mjs` completed a bounded live comparison through the configured local Litespeed server. Every arrangement received an independent copy of the same CSV fixture. Eight independent checks were restored before external verification. Completion requires an idle task with no reported error and passing independent checks.

## Live model comparison

The initial gateway HTTP 503 was resolved during validation. The live comparison used the configured `litellm` provider, `anthropic/claude-sonnet-4-5` as the stronger route, and `claude-haiku-4-5-20251001` as the cheaper route. Single, Sidekick, and Team used Sonnet as driver; Expert used Haiku as driver and Sonnet as expert. Reasoning used each model's default.

| Arrangement | Independent checks | Time | Model requests | Input tokens | Output tokens | Invocations |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Single model | 8/8 passed | 22.3s | 5 | 26,038 | 1,207 | 0 |
| Sidekick Fusion | 8/8 passed | 38.4s | 11 | 58,111 | 2,720 | 1 Sidekick |
| Team Fusion | 8/8 passed | 40.4s | 11 | 55,442 | 2,751 | 1 worker |
| Expert Fusion | 8/8 passed | 61.6s | 15 | 85,412 | 4,665 | 1 expert |

This table records the first comparison. All four passed the independent checks and finished idle without assistant/provider errors or takeovers. The first Expert driver nevertheless attempted two direct source edits, which Litespeed denied, and recovered from a mistaken directory read. The trace exposed that edit schemas were advertised before takeover even though execution was blocked; the final implementation now hides them until takeover. These attempts are retained in the raw report and included in its usage totals.

Every request reported token usage. The gateway did not report prices, so monetary cost stays unknown. Single model was fastest on this small task; the extra coordination did not demonstrate a latency or total-token saving. No general quota or quality claim follows from one fixture. The live Team case used the default sequential setting; parallel publication and fault cases are covered by deterministic tests.

The final Expert rerun with corrected tool advertisement passed **8/8 checks in 54.6 seconds**, using 14 requests, 70,847 input tokens, and 3,365 output tokens. It created one completed expert invocation, made no direct-edit attempts, needed no takeover, and finished without a host completion hold. One mistaken directory read failed and was recovered by subsequent inspection; that attempted call remains recorded. The comparison script distinguishes a host hold from the default paused state of an empty queue.

The first comparison report is retained as `10-live-fusion-comparison.json` and the final Expert verification as `11-live-expert-final.json` alongside the local planning artifacts. Each comparison session was archived, and its temporary fixture remains available for inspection. An intermediate rerun interrupted by the development server restarting was stopped and archived before the final verification; no uncertain request was replayed in that session.

To repeat with provider IDs and model IDs already configured in Litespeed:

```sh
node scripts/fusion-smoke.mjs \
  --strong-provider litellm --strong-model anthropic/claude-sonnet-4-5 \
  --cheap-provider litellm --cheap-model claude-haiku-4-5-20251001 \
  --timeout-seconds 240 --output /tmp/litespeed-fusion-comparison.json
```

## Practical limits

- The browser suite uses deterministic providers while executing real local tools and persistence. It verifies the harness contract, not arbitrary model quality. The live comparison is one small task per arrangement, not a general quality or savings benchmark.
- Costs are only shown when all relevant requests have adequate reported/priced usage. Missing cost remains unknown; token totals do not establish dollar savings.
- File history observes bounded UTF-8 source changes: up to 2 MiB per file, 12 MiB total content, and 10,000 entries. Binary, large, generated/dependency, background, external-process, and network effects are outside complete restoration. Their limitations remain visible.
- Team copies have a 256 MiB source-copy bound. They may share dependencies and are not an OS sandbox. Path isolation and guarded integration do not prevent an arbitrary executable from making external side effects.
- Team defaults to one worker. Choosing 2–4 permits isolated concurrent assignments when the driver submits a compatible batch; it does not force a model to decompose every task or guarantee a speedup.
- The Fusion family budget is eight invocations. Individual workers have no model-step or total-duration ceiling, a 16 MiB transcript bound, and a 64 KiB report bound. A ten-minute inactivity timer resets on model/tool progress and pauses for approval waits.
- Named profiles currently restrict delegation and MCP tools. A conflicting Fusion selection is rejected before execution; choosing the default profile or an appropriate architecture resolves it. Instruction-only skills can be used without a named profile's tool restriction.
- The last explicitly selected model setup is the default for new sessions across workspaces. It includes architecture, model reasoning, planner, and optional Shunt. Existing sessions keep their own configuration; workspace permission defaults remain local.
