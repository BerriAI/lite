# Lite

Lite is a local-first coding harness built around **multi-model agents**. Choose how your models work together, give them a task, and review one conversation with shared approvals, changes, verification evidence, and history.

Built for LiteLLM, with OpenAI-compatible gateways, native Anthropic API support, and an explicit ChatGPT subscription connection. Your project stays on your machine; prompts and selected context go to the provider you choose.

## Model arrangements

| Arrangement | How it works |
| --- | --- |
| **Single model** | One model investigates, implements, and checks the work. |
| **Sidekick Fusion** | A strong lead plans and reviews; a cheaper persistent sidekick explores, implements, tests, and repairs across compatible handoffs. |
| **Team Fusion** | A strong lead gives fresh cheaper workers scoped assignments, then verifies the integrated result. Optional parallel workers use separate workspace copies and controlled patch integration. |
| **Expert Fusion** | A cheaper driver coordinates and verifies; a fresh strong expert implements each assignment or repair without inheriting the driver's conversation. |

Assign any connected provider/model to each role. “Strong” and “cheaper” describe the intended arrangement; Lite does not assume a model's quality or guarantee savings. The lead in Team and the driver in Expert delegate source edits automatically; a demonstrated worker failure can trigger an explicit bounded takeover. **Plan mode** stays read-only and optionally uses a separate planner. Bounded read-only research remains available independently of Fusion. File Pipeline and further TUI product work are deferred.

Open the model picker from the composer. Choose one of four architectures from the dropdown, then choose the driver and worker models in their searchable dropdowns (Single model needs only one). The optional Planner model switch uses a separate model in Plan mode. Close the picker and send your task. Lite remembers the most recent model arrangement for each workspace; existing conversations retain their own configuration. Work appears behind one steps disclosure. Worker approvals stay in the main conversation, Stop cancels the task family, and completed responses include recorded changes, checks, and aggregate provider usage. See [architecture behavior and limits](docs/architectures.md).

## Quick start

Node **22.13 or later** and npm are required. Git and Bash are needed for their corresponding tools.

```sh
npm install
cp .env.example .env
# Set your LiteLLM base URL and API key in .env, or connect in Settings.
npm run dev
```

Open **http://localhost:3210**. Pick a workspace in Settings, connect a provider, and choose an arrangement and models from the composer. Build mode asks before editing files or executing commands. Plan mode exposes read-only tools and user questions, not workspace mutations.

For a production build:

```sh
npm run build
npm start
```

## What works

