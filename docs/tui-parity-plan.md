# TUI web-parity audit and delivery

Audited September 10, 2026 against `ac9e522`, then implemented on `codex/tui-web-parity`. The replacement is in `tui/`. The older Node renderer and `--legacy` launcher path are removed. The [terminal guide](tui.md) describes the resulting user experience.

## What the audit found

The previous default OpenTUI renderer had useful foundations: HTTP/SSE streaming, Markdown and diffs, themes, configuration, and a keymap engine. It was missing much of the interaction layer that made the web client usable. The older renderer still owned more working workflows.

The audit reproduced a concrete Stop bug in a real terminal: Escape twice called `/interrupt`, while the server exposes `/cancel`. It also found drafts cleared before submission was accepted, no approval/question response controls, mostly inactive shortcut registrations, and per-message footers that attributed historical work to the session's current model. Project configuration followed the package directory instead of the selected workspace. Early terminal scripts had no checked-in runner and ended at pending approvals.

The implementation retained OpenTUI and the existing backend. It did not add a terminal-specific agent loop. Sessions, model routes, profiles, child invocations, permissions, file ownership, history, and usage remain server-owned.

## Delivered implementation

| Phase | Result | Main implementation |
| --- | --- | --- |
| Task loop | Real Stop endpoint; guarded submissions; drafts retained on rejection; approval previews and all three decisions; choice/custom questions; queues, steering, visible reconnect/error states | `tui/controller.ts`, `prompts.tsx`, `sync.ts`, `app.tsx` |
| Models and navigation | Four architectures with short explanations; searchable models by role; reasoning, planner, styles, concurrency; revision-safe saves; session create/switch/rename/archive/delete/fork/import/export | `models.tsx`, `sessions.tsx`, `app.tsx` |
| Conversation and Fusion | Shared root-turn grouping; one work log and family footer; historical routing; worker brief/report/tool evidence and scoped transcript; parent changes and history review | `conversation.ts`, `transcript.tsx`, `inspectors.tsx`, `sessionPanels.tsx` |
| Everyday editing and Settings | Persistent drafts/history; references and attachments; project command templates; external editor and shell; providers, profiles, permissions, MCP, usage, memory, goals and task lists | `storage.ts`, `files.tsx`, `projectCommands.ts`, `terminalIO.ts`, `settings.tsx` and related panels |
| Cutover | One `tui/` entry; bundled Bun; automatic local startup with attachment/ownership safeguards; reproducible PTY suite; production launcher smoke; README and terminal guide | `bin/lite.mjs`, `bin/tui-server.mjs`, `scripts/test-tui*.mjs` |

The retired `deriveRows` presentation logic and its obsolete footer assertions were also removed. Tests now cover the shared conversation semantics used by the actual renderer. Existing transport/config/theme/syntax tests moved alongside the single client. The unowned early phase scripts were replaced by `npm run test:tui`.

## Interaction decisions

The conversation takes most of the terminal. Completed activity sits under one expandable work log. The header shows the actual effective model and mode; waiting approvals or questions occupy the input area and preserve the draft. Ctrl+P opens a compact navigation overlay. Settings, models, profiles, and inspection use the same aligned menu/dialog components.

Models follow the requested order: architecture, relevant roles, a divider and optional Planner, then output style. Configuration edits are staged until Save. A changed server revision rejects a stale editor instead of overwriting another client's choices.

Worker permissions are resolved through their root session. A handoff approval does not approve a worker's later write or command. Worker inspection uses the guarded invocation endpoint rather than a mutable public child session. A reused Sidekick context can therefore expose an old assignment without mixing in later turns.

The terminal owns only its display process. An automatically started backend stays available after exit, just like a backend already used by the browser. Explicit URLs never trigger automatic startup. Editor and shell handoffs release terminal input and restore it on return; suspension stops the foreground job, including the Node launcher.

## Verification

The implementation uses three complementary checks:

- `npm run check`: TypeScript, the full unit/integration suite, and production builds. After removing obsolete renderer tests, the verified run passed **1,598 tests**, with one existing opt-in test skipped.
- `npm run test:tui`: an actual PTY and terminal emulator against an isolated server/provider fixture. This covers Single, persistent Sidekick, fresh Team/Expert workers, separate handoff/edit/verification approvals, worker cancellation, questions, keyboard steering, queues, profiles, goals, references, stale configuration, Plan routing, parent Undo/Redo, external editor, shell handoff, Unicode paste, session switching, process restart, 80/100/140 columns, and a 12-row composer.
- `npm run test:tui:startup`: the built application copied into an isolated installation, exercising the real launcher, automatic production backend startup, caller workspace, suspension/foregrounding, clean exit, and retained backend ownership. It does not contact a paid provider.

The full web suite initially passed 121 of 125 tests. Four remaining failures were selectors invalidated by the concurrent web transcript redesign. Those selectors were updated, and the affected session/workspace suite passed all 15 checks. A separate CLI assertion was narrowed to match the expected session line: checking for the digits `401` anywhere in stderr could accidentally match a randomly generated session ID.

## Follow-up release matrix

The core replacement and the previously supported legacy task workflows are implemented. Additional portability and external-service validation remains useful without retaining a second client:

- Native Linux terminal-emulator runs and Windows support validation. The PTY acceptance environment for this delivery is macOS with Node 26 and Bun 1.4.2.
- Fresh paid-provider and interactive sign-in smoke tests. Deterministic fixtures exercise the real runner, policy, child sessions, file history, and usage accounting, but cannot certify external provider availability or model quality.
- Broader terminal-emulator coverage for OSC 52, theme detection, unusual keyboard protocols, and complex Unicode. Small terminals use bounded menus and retain the composer; 80×24 or larger is recommended.
- Optional reference-client extras: reserved keybinding actions, sound packs, and richer shell/job dashboards. These are not advertised as implemented controls.

File Pipeline remains a separate architecture experiment. The TUI uses the same four released arrangements as the web app.

## Main integration verification (2026-09-10)

Integrated `main` through `ab49d19`, including live worker activity and approved external-path access. Bare `lite` now launches from any project directory. Terminal model settings preserve automatic parallel execution and explicit concurrency limits for both Team and Expert. The browser workspace panel closes on narrow layouts while preserving its desktop preference.

- TypeScript and production builds passed. The full unit/integration run passed 1,630 tests with one opt-in runtime test skipped; after the responsive-layout fix, all 117 affected client tests passed again.
- Both terminal PTY suites passed, including real command discovery on PATH, automatic backend startup, caller workspace, suspend/foreground, and model-setting persistence.
- The complete browser run passed 130 of 131 scenarios and exposed the mobile workspace overlay. After fixing it, all 32 affected browser scenarios passed, including the previously failing profile flow and a new resize/reload regression.
- README reference material moved into linked usage, provider, CLI, local-data, and development guides. Local documentation links and anchors were checked.
