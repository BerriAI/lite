# Permissions, local data, and recovery

## Undo, redo, and recovery

**Session actions → Undo last turn** restores the last accepted user turn, including its conversation, todos, delegated workspace file edits, and supported source changes observed during foreground commands. In the terminal, use `/history`, `/undo`, or `/redo`. **Redo** restores the saved state without another model request or tool execution. Your unsent draft stays intact; queued messages remain paused for explicit Resume. A new accepted turn replaces the redo branch, but typing, queued drafts, or rejected submissions do not.

File restoration refuses conflicting external edits. If an operation was only partly applied or the process stopped during a recorded edit, **Recover history** reconciles saved file snapshots before allowing another run. It never replays shell commands or infers that an interrupted tool succeeded. Incomplete provider tool history is archived and replaced with a safe prefix and an explicit recovery notice. Torn writes or files matching neither snapshot require manual repair. Graceful shutdown stops new work and allows up to five seconds for cancellation and bookkeeping; a forced or timed-out exit can still require recovery. Manual compaction archives the old conversation and updates its checkpoint in one SQLite transaction.

Checkpoints retain up to 20 turns and 32 MiB per session. Older checkpoints can expire; oversized turns explicitly report that undo is unavailable. Imports and forks copy conversation only, not ownership of another session’s file changes. Older sessions without checkpoints keep their legacy session-wide recorded-file restoration action. Foreground command history observes bounded UTF-8 source files (up to 2 MiB per file, 12 MiB per observation, and 10,000 entries). Changed binary/large files and incomplete scans produce a specific history notice. Generated/dependency directories, background commands, terminal input, MCP, network, Git metadata, and database effects are outside this file-history guarantee. Commands are never replayed by Undo/Redo.

## Export limits

A session export is a conversation copy, not a complete backup of your installation. It does not preserve worker transcripts, file checkpoints, provider configuration, or saved keys. The current importer accepts request bodies up to 12 MiB, at most 10,000 messages, and 500,000 characters per message; an exported session can exceed those limits. Keep the original local data until you have verified that an export imports successfully. For a full local backup, stop the server and copy its entire data directory together with the workspace files.

## Safety and local data

- The server binds to loopback and rejects foreign Host/Origin and cross-site requests. Do not expose it through a reverse proxy or tunnel without an independent authentication boundary.
- **Permissions are not a sandbox.** Approved shell commands and MCP servers run with your local user's capabilities and may access the network or other files. Opening the terminal explicitly starts your login shell, independent of the agent's Plan mode; terminal input is direct user input, not model-approved execution.
- The web app's embedded shell terminals support macOS/Linux and live only while the server runs. Hidden terminals expire after 30 minutes with no viewers. Reconnection replays up to 256 KiB of output, not a full-screen terminal snapshot. Login profiles can add their own environment variables; the app does not forward its provider credentials. The full-screen `litespeed` client has separate [terminal lifecycle and platform notes](tui.md).
- Automatic retries happen only for explicit transient HTTP failures, at most twice, before streaming begins. Ambiguous network failures and partial streams are not replayed. Failed attempts may still incur provider charges.
- File tools resolve actual paths before approval. Outside-workspace targets require approval in Ask mode; Auto or an allow rule can approve them. Remembered external grants bind to the tool and resolved path. Credential protections and `.git` write restrictions still apply, and external edits are outside workspace Undo. Discovery skips hidden and generated directories. These checks do not turn shell commands into isolated processes.
- Undo covers recorded file-tool mutations and supported observed foreground-command source changes; it does not reverse arbitrary external side effects. It preflights all targets and rechecks each file immediately before restoration. Conflicts preserve remaining snapshots; completed restorations are recorded separately. It is not a cross-file transaction or protection against arbitrary concurrent external writers.
- Attachments are snapshotted when sent. Imported attachment paths never open local files; missing embedded content must be explicitly reattached. Command files use the same bounded regular-file protections and cannot redirect through symlinks.
- `.env`, `.litespeed/`, logs, test outputs, and the local work log are ignored by Git. `.litespeed/` stores the local database and subscription tokens. Session exports may contain source code, paths, and tool output; review before sharing.
- Never paste secrets into prompts or upload secret files. Provider billing applies to real model calls.

[Back to Litespeed](../README.md)