- Streaming conversations, visible reasoning, Markdown/code copying, tool activity, and cancellation.
- Build and read-only Plan modes, explicit tool approvals, remembered per-session tool grants with reset, and opt-in automatic approval.
- Fine-grained permission rules — per-tool allow/ask/deny with bash command-prefix and file-path patterns, app-level and per-project (`.lite/permissions.json`), where an explicit deny outranks every automatic approval. See [permission rules](docs/permissions.md).
- Structured agent questions with deliberate option/custom replies, browser reload recovery, and interactive CLI input—separate from tool approval.
- Bounded transient HTTP retries, repeated-tool-loop detection, advisory request-context estimates, and one-shot proactive/overflow compaction that preserves the latest task and archives older history.
- Free context pruning before paid summarization: stale tool outputs shrink in the outbound request only, while the saved conversation stays complete; truncated tool results keep a hash receipt and can be read back losslessly with `tool_output_page`.
- A real terminal per session: open it from the top bar, hide and reconnect without losing shell state, or explicitly end the shell.
- Workspace file reads, exact edits, writes, glob/regex search, shell execution, public web retrieval, and session todos.
- Background shell jobs: the agent can start a command with `run_in_background`, keep working, poll or stop it, and it learns of finished jobs automatically on your next message — with the same approval rules as any foreground command.
- Mid-response steering: send a short note into a running response with the Steer button; it lands between steps as your latest instruction, auditable in the transcript.
- Loop guards beyond identical-batch blocking: a repeated failing call is refused after three attempts with a change-approach directive, and rounds that produce no new information first draw a nudge, then an honest stop.
- Session goals: set one objective and the agent pursues it across turns, reporting continue/complete/blocked each turn and continuing itself within a turn budget — with a bounded host evaluator when it forgets to report.
- Planner + executor pairing: optionally set a planner model per session — Plan-mode turns think on the big model, Build turns execute on the fast one, while the picker shows the model that will handle the next turn.
- Lifecycle hooks: shell hooks on PreToolUse/PostToolUse/UserPromptSubmit/Stop with an exit-code verdict — a PreToolUse hook can block an approved call; project hooks run only in workspaces you explicitly trust. See [hooks](docs/design-hooks-plugins.md).
- Plugin packages: install a directory of skills, commands, MCP configs, and hooks with `lite plugin install` — dry-run plan first, exact provenance for clean uninstall, plugin MCP servers land disabled, and `.claude-plugin` manifests are read where they map.
- Sidecar extensions: long-lived interceptors that can modify or block tool calls over JSON-RPC — every modification is visibly attributed on the activity card with the original arguments preserved, and a broken sidecar never breaks the loop.
- Usage, doctor, and notifications: a per-day token usage panel and `lite usage`; redacted `lite doctor` diagnostics with a search-index rebuild; and opt-in OS notifications when a long response finishes or needs you.
- Turn receipts: every mutating turn records what changed, what commands ran, and whether checks were run — and says so honestly when files changed with no checks, or after the last check passed.
- Persistent sessions, search, rename/archive/delete, conversation forks, JSON import/export, and manual context compaction with archived original history.
- Cross-session history search — a read-only `history_search` tool over every saved local conversation, with honest zero-result reporting. See [history search](docs/search.md).
- Optional agent memory (off by default) — durable low-authority workspace facts with remember/forget/recall tools, bounded automatic recall, pinned facts that always ride along, subject keys so a new answer replaces the old, and a Settings fact browser. See [agent memory](docs/memory.md).
- Output styles — concise, explanatory, or learning built-ins plus your own `.lite/styles/*.md`, applied per session with the same deliberate config semantics as model changes.
- `view_image` and `web_search` tools — the agent can read workspace images (where the provider route supports them) and run bounded public web searches, both read-only and available to researchers.
- Composer slash commands — type `/` for project command templates (`.lite/commands`, `.claude/commands`) with `$ARGUMENTS` and positional substitution.
- A cache-stable request prefix: volatile facts (date, mode, permission posture, recalled memory) travel in a digest-tagged session-context snapshot instead of rewriting the system prompt every turn.
- Per-turn undo/redo of recorded file edits, supported foreground command changes, conversation and todos, with external-edit conflict checks and explicit interrupted-operation recovery; Git status and file review.
- File/image attachments, workspace file context, model selection, command palette, and local project commands.
- Explicit project profiles and instruction skills, previewed before selection and pinned per session, with tool restrictions and deliberate reloads.
- Explicit MCP connections over local stdio, Streamable HTTP, or legacy SSE; cache-only status, deliberate catalog refresh/reconnect, and per-turn snapshots that refuse changed tool connections.
- A cache-stable connected-tool surface: MCP tools route through one fixed `capability` tool by default, so server changes never reshape the advertised schema — with per-server opt-in to direct advertisement, and approvals always naming the real underlying tool.
- Bounded read-only research tasks: the agent can delegate one foreground researcher with its own live transcript, strict read-only tools, explicit approval, and independent cancellation. See [read-only research tasks](docs/delegation.md).
- LiteLLM/OpenAI-compatible APIs, native Anthropic API keys, and explicit ChatGPT connection where account/provider policies permit it.
- A persistent FIFO follow-up queue with explicit Pause/Resume/remove, plus separate per-session text and attachment drafts.
- CLI task execution against the same running backend, strict option validation, NDJSON events, and remote cancellation on interrupts.

This is an actively developed foundation, not a claim that every feature in every coding product is implemented. See [coverage and limitations](docs/coverage.md) for the tested scope.

## CLI

```sh
node bin/lite.mjs serve --workspace /path/to/project
node bin/lite.mjs run "Explain the architecture" --plan --model your-model-id
node bin/lite.mjs run "Add tests for the parser" --session SESSION_ID
node bin/lite.mjs sessions
node bin/lite.mjs models
node bin/lite.mjs export SESSION_ID > session.json
```

`run` connects to an already running server. Use `--url` to select another local Lite server and `--json` for newline-delimited events. In a noninteractive process, permission requests are denied rather than hanging. `--auto` deliberately allows edits and shell commands for a new session. An existing `--session` keeps its saved model, provider, mode, and permissions; change those in the app rather than passing conflicting flags. Use `--` before a prompt that begins with a dash.

Provider errors produce a nonzero exit status, including with `--json`. Ctrl+C/SIGTERM cancels the remote run and reports the session ID for resuming later. A disconnected event stream reports an error rather than silently replaying a task.

## Follow-ups and drafts

During a response, **Queue** or Enter appends a follow-up; Shift+Enter adds a newline. Queued messages run in order only after an uninterrupted successful response. Stop, provider errors, denied/failed tools, and server restarts hold the remaining queue for explicit **Resume**. **Pause** holds future items without stopping the current response; **Stop** also cancels that response. Remove an item before it starts. Queues are local to each session, limited to 20 items and 16 MiB of serialized content, and file context is snapshotted when queued.

