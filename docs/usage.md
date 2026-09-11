# Using Speedrail

This guide covers the web app. The [terminal guide](tui.md) documents terminal controls and client-specific draft storage. Both clients share sessions, models, permissions, and the agent runner.

## While Speedrail works

Tool calls appear live beside the assistant text that introduced them. Consecutive tool-only steps collapse when the assistant adds text or finishes. Fusion workers have numbered cards with their assignments, progress, and transcripts. Approvals and questions stay in the main conversation.

Use **Steer** to change direction during a response. The note goes to the driver and stops active delegated work so it can apply the new instruction. **Queue** saves a separate follow-up turn. **Stop** cancels the active response and its workers.

Session goals let Speedrail continue an objective across turns within a configured turn limit. Stop pauses continuation. Completed responses report recorded file changes, checks, and provider usage; expand the steps and review changed files to inspect the evidence. [Undo/redo and recovery](local-data.md) explain which changes can be restored.

## Follow-ups and drafts

During a response, **Queue** or Enter appends a follow-up; Shift+Enter adds a newline. Queued messages run in order only after an uninterrupted successful response. Stop, provider errors, denied/failed tools, and server restarts hold the remaining queue for explicit **Resume**. **Pause** holds future items without stopping the current response; **Stop** also cancels that response. Remove an item before it starts, or use **Steer now** during a response to send that queued message and its saved attachments to the driver immediately. Queues are local to each session, limited to 20 items and 16 MiB of serialized content, and file context is snapshotted when queued.

Draft text and attachments stay separate for each session and are saved in this browser when storage allows it. Drafts are not shared across devices or browsers. Large drafts remain in memory with a warning when they exceed the 1 MiB per-draft / 2 MiB total browser-storage budget. File uploads allow up to six files, 3 MiB per file, and 200,000 characters per text file; selected file context sent to the model is bounded separately. An accepted message clears only the draft that was submitted, not newer typing.

## Questions from the agent

When the model needs a decision, **Question from agent** offers choices and a **Custom reply**. Nothing is selected or sent automatically: choose an option or enter text, then **Submit answer**. Answers are part of the current turn, not another user message, and do not grant tool permissions. Questions work in Build and Plan, including with automatic tool approval. You can keep a separate composer draft or queue a follow-up while answering.

Reloading the browser restores a live pending question; an answer from another tab removes the old controls. An accepted answer and its tool result are saved together, and retrying that same answer cannot continue the model twice. **Stop response** cancels an unanswered question and holds queued follow-ups. A server restart interrupts unanswered questions rather than replaying the model; inspect and recover the interrupted history before continuing. Forks, imports, undo, and redo never revive question controls. Questions currently support one selection or one custom reply, not multi-select forms. Answers are sent to the provider—never include credentials.

The CLI prints numbered choices to stderr while continuing to consume live events. Enter a number or custom text; prefix a numeric custom reply with `text:`. With `--json`, stdout remains NDJSON. Noninteractive input cannot answer questions, even with `--auto`: the CLI cancels the run and exits nonzero with instructions to use the app or an interactive terminal. EOF and interrupts also cancel instead of choosing for you.

## Context estimates and compaction

**Session actions → Context details** shows an approximate snapshot taken before its provider request—not a live remaining-token counter or a measurement of your unsent draft. It accounts for outbound text, instructions, and selected tool schemas. Images and opaque provider state are marked uncertain rather than counted by their encoded length.

Set exact model limits under **Settings → provider → Context window overrides** when you know your gateway's capacity. Otherwise Speedrail uses validated total-context metadata from successful explicit model discovery for up to ten minutes, scoped to that provider configuration. Missing limits remain unknown; model names are never used to guess capacity. Subscription catalogs are not cached because account identity can change independently of provider settings. When a gateway publishes only an input cap (`max_input_tokens`, as LiteLLM does), that cap budgets the input estimate and is labeled as an input limit — it is never presented as a total context window.

Speedrail compacts automatically as context approaches the model window, reserving room for output. If the gateway has not reported a limit, it uses a labeled 200,000-token planning window; configure the exact model limit for smaller or larger models. It uses provider-reported input usage to correct subsequent text estimates when the request configuration and history revision still match.

Compaction can happen repeatedly within one long task. It preserves the latest user request, steering, and recent complete tool groups, summarizes earlier work, and archives the original history. Old tool results are pruned in the request first when that makes enough room. Compaction failures preserve the original history; consecutive retries cannot create an endless summary loop. A single oversized prompt, attachment, or tool group may still need a narrower read or a larger model. Summaries incur provider usage and can omit details.

Driver and worker turns have no fixed model-step ceiling. Stop, explicit permission rules, repeated-failure guards, worker time budgets, and provider limits still apply. Memory is on by default: the agent can save local workspace notes automatically, and you can review, delete, or disable them in Settings. Explicit Ask and Deny rules for memory tools take precedence.

Every gateway request carries the root session ID in `x-litellm-session-id`, including worker, summary, and review calls. LiteLLM can group their spend across turns. Compaction keeps that ID; a new or forked session gets its own. Local usage records remain separate from conversation history. See [Context management and harness comparison](context-management.md) for verified defaults and differences.

## Project context

Speedrail reads `AGENTS.md`, `SPEEDRAIL.md`, and `.speedrail/instructions.md` in the selected workspace when building the agent's instructions. Keep guidance focused on project conventions and verification commands. Markdown files in `.speedrail/commands/` and `.claude/commands/` become local slash commands.

Project profiles in `.speedrail/profiles.json` and instruction skills in `.speedrail/skills/<id>/SKILL.md` are **explicit opt-in**. Open **Settings → Project profiles** to create or edit profiles, preview instructions, select skills, and review tool restrictions. Saving a profile updates its project definition; choose Use profile to apply it to the session. Recommendations never activate skills automatically. Active instructions stay pinned through source edits, deletion, and restart until deliberately replaced or cleared. Changing a profile preserves your model, mode, and permissions unless you explicitly apply its defaults; queued work stays paused. See the [profile format, CLI examples, and safety boundaries](profiles.md).

MCP server commands are executable configuration. Save and review them in **Settings → Integrations**, then choose **Connect** explicitly. Saving settings, checking status, and sending a model request never connect automatically. Tools use the same approval workflow as other mutable actions, but a pending approval cannot redirect an old tool name to a replacement server. Catalog changes require explicit refresh; interrupted calls are never replayed automatically. Named profiles and Plan mode exclude MCP tools; skills-only selection retains ordinary Build-mode policy. See [MCP connections, limits, and snapshot safety](mcp.md).

[Back to Speedrail](../README.md)
