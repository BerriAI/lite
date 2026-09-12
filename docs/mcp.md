# MCP connections and tool snapshots

MCP connects Litespeed to tools supplied by another process or service. These tools may read or change data outside your project. Configure only commands and endpoints you trust. Tool approval is not a sandbox, and cancellation cannot prove that a remote side effect did not happen.

## Configure, then connect

Open **Settings → Integrations** and edit **MCP servers**. Configuration is a JSON object keyed by a server name:

```json
{
  "local-tools": {
    "command": "/absolute/path/to/mcp-server",
    "args": ["--stdio"],
    "enabled": true
  },
  "remote-tools": {
    "url": "https://your-server.example/mcp",
    "enabled": true
  }
}
```

Use the actual command and arguments from your tool provider. Saving configuration does not start a process, open a network connection, or discover tools. Status reads and model requests do not connect implicitly either.

After saving and reviewing the configuration, choose **Connect** for the server. A successful connection loads its tool catalog. Local servers use stdio; remote servers use Streamable HTTP, with legacy SSE negotiation only when the initial endpoint responds with HTTP 404 or 405. Authentication failures, redirects, and network errors do not trigger fallback. Connecting can itself start trusted executable code or send network requests, before any model tool call.

Changes made in another Settings window cannot be adopted by a status refresh alone. Review the saved configuration explicitly before acting on it. Unsaved MCP JSON must be saved or deliberately discarded before lifecycle actions; status updates do not overwrite the editor or unrelated provider credentials.

## Tool search and TypeScript execution

Connected servers use tool search by default. Their individual schemas stay out of the model's tool array; the agent sees the fixed `capability` interface. No additional switch is needed after connecting a server. A server with `"advertise": true` explicitly opts its tools back into direct advertisement. Plan mode, named profiles, and delegated workers retain their existing MCP restrictions.

The normal workflow is **search → inspect when needed → execute**:

- `{"operation":"search","query":"drive spreadsheet","limit":5}` searches tool and server names and descriptions in the accepted turn's catalog. It returns only matching names, short descriptions, and TypeScript signatures. Search is local, deterministic, and makes no model or server requests. Use `offset` / `nextOffset` to page through matches; the maximum page size is 10.
- `{"operation":"inspect","name":"<exact name from search>"}` returns the input schema and a TypeScript declaration for one tool. Declarations are hints, not runtime validation: unsupported or recursive schema shapes become `unknown`, and the MCP server validates its inputs.
- `{"operation":"execute","code":"<TypeScript async function body>"}` runs code with `tools["<exact name>"](arguments)`. Only the script's return value and `console.log` / `console.error` output reach the model. The script must await all calls.
- `list` and `call` remain available for browsing and simple single-tool operations. Search and execution are also able to use directly advertised tools when the gateway is present.

For example, after discovering a sheet-reading tool, the body of `code` could be:

```typescript
// Replace the name and arguments with the values returned by search/inspect.
const response = await tools["<exact sheet tool name>"]({ sheetId: "abc123" });
const data = response.structuredContent ?? JSON.parse(response.content[0].text);
const rows = data.rows as { id: string; status: string }[];
const pending = rows.filter(row => row.status === "pending");
return { count: pending.length, firstFive: pending.slice(0, 5) };
```

Tool functions return `{ content: [{ type: "text", text: string }], structuredContent?: object }`. Structured content and full text stay available inside the script up to the 2 MiB response limit. Media and resource bodies remain omitted, and configured credentials and control characters are removed as on the direct path. Unlike model-facing text previews, oversized code responses fail rather than silently truncating data that a later tool might write.

Each invocation gets a fresh QuickJS WebAssembly runtime in a disposable worker. TypeScript is transpiled before running; imports, Node APIs, filesystem access, environment variables, network APIs, and timers are unavailable in the guest. Its only external operations are the connected MCP tool functions. It supports loops, conditionals, filtering, joins, and `Promise.all`, with at most four calls dispatched concurrently.

Limits per script are 64 KiB of source, 50 MCP calls, 1 MiB of arguments per call, 64 MiB of guest memory, two seconds of JavaScript CPU, and 120 seconds of wall time (including tool and approval waits). Returned/logged output is capped at 16 KiB with an explicit truncation notice. For longer tasks, return a small checkpoint and continue in another invocation; the sandbox does not retain state.