Draft text and attachments stay separate for each session and are saved in this browser when storage allows it. Drafts are not shared across devices or browsers. Large drafts remain in memory with a warning when they exceed the 1 MiB per-draft / 2 MiB total browser-storage budget. File uploads allow up to six files, 3 MiB per file, and 200,000 characters per text file; selected file context sent to the model is bounded separately. An accepted message clears only the draft that was submitted, not newer typing.

## Questions from the agent

When the model needs a decision, **Question from agent** offers choices and a **Custom reply**. Nothing is selected or sent automatically: choose an option or enter text, then **Submit answer**. Answers are part of the current turn, not another user message, and do not grant tool permissions. Questions work in Build and Plan, including with automatic tool approval. You can keep a separate composer draft or queue a follow-up while answering.

Reloading the browser restores a live pending question; an answer from another tab removes the old controls. An accepted answer and its tool result are saved together, and retrying that same answer cannot continue the model twice. **Stop response** cancels an unanswered question and holds queued follow-ups. A server restart interrupts unanswered questions rather than replaying the model; inspect and recover the interrupted history before continuing. Forks, imports, undo, and redo never revive question controls. Questions currently support one selection or one custom reply, not multi-select forms. Answers are sent to the provider—never include credentials.

The CLI prints numbered choices to stderr while continuing to consume live events. Enter a number or custom text; prefix a numeric custom reply with `text:`. With `--json`, stdout remains NDJSON. Noninteractive input cannot answer questions, even with `--auto`: the CLI cancels the run and exits nonzero with instructions to use the app or an interactive terminal. EOF and interrupts also cancel instead of choosing for you.

## Context estimates and compaction

**Session actions → Context details** shows an approximate snapshot taken before its provider request—not a live remaining-token counter or a measurement of your unsent draft. It accounts for outbound text, instructions, and selected tool schemas. Images and opaque provider state are marked uncertain rather than counted by their encoded length.

Set exact model limits under **Settings → provider → Context window overrides** when you know your gateway's capacity. Otherwise Lite uses validated total-context metadata from successful explicit model discovery for up to ten minutes, scoped to that provider configuration. Missing limits remain unknown; model names are never used to guess capacity. Subscription catalogs are not cached because account identity can change independently of provider settings. When a gateway publishes only an input cap (`max_input_tokens`, as LiteLLM does), that cap budgets the input estimate and is labeled as an input limit — it is never presented as a total context window.

Near a known limit, Lite may summarize a safe older prefix once if it would meaningfully reduce the request. The latest user turn and its tool groups remain intact; original history is archived, and recorded undo/redo stays exact. A failed proactive summary leaves the original request intact and falls back to ordinary generation. Proactive compaction and recovery from an explicit provider context rejection share one automatic attempt per turn. Estimates never hard-block a large latest task, but the provider can still reject it. Use a larger-context model or smaller attachments when there is no safe older prefix to compact. Summaries are model-generated, can omit details, and incur a provider request.

## Undo, redo, and recovery

**Session actions → Undo last turn** restores the last accepted user turn, including its conversation, todos, delegated file edits, and supported source changes observed during foreground commands. **Redo** restores the saved state without another model request or tool execution. Your unsent draft stays intact; queued messages remain paused for explicit Resume. A new accepted turn replaces the redo branch, but typing, queued drafts, or rejected submissions do not.

File restoration refuses conflicting external edits. If an operation was only partly applied or the process stopped during a recorded edit, **Recover history** reconciles saved file snapshots before allowing another run. It never replays shell commands or infers that an interrupted tool succeeded. Incomplete provider tool history is archived and replaced with a safe prefix and an explicit recovery notice. Torn writes or files matching neither snapshot require manual repair. Graceful shutdown stops new work and allows up to five seconds for cancellation and bookkeeping; a forced or timed-out exit can still require recovery. Manual compaction archives the old conversation and updates its checkpoint in one SQLite transaction.

Checkpoints retain up to 20 turns and 32 MiB per session. Older checkpoints can expire; oversized turns explicitly report that undo is unavailable. Imports and forks copy conversation only, not ownership of another session’s file changes. Older sessions without checkpoints keep their legacy session-wide recorded-file restoration action. Foreground command history observes bounded UTF-8 source files (up to 2 MiB per file, 12 MiB per observation, and 10,000 entries). Changed binary/large files and incomplete scans produce a specific history notice. Generated/dependency directories, background commands, terminal input, MCP, network, Git metadata, and database effects are outside this file-history guarantee. Commands are never replayed by Undo/Redo.

## Providers and subscriptions

