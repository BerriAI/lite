# Terminal interface

Run `lite` in any project directory to open a full-screen client for the same local sessions, providers, Fusion runner, approvals, and history as the web app. There is one terminal implementation, in `tui/`, using OpenTUI and React with the bundled Bun runtime. The server runs on Node.

## Start here

Install the command once from a checkout:

```sh
npm install
npm run build
npm link
```

Then, from any project:

```sh
cd /path/to/project
lite
```

The current directory becomes the workspace. `lite tui` remains an alias. `lite serve` runs the web server separately; you do not need it to use the terminal. Without linking, use `node /path/to/lite/bin/lite.mjs` from your project instead.

Node 22.13 or later is required; npm installs Bun and the native terminal dependencies. Use a UTF-8 terminal, preferably at least 80 columns by 24 rows.

The launcher attaches to the default local server if it is already running. Otherwise it starts one and prints its PID and stop command. **Exiting the TUI leaves that server and its tasks running.** Stop a response before quitting if you want it cancelled. Server output goes to `.lite/tui-server.log` under the installation, or your `LITE_DATA_DIR`.

Explicit connections attach only and never start a replacement server:

```sh
lite --url http://localhost:3210
```

`LITE_URL` and `LITE_PORT` are also supported. Each normal launch creates a new session. Use **Sessions** or `lite --session SESSION_ID` to return to an existing conversation and restore its draft. Existing sessions keep their saved configuration; change it in Models or Settings. `--model`, `--provider`, `--plan`, `--build`, and `--auto` apply to new sessions.

## Your first task

1. Open **Settings → Providers** to connect an API or start ChatGPT device sign-in. Keys are masked. Save the provider and test its connection.
2. Open **Models** from the header or Ctrl+P. Choose Single model, Sidekick Fusion, Team Fusion, or Expert Fusion. Each architecture has a short explanation and only its relevant model roles.
3. Select models using the searchable picker. Reasoning is stored per provider/model. Beneath the divider, optionally enable a separate Planner model for Plan mode. Choose an output style if wanted, then **Save**.
4. Type a task and press Enter. Build asks before changes; Plan uses read-only tools. The header shows the model that will actually handle the next turn, including a separate planner.
5. Review the result through **Response steps**, **Worker assignments**, **Changed files**, and **File history** in Ctrl+P.

Workspace model preferences are shared with the web app. An editor opened before another client changes the session must be reopened before saving, so it cannot silently overwrite newer configuration.

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
| Restore a previous submitted message | `/drafts` |
| Read a long notice in full | `/notice` |
| Scroll / return to latest output | Page Up / Page Down; Ctrl+G |
| Load earlier conversation | Ctrl+Home, or Load earlier messages |
| Copy selection or latest response | Ctrl+Shift+C, or `/copy` |
| Suspend / return | Ctrl+Z, then `fg` in the invoking shell |

Mouse selection, buttons, scrolling, and dialogs are supported. Clipboard copying uses OSC 52 and requires terminal support. Escape closes the current dialog before it can act on the task. Approvals and questions temporarily own input, keeping your draft intact. Ctrl+D exits only when the composer is empty; with text it retains its editing function.

For an approval, press **1 Allow once**, **2 Always**, or **3 Deny**. Ctrl+F opens the full arguments and a file-edit preview where available. A Fusion handoff and a worker's subsequent edit or command are separate decisions in Ask mode. Questions use numbered choices or **0 Custom reply**.

## Conversation and review

Each response has one expandable work log. Tool arguments, output, reasoning, and intercepted-call provenance remain inspectable. Worker views are read-only and scoped to an individual assignment; revisiting an old Sidekick handoff does not append its later work. Sidekick reuses compatible context; Team and Expert use fresh assignment contexts. Final usage includes the task family and distinguishes unreported usage from zero.

`/changes` shows recorded file changes, including worker edits. Wide terminals can show split diffs; narrower terminals use unified diffs. `/history` provides Undo, Redo, recovery details, and protected paths. The server checks external edits before restoring files. Undo/Redo never replay shell commands and do not reverse every external effect; see [history guarantees](../README.md#undo-redo-and-recovery).

Enter during a response queues a follow-up. `/queue` can pause, resume, or remove queued messages. Steering is separate and goes to the driver; it can stop delegated work so the driver can consider the new instruction. Session goals use a configurable turn limit and begin when you send a message. Stop pauses their continuation.

## Drafts and local context

Text and attachments are saved separately for each server/session in `$XDG_STATE_HOME/lite/tui`, defaulting to `~/.local/state/lite/tui`. Drafts are flushed on clean exit, and submitted-input history retains the most recent 200 entries. This cache is private local state; it is separate from browser drafts and server conversation history. A rejected submission retains the draft. Mutations are not automatically replayed after a connection failure.

Workspace references are read by the server when the message is accepted. Local attachments are read by the terminal client. Up to ten attachments are supported, with a 4.4 MB file limit and 200,000-character text limit, subject to the server's aggregate request limits. Use references for workspace files. Bracketed multiline paste stays in the composer until you send it.

`/editor` uses `$VISUAL`, then `$EDITOR`, then `vi`. Saving and leaving the editor returns the text to the composer without submitting it. If the editor fails, Lite preserves the temporary file and reports its path. `/shell` hands the terminal to an interactive shell in the workspace; type `exit` to return. These shell commands are your direct actions and are outside agent file-history tracking.

Project templates in `.lite/commands` and `.claude/commands` appear in Ctrl+P. `/command arguments` expands `$ARGUMENTS` and `$1` through `$9` using the web composer's substitution rules. Built-in terminal commands take precedence on name conflicts; unrecognized slash text is sent literally.

## Settings and appearance

Settings has consistent sections for Providers, General, Permissions, Project profiles, Integrations, and Usage. Profiles can be created, edited, previewed, and applied, including recommended models and skills. MCP configuration is reviewed before an explicit connect or refresh. Usage counts provider-reported tokens; memory is off until enabled.

Put terminal preferences in `~/.config/lite/lite-tui.jsonc`, or your project's `.lite/lite-tui.jsonc`. Configuration follows the selected session's workspace. `LITE_TUI_CONFIG` selects an explicit configuration file; `LITE_DISABLE_PROJECT_CONFIG=1` disables project discovery. The loader supports layered JSONC configuration and custom themes; see `tui/tuiConfig.ts` for precedence.

```jsonc
{
  "theme": "lite",
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