Each inner call uses the same frozen tool identity, permission scope, remembered grant, and pre-dispatch catalog checks as a direct MCP call. The user approves the actual tool name and its arguments, never a blanket permission for the script. PreToolUse and PostToolUse hooks run for inner calls as well as the outer capability operation. A denial, failed tool request, stale catalog, or cancellation stops the whole script and cancels outstanding calls. Effects already sent to servers may have completed: scripts are not transactions, and nothing is automatically rolled back or retried.

The tool detail view records each inner tool's name, status, timestamps, and input/output byte counts. Bulk arguments and intermediate results are not copied into model history or these audit records. Explicitly configured hooks can still see call arguments and bounded results. Search reduces schema overhead; code reduces intermediate-data and orchestration overhead. Actual token savings depend on the workflow and are not a fixed percentage.

Run `npm run test:mcp:code` for the built-runtime smoke check. It uses a real local stdio MCP server and a local provider stub, discovers two tools, approves each call, and transfers a 520 KB document while verifying that no intermediate document content enters the model requests. It needs no provider credentials and does not measure provider token costs.

## Status and explicit actions

- **Disconnected:** configured but not connected, or the connection closed. Use Connect or Reconnect deliberately.
- **Connecting / refreshing:** a lifecycle operation is in progress. It does not make partially discovered tools available.
- **Connected:** the current catalog is available to a new eligible turn.
- **Stale:** the server announced a changed tool list. Use **Refresh tools** to review and adopt the new catalog for future turns. Notifications do not automatically refresh it.
- **Error:** discovery or connection failed. Inspect the safe error and retry explicitly after addressing the cause.
- **Disabled:** no tools are available. Enable and save the server configuration before connecting.

**Refresh status** only observes local cached state. **Refresh tools** requests a complete catalog from the existing connection. **Reconnect** closes the previous connection, creates a new one, and discovers its catalog. Neither action replays an earlier model request or tool call. Disable or remove a server in saved configuration to close it.

## A turn keeps the tool identity it saw

At acceptance, a Build-mode turn captures a read-only snapshot of available MCP definitions and their original connections. Plan mode and named project profiles do not capture or advertise MCP tools. Selecting instruction skills alone retains ordinary Build-mode tool policy.

A tool call cannot be redirected to a replacement server merely because it has the same name. Changing configuration, disconnecting, reconnecting, starting a refresh, or receiving a tool-list-change notification invalidates the old snapshot. Litespeed checks it before approval and immediately before dispatch. Stale calls fail without using a replacement connection; review the change and start a new turn when ready.

Remembered approvals bind the workspace, server configuration, and advertised catalog identity. Changing those invalidates the approval. Reconnecting with identical configuration and catalog can retain the remembered permission, but never revives an old turn's connection snapshot. Auto approval does not bypass stale-snapshot checks.

A call already sent may have changed remote data even if its response is lost, cancelled, or interrupted by a connection change. Litespeed does not automatically repeat such calls. Undo/redo restores recorded conversation state, not external effects, and does not call the server again.

## Bounds and lifecycle

Catalog discovery is bounded: up to 20 pages, 1,000 tools, and 1 MiB of validated tool catalog data per server. Duplicate names, malformed schemas, repeated cursors, or exceeded limits reject the catalog rather than silently truncating it. A connection/catalog operation has a total deadline of 30 seconds and individual discovery requests are limited to 15 seconds. Tool calls have a 60-second deadline. Direct calls return at most 100,000 bytes of text; code execution retains up to 2 MiB of sanitized data in its sandbox before the smaller final-output cap. Non-text resource/media bodies are omitted. Individual protocol frames are limited to 2 MiB before parsing. At most eight lifecycle operations run concurrently, with one per server and at most 30 configured servers.

A disconnected lifecycle HTTP request or app shutdown cancels its preparation. A late result cannot publish a catalog after cancellation or replace a newer configuration. Shutdown closes connections and waits for tracked lifecycle cleanup. New server processes require an explicit connection after restarting Litespeed.

## Current scope

Supported workflows are explicit stdio/Streamable HTTP/legacy SSE tool connection, discovery, tool search, TypeScript execution, approval, dispatch, cancellation, status, refresh, and reconnect. MCP OAuth login, resources, prompts, and automatic reconnection are not part of this version. Provider API keys are not forwarded to local MCP subprocesses by the app; configure only the environment entries the tool needs and never place secrets in prompts or share unreviewed configuration exports.
