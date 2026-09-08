# Lite

A local-first coding workspace. Bring a project, connect your models, and go from an idea to tested code without losing the thread.

Built for LiteLLM, with OpenAI-compatible gateways, native Anthropic API support, and an explicit ChatGPT subscription connection. Your project stays on your machine; prompts and selected context go to the provider you choose.

## Quick start

Node **22.13 or later** and npm are required. Git and Bash are needed for their corresponding tools.

```sh
npm install
cp .env.example .env
# Set your LiteLLM base URL and API key in .env, or connect in Settings.
npm run dev
```

Open **http://localhost:3210**. Choose a model, pick a workspace in Settings, and send a task. Build mode asks before editing files or executing commands. Plan mode exposes only read-only tools.

For a production build:

```sh
npm run build
npm start
```

## What works

- Streaming conversations, visible reasoning, Markdown/code copying, tool activity, and cancellation.
- Build and read-only Plan modes, explicit tool approvals, remembered per-session tool grants with reset, and opt-in automatic approval.
- Bounded transient HTTP retries, repeated-tool-loop detection, and one-shot automatic context-overflow recovery that preserves the latest task and archives older history.
- A real terminal per session: open it from the top bar, hide and reconnect without losing shell state, or explicitly end the shell.
- Workspace file reads, exact edits, writes, glob/regex search, shell execution, public web retrieval, and session todos.
- Persistent sessions, search, rename/archive/delete, conversation forks, JSON import/export, and manual context compaction with archived original history.
- Reversible file-tool changes with external-edit conflict checks; Git status and file review.
- File/image attachments, workspace file context, model selection, command palette, and local project commands.
- MCP tools over local stdio or remote Streamable HTTP, with SSE fallback.
- LiteLLM/OpenAI-compatible APIs, native Anthropic API keys, and explicit ChatGPT connection where account/provider policies permit it.
- CLI task execution against the same running backend.

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

`run` connects to an already running server. Use `--url` to select another local Lite server and `--json` for newline-delimited events. In a noninteractive process, permission requests are denied rather than hanging. `--auto` deliberately allows edits and shell commands for that session.

## Providers and subscriptions

**LiteLLM:** Connect any model or routing alias your proxy exposes. Set `LITELLM_BASE_URL` and `LITELLM_API_KEY` in `.env`, or configure them in Settings. Model discovery uses the provider's actual model endpoint; you can also enter a model ID manually.

**API keys:** OpenAI-compatible providers and native Anthropic are supported. Keys are never returned to the browser. Local credential storage is protected by filesystem permissions; it is not encrypted at rest.

**ChatGPT:** Connection uses an explicit browser/device login. Availability depends on account settings, subscription, and provider policies. This is a compatibility integration, not a promise of provider endorsement or perpetual access. No credentials are imported from another application's storage. Device login may need to be enabled in account/workspace security settings.

**Claude subscriptions:** Third-party subscription login/routing is not supported. Use a native API key or a supported provider through LiteLLM instead.

## Project context

Lite reads `AGENTS.md`, `LITE.md`, and `.lite/instructions.md` in the selected workspace when building the agent's instructions. Keep guidance focused on project conventions and verification commands. Markdown files in `.lite/commands/` and `.claude/commands/` become local slash commands.

Connected MCP server commands are executable configuration. Configure only servers you trust. Tools from connected servers use the same approval workflow as other mutable actions.

## Safety and local data

- The server binds to loopback and rejects foreign Host/Origin and cross-site requests. Do not expose it through a reverse proxy or tunnel without an independent authentication boundary.
- **Permissions are not a sandbox.** Approved shell commands and MCP servers run with your local user's capabilities and may access the network or other files. Opening the terminal explicitly starts your login shell, independent of the agent's Plan mode; terminal input is direct user input, not model-approved execution.
- Terminals currently support macOS/Linux and live only while the server runs. Hidden terminals expire after 30 minutes with no viewers. Reconnection replays up to 256 KiB of output, not a full-screen terminal snapshot. Login profiles can add their own environment variables; the app does not forward its provider credentials.
- Automatic retries happen only for explicit transient HTTP failures, at most twice, before streaming begins. Ambiguous network failures and partial streams are not replayed. Failed attempts may still incur provider charges.
- File tools enforce the workspace's real path, reject symlink escapes and `.git` writes, and guard bounded reads/edits. Discovery skips hidden and generated directories. These checks do not turn shell commands into isolated processes.
- Undo covers recorded file-tool mutations, not arbitrary shell/MCP/network/database side effects. It preflights all targets and rechecks each file immediately before restoration. Conflicts preserve remaining snapshots; completed restorations are recorded separately. It is not a cross-file transaction or protection against arbitrary concurrent external writers.
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

The unit/integration suite uses temporary workspaces and mock provider/MCP servers, including streaming, permissions, cancellation, filesystem boundaries, and persistence. Browser tests run against an isolated fixture server. Real-provider smoke tests are opt-in and require your own configured gateway.
