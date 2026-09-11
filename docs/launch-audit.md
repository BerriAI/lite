# Launch audit · September 10–11, 2026

This audit covers the local installation, shared backend, terminal and browser clients, provider adapters, tool permissions, worker execution, persistence, recovery, and release setup. The target is people installing their own local instance. It does not establish readiness to host one unauthenticated instance for 100 people.

## Launch assessment

The everyday macOS workflow is exercised end to end. The runtime and input problems found during this audit are fixed below. A macOS release workflow now provides fresh dependency installation, typechecking, tests, builds, production TUI startup, and packaged install/update checks on Apple silicon and Intel runners. Large conversation exports still have the documented restore limitation below. Native Linux/Windows and live ChatGPT subscription authentication are not verified by this audit.

## Fixed during this audit

### A second backend could interrupt the first backend's saved work

`Store` performs restart recovery during construction; `History` marks open checkpoints interrupted. Previously, the server did both before trying to bind its port. Starting `litespeed serve` or `npm start` while a backend was already running could therefore change saved state even when the second server eventually failed to bind. Starting on another port could leave both writers alive.

A disposable reproduction changed a synthetic turn from `running` / checkpoint `open` to `idle` / checkpoint `interrupted` merely by opening a second store and history manager. The built-server reproduction on separate ports showed the primary session becoming idle and requiring recovery.

The production entrypoint now acquires exclusive data-directory ownership before opening or recovering the application database. A small separate SQLite database holds the operating-system lock; termination releases it without stale PID-file guessing. The application database remains readable by diagnostics. This uses SQLite's documented [exclusive locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode).

After the fix, the built second backend exits with code 1 and an explicit ownership error; the first stays `running` with no pending recovery. Tests also cover clean release, repeat close, and SIGKILL release. All backends sharing a data directory must use the updated entrypoint; stop an older backend before updating.

### Worker output repeatedly decoded the full transcript

The per-chunk worker transcript-size check called `store.messages()` and serialized the entire result for every streaming chunk. This added synchronous work proportional to the saved conversation size while workers were streaming, on top of ordinary persistence and UI work.

A synthetic 5,043,075-byte transcript required about 1,620 ms for 500 checks on this Mac. Counting persisted UTF-8 bytes directly in SQLite took about 209 ms for the same checks. The worker limits are unchanged. A regression checks exact counts for empty history, Unicode, escaping, replacement, and streamed updates. This is a measurement of that check, not an 8× claim about overall model speed; provider latency, ongoing writes, and rendering remain separate costs.

### A delayed dialog focus could put credentials into the wrong field

The full browser suite twice caught an apparently lost API-key draft. Its trace showed that the synthetic key had actually been appended to the provider name: a 40 ms autofocus timer moved focus between selecting the password field and inserting text. This could expose pasted credentials in a plain-text field. Dialog focus now runs synchronously with layout, before subsequent input. A deterministic focus regression fails before the fix and passes afterward; MCP draft preservation is also covered in the browser suite.

### Command completion and setup interaction

Browser completion used a delayed cursor change that could run after the next character was typed. An end-to-end test caught `notes.txt` becoming `otes.txt …n`; cursor placement now happens with the committed text before the next input event. The terminal menu also resets search state by screen identity instead of a late effect that can erase early search input.

Both composers suggest commands. Built-in web actions execute locally, without sending a provider request; project commands still expand arguments when sent. Setup recommends Sidekick Fusion, describes the model suited to each role, keeps Single model available, and preserves existing selections. The web sidebar shows the train alone. Mobile model settings can scroll while their action footer stays visible.

### Unsupported Node versions could finish installation and then crash

A subsequent coworker installation on Node 20.20.2 emitted `EBADENGINE` warnings, completed its build and link, then crashed because `node:sqlite` was unavailable. The current OpenTUI dependency also declares Node 26.4+. Package metadata now matches that minimum, repository npm configuration rejects unsupported engines, and a dependency-free preinstall/launcher check gives upgrade instructions. The server and migration entrypoints check before importing SQLite.

The exact Node 20.20.2 runtime reproduced the original crash. The updated `npm ci` dry run rejected it before creating `node_modules`; CLI, built server, development server, and migration entrypoints all stopped with the explicit version message. The built-runtime integration test passed on exact Node 26.4.0, including restart, file undo/redo, and MCP lifecycle. This verifies runtime compatibility and the rejection path, not a complete cold dependency installation. The terminal startup suite also passed.

### License and bundled attribution

