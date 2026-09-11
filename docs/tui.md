# Terminal interface

Run `litespeed` in any project directory to open a full-screen client for the same local sessions, providers, Fusion runner, approvals, and history as the web app. There is one terminal implementation, in `tui/`, using OpenTUI and React with the bundled Bun runtime. The server runs on Node.

## Start here

On macOS with Node 26.4+ and npm, install the command once from a checkout. See the [quick start](../README.md#quick-start) for the full clone command.

```sh
npm ci &&
npm run build &&
npm link
```

Then open Litespeed from the project you want to work on:

```sh
cd /path/to/project
litespeed
```

The current directory becomes the workspace. `litespeed tui` remains an alias. `litespeed serve` runs the web server separately; you do not need it to use the terminal. Without linking, use `node /path/to/litespeed/bin/litespeed.mjs` from your project instead.

There is no separate login command for this coding agent; first-run setup asks for your gateway URL and API key inside the TUI. The [upgrade guide](upgrading.md) covers moving saved state from earlier versions.

Use Node 26.4 or later for the current dependency set; npm installs Bun and the native terminal dependencies. Use a UTF-8 terminal, preferably at least 80 columns by 24 rows. To launch directly from the checkout without linking the command, use `npm run tui` after building.

The launcher attaches to the default local server if it is already running. Otherwise it starts one and prints its PID and stop command. **Exiting the TUI leaves that server and its tasks running.** Stop a response before quitting if you want it cancelled. Server output goes to `.litespeed/tui-server.log` under the installation, or your `LITESPEED_DATA_DIR`.

Explicit connections attach only and never start a replacement server:

```sh
litespeed --url http://localhost:3210
```

`LITESPEED_URL` and `LITESPEED_PORT` are also supported. Each normal launch creates a new session. Use **Sessions** or `litespeed --session SESSION_ID` to return to an existing conversation and restore its draft. Existing sessions keep their saved configuration; change it in Models or Settings. `--model`, `--provider`, `--plan`, `--build`, and `--auto` apply to new sessions.

## Your first task

1. On first launch, enter your LiteLLM gateway URL and API key, then choose your setup and models. Sidekick Fusion is recommended: a powerful driver plus an efficient coding workhorse. Single model is also available. Configured launches open chat directly, including in another project.
2. Type a task and press Enter. Build asks before changes; Plan uses read-only tools. The header shows the model that will handle the next turn.
3. Follow tool activity inline. Each worker has its own label, assignment, live transcript, and Stop control. Click a worker, expert, research, or Sidekick card to reveal its assignment-scoped read-only transcript; click a nested tool row to inspect its arguments and result. Consecutive tools stay open while working and collapse at the next text response. Click any tool row for its result, or use **Alt+O** to show tool details. **Changed files** and **File history** remain in Ctrl+P.

Type `/` for inline command suggestions; use ↑/↓ to choose, Tab or Enter to complete, and Esc to dismiss. Built-in commands, workspace templates, and registered skill IDs appear together.

Use `/models` to change models or add Sidekick, workers, experts, a separate planner, reasoning, or an output style. `/setup` opens the full guided configuration. **Settings → Providers** supports other APIs and ChatGPT device sign-in; keys stay masked.

Your last chosen model setup is shared with the web app and used for new sessions in every workspace. Existing sessions keep their models; permission defaults remain per workspace. An editor opened before another client changes the session must be reopened before saving, so it cannot silently overwrite newer configuration.

Team and Expert default to automatic parallel execution for independent assignments. **Workers at once** can cap concurrency at one to four; choosing **Automatic** removes the cap. The shared runner still enforces its turn budget.

## Keyboard and focus

Ctrl+P is the main navigation surface: search actions or project commands, use ↑/↓, press Enter, and use Escape to return. You can also enter built-in slash commands into an empty composer.

| Action | Default shortcut or command |
| --- | --- |
| Send, or queue during work | Enter |
| New line | Shift+Enter or Ctrl+J |
| Steer a running response with the current draft | Alt+Enter, or Ctrl+P → Send draft as steering |
| Stop the response and its workers | Escape twice |
| Quit while leaving the server available | Ctrl+C twice, or Ctrl+X then Q |
| Models / sessions / new session | Ctrl+X then M / L / N |
| Queue pause, resume, or remove | Ctrl+X then P, or `/queue` |
| External editor / workspace shell | Ctrl+X then E, or `/editor` / `/shell` |
| Review edits / history / worker evidence | `/changes` / `/history` / `/workers` |
| Follow the agent's task list / set a session goal | `/todos` / `/goal` |
| Add workspace context | Type `@filename`, then Tab; or `/files` |
| Attach a local text file or image | `/attach`, or `/attach path/to/file` |
| Browse/select instruction skills / activate one | `/skills` (or `/skill`) / `/<skill-id>` |
| Restore a previous submitted message | `/drafts` |
| Read a long notice in full | `/notice` |
| Scroll / return to latest output | Page Up / Page Down; Ctrl+G |
| Load earlier conversation | Ctrl+Home, or Load earlier messages |
| Copy selection or latest response | ⌘C, Ctrl+Shift+C, or `/copy` |
| Suspend / return | Ctrl+Z, then `fg` in the invoking shell |

Mouse selection, buttons, scrolling, and dialogs are supported. Selecting text copies it when you release the mouse. Local macOS sessions use the system clipboard; remote sessions use OSC 52 where supported. Hold Shift while selecting to use your terminal’s native selection instead. Escape closes the current dialog before it can act on the task. Approvals and questions temporarily own input, keeping your draft intact. Ctrl+D exits only when the composer is empty; with text it retains its editing function.

For an approval, press **1 Allow once**, **2 Always**, or **3 Deny**. Ctrl+F opens the full arguments and a file-edit preview where available. A Fusion handoff and a worker's subsequent edit or command are separate decisions in Ask mode. Questions use numbered choices or **0 Custom reply**.

## Conversation and review

Each response has one expandable work log. Tool arguments, output, reasoning, and intercepted-call provenance remain inspectable. Worker views are read-only and scoped to an individual assignment; revisiting an old Sidekick handoff does not append its later work. Sidekick reuses compatible context; Team and Expert use fresh assignment contexts. Final usage includes the task family and distinguishes unreported usage from zero.

`/changes` shows recorded file changes, including worker edits. Wide terminals can show split diffs; narrower terminals use unified diffs. `/history` provides Undo, Redo, recovery details, and protected paths. The server checks external edits before restoring files. Undo/Redo never replay shell commands and do not reverse every external effect; see [history guarantees](local-data.md#undo-redo-and-recovery).

Enter during a response queues a follow-up. `/queue` can pause, resume, or remove queued messages. Steering is separate and goes to the driver; it can stop delegated work so the driver can consider the new instruction. Session goals use a configurable turn limit and begin when you send a message. Stop pauses their continuation.

## Drafts and local context

Text and attachments are saved separately for each server/session in `$XDG_STATE_HOME/litespeed/tui`, defaulting to `~/.local/state/litespeed/tui`. Drafts are flushed on clean exit, and submitted-input history retains the most recent 200 entries. This cache is private local state; it is separate from browser drafts and server conversation history. A rejected submission retains the draft. Mutations are not automatically replayed after a connection failure.

Workspace references are read by the server when the message is accepted. Local attachments are read by the terminal client. Up to ten attachments are supported, with a 4.4 MB file limit and 200,000-character text limit, subject to the server's aggregate request limits. Use references for workspace files. Bracketed multiline paste stays in the composer until you send it.

`/editor` uses `$VISUAL`, then `$EDITOR`, then `vi`. Saving and leaving the editor returns the text to the composer without submitting it. If the editor fails, Litespeed preserves the temporary file and reports its path. `/shell` hands the terminal to an interactive shell in the workspace; type `exit` to return. These shell commands are your direct actions and are outside agent file-history tracking.

Project templates in `.litespeed/commands` and `.claude/commands` appear in Ctrl+P. `/command arguments` expands `$ARGUMENTS` and `$1` through `$9` using the web composer's substitution rules. Built-in terminal commands take precedence on name conflicts; unrecognized slash text is sent literally.

Use `/skills` (or `/skill`) to select, preview, and apply registered project skills, or `/<skill-id>` alone to activate one without sending a message. Built-ins and project templates win name conflicts. Skills stay pinned for the session; remove them through `/skills`. See [skill definitions and activation](profiles.md#slash-commands-terminal-and-web).

## Settings and appearance

Settings has consistent sections for Providers, General, Permissions, Project profiles, Integrations, and Usage. Profiles can be created, edited, previewed, and applied, including recommended models and skills. MCP configuration is reviewed before an explicit connect or refresh. Usage counts provider-reported tokens; memory is off until enabled.

Put terminal preferences in `~/.config/litespeed/litespeed-tui.jsonc`, or your project's `.litespeed/litespeed-tui.jsonc`. Configuration follows the selected session's workspace. `LITESPEED_TUI_CONFIG` selects an explicit configuration file; `LITESPEED_DISABLE_PROJECT_CONFIG=1` disables project discovery. The loader supports layered JSONC configuration and custom themes; see `tui/tuiConfig.ts` for precedence.

```jsonc
{
  "theme": "litespeed",
  "mouse": true,
  "scroll_speed": 2,
  "diff_style": "auto",
  "prompt": { "max_width": "auto", "max_height": 40 },
  "keybinds": { "leader": "ctrl+x", "model_list": "ctrl+x m" },
  "attention": { "enabled": false }
}
```

`/theme` changes the theme and system/light/dark appearance. Configured prompt dimensions, mouse use, scroll behavior, cursor, active application shortcuts, and editor bindings are wired. Attention currently uses the terminal bell; named sound packs and volume settings are not implemented. The historical keybinding catalog contains additional reserved actions; only the active actions in `tui/commands.ts` and supported editor bindings are registered. Native paste remains terminal-managed.

## Verification and platform scope

```sh
npm run check
npm run test:tui
npm run test:tui:startup
```

The checked-in PTY suite runs the actual terminal against an isolated server and deterministic provider. It exercises all four architectures, Ask decisions, question replies, cancellation, queues, profiles, file context, stale configuration, Plan routing, history, editor/shell handoffs, Unicode paste, session drafts, restart, and 80/100/140-column layouts. Artifacts are written to `test-results-tui/`. The production smoke copies the built application into an isolated installation and checks automatic startup and backend ownership without making provider calls.

This replacement has been exercised on macOS with Node 26 and Bun 1.4.2. Linux terminal-emulator coverage, Windows terminal support, and fresh paid-provider/sign-in smoke tests remain release-matrix follow-ups. The fixture suite tests the real orchestration and permission boundaries, not model quality or provider availability. The old Node renderer and `--legacy` path have been removed.

### Activity and permissions

The header identifies the active driver, Sidekick, or worker count. Handoffs appear where they happened in the conversation. Expand a handoff card to read that invocation’s full transcript and inspect its tool calls in place. Each Sidekick handoff keeps its own transcript even when the model reuses context. Worker transcripts stream live. Old responses do not reparse merely because you type a draft.

Use `/permissions` or the footer to switch between **Ask first** and **Allow all tools**, even during a run. Approval prompts say whether a grant applies to a tool for the session or one external path; `4` selects Allow all tools. Explicit ask/deny rules still apply. `/queue` lets you promote a queued text message to **Steer driver now**.