**LiteLLM:** Connect any model or routing alias your proxy exposes. Set `LITELLM_BASE_URL` and `LITELLM_API_KEY` in `.env`, or configure them in Settings. Model discovery uses the provider's actual model endpoint; you can also enter a model ID manually.

**API keys:** OpenAI-compatible providers and native Anthropic are supported. Keys are never returned to the browser. Local credential storage is protected by filesystem permissions; it is not encrypted at rest.

**ChatGPT:** Connection uses an explicit browser/device login. Availability depends on account settings, subscription, and provider policies. This is a compatibility integration, not a promise of provider endorsement or perpetual access. No credentials are imported from another application's storage. Device login may need to be enabled in account/workspace security settings.

**Claude subscriptions:** Third-party subscription login/routing is not supported. Use a native API key or a supported provider through LiteLLM instead.

## Project context

Lite reads `AGENTS.md`, `LITE.md`, and `.lite/instructions.md` in the selected workspace when building the agent's instructions. Keep guidance focused on project conventions and verification commands. Markdown files in `.lite/commands/` and `.claude/commands/` become local slash commands.

Project profiles in `.lite/profiles.json` and instruction skills in `.lite/skills/<id>/SKILL.md` are **explicit opt-in**. Open **Settings → Project profiles** to create or edit profiles, preview instructions, select skills, and review tool restrictions. Saving a profile updates its project definition; choose Use profile to apply it to the session. Recommendations never activate skills automatically. Active instructions stay pinned through source edits, deletion, and restart until deliberately replaced or cleared. Changing a profile preserves your model, mode, and permissions unless you explicitly apply its defaults; queued work stays paused. See the [profile format, CLI examples, and safety boundaries](docs/profiles.md).

MCP server commands are executable configuration. Save and review them in **Settings → Integrations**, then choose **Connect** explicitly. Saving settings, checking status, and sending a model request never connect automatically. Tools use the same approval workflow as other mutable actions, but a pending approval cannot redirect an old tool name to a replacement server. Catalog changes require explicit refresh; interrupted calls are never replayed automatically. Named profiles and Plan mode exclude MCP tools; skills-only selection retains ordinary Build-mode policy. See [MCP connections, limits, and snapshot safety](docs/mcp.md).

## Safety and local data

- The server binds to loopback and rejects foreign Host/Origin and cross-site requests. Do not expose it through a reverse proxy or tunnel without an independent authentication boundary.
- **Permissions are not a sandbox.** Approved shell commands and MCP servers run with your local user's capabilities and may access the network or other files. Opening the terminal explicitly starts your login shell, independent of the agent's Plan mode; terminal input is direct user input, not model-approved execution.
- Terminals currently support macOS/Linux and live only while the server runs. Hidden terminals expire after 30 minutes with no viewers. Reconnection replays up to 256 KiB of output, not a full-screen terminal snapshot. Login profiles can add their own environment variables; the app does not forward its provider credentials.
- Automatic retries happen only for explicit transient HTTP failures, at most twice, before streaming begins. Ambiguous network failures and partial streams are not replayed. Failed attempts may still incur provider charges.
- File tools enforce the workspace's real path, reject symlink escapes and `.git` writes, and guard bounded reads/edits. Discovery skips hidden and generated directories. These checks do not turn shell commands into isolated processes.
- Undo covers recorded file-tool mutations and supported observed foreground-command source changes; it does not reverse arbitrary external side effects. It preflights all targets and rechecks each file immediately before restoration. Conflicts preserve remaining snapshots; completed restorations are recorded separately. It is not a cross-file transaction or protection against arbitrary concurrent external writers.
- Attachments are snapshotted when sent. Imported attachment paths never open local files; missing embedded content must be explicitly reattached. Command files use the same bounded regular-file protections and cannot redirect through symlinks.
- `.env`, `.lite/`, logs, test outputs, and the local work log are ignored by Git. `.lite/` stores the local database and subscription tokens. Session exports may contain source code, paths, and tool output; review before sharing.
- Never paste secrets into prompts or upload secret files. Provider billing applies to real model calls.

## Verification

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

The unit/integration suite uses temporary workspaces and mock provider/MCP servers, including streaming, permissions, cancellation, filesystem boundaries, persistence, and spawned CLI processes. Browser tests run against an isolated fixture server using installed Google Chrome. Real-provider smoke tests are opt-in and require your own configured gateway.

The production entrypoint, CLI server lifecycle, persisted tool workflow, and native PTY have also been exercised on exact Node 22.13.0 (macOS arm64), not merely bundled. Re-run that opt-in compatibility test after building with `LITE_TEST_NODE=/absolute/path/to/node22.13 npm test -- tests/runtime.test.ts`. It copies the built installation into a temporary directory and does not inherit provider credentials. Other runtime/platform combinations need their own validation.