The maintainer selected Apache-2.0. The repository now includes the full license, matching package metadata, and README guidance. The bundled terminal theme catalog includes OpenCode theme definitions; the audit verified an exact upstream match and restored the MIT attribution in `THIRD_PARTY_NOTICES.md`. Geist and Geist Mono retain their SIL Open Font License notices, which are also copied into the built web client.

### Conversation caching and distribution

The provider adapter now marks growing conversation history as cacheable through both LiteLLM Chat Completions and native Anthropic Messages. Sixteen live synthetic requests completed correctly; subsequent fixed requests reused about 99% of input, while the system-only baseline reported no hits. The [reproducible results](../research/cache/README.md) supersede the earlier claim that gateway caching was disabled.

[Litespeed 0.1.2](https://github.com/BerriAI/litespeed/releases/tag/v0.1.2) is published for Apple silicon and Intel Macs. Its packages include their own Node and Bun runtimes. The installer verifies downloads, and updates preserve application data outside version directories. Both interfaces report available updates. See [installation and update behavior](installing.md).

## Remaining launch issues and decisions

| Priority | Issue | Evidence and consequence | Next action |
| --- | --- | --- | --- |
| High | Large exports are not reliably restorable | A synthetic 14,004,913-byte conversation exported with HTTP 200 and failed to import with HTTP 413. `server/app.ts` limits JSON bodies to 12 MiB; web import accepts files up to 15 MiB. Imports also cap each message at 500,000 characters and the conversation at 10,000 messages. Multiple image attachments across turns can reach the body limit. The original session is preserved, but an export is not a dependable standalone backup. | Align export/import contracts and add large attachment round-trip coverage. Prefer a bounded archive/streaming restore design over removing request limits. The current limits and full-data backup procedure are now documented in `local-data.md`. |
| Outside the macOS launch scope | Other platforms and subscription sign-in need live verification | Interactive browser/PTY checks ran on macOS arm64; production startup and packaged install/update checks also passed on Intel macOS in CI. The embedded shell explicitly rejects Windows. ChatGPT device/browser authentication has mock coverage but no fresh live subscription-account validation in this audit. | Make launch support explicit: macOS verified; Linux requires a clean native run; Windows needs a supported route such as a verified WSL installation. Keep subscription sign-in labeled experimental until a real sign-in, refresh, disconnect, and tool turn are checked. |

These are substantive launch concerns. Missing IDE integration, cosmetic spacing, model naming preferences, and optional advanced features are not blockers in this assessment.

## Verification and limits

- [Release workflow](https://github.com/BerriAI/litespeed/actions/runs/34559346612): both macOS architectures passed fresh `npm ci`, all 1,740 tests, typecheck/build, production TUI startup, and bundled install/update tests before publication.
- The published installer was downloaded without GitHub authentication and run in an isolated macOS arm64 home with no Node/Bun on PATH. The installed CLI reported 0.1.2; the bundled server and web app started, the caller workspace was retained, gateway settings were blank, and memory defaulted on. Temporary processes and installation data were removed afterward.
- `npm run check`: typecheck, full unit/integration suite, and production build passed; 1,740 tests passed, one opt-in runtime test skipped.
- Full Chrome suite: all 141 tests passed. Covers permissions, rejected actions, cancellation, queue/steering, recovery, profiles, MCP lifecycle, browser storage, responsive setup, multiple workers, and session isolation.
- Real PTY interaction suite passed: built-in autocomplete, gateway failure/retry with a masked key, recommended Sidekick setup, saved models, Allow all, live tool output, two workers, two experts, Sidekick handoff, narrow/wide views, and typing with 240 historical messages (about 62 ms in the measured sample).
- Production terminal startup suite passed: bare `litespeed` on PATH, automatic backend startup, caller workspace, suspend/foreground, clean exit, and the backend remaining available.
- Disposable built-backend probes verified exclusive ownership and reproduced the export/import limitation. They used synthetic conversations and a local mock streaming provider, not user credentials or live user state.
- `npm audit`: no high, critical, or moderate advisories; one low-severity development dependency advisory for esbuild's Windows development-server path. No dependency was automatically upgraded as part of the UI request.
- Read-through covered request boundaries, secrets, redirects, retries, unfinished streams, external paths, permissions and remembered grants, hooks/plugins/MCP, parallel worker integration, workspace ownership, transaction/recovery boundaries, queues, client reconciliation, and installation/migration paths. Passing tests and this review are evidence, not a guarantee that no defects remain.

The browser run also found an outdated panel-reload assertion and an assumption that mobile model settings never scroll. Those expectations now match the requested behavior while retaining visible-control checks. The credential failure led to the dialog-focus fix above.
