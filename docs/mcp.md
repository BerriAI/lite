# MCP connections and tool snapshots

MCP connects Speedrail to tools supplied by another process or service. These tools may read or change data outside your project. Configure only commands and endpoints you trust. Tool approval is not a sandbox, and cancellation cannot prove that a remote side effect did not happen.

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

A tool call cannot be redirected to a replacement server merely because it has the same name. Changing configuration, disconnecting, reconnecting, starting a refresh, or receiving a tool-list-change notification invalidates the old snapshot. Speedrail checks it before approval and immediately before dispatch. Stale calls fail without using a replacement connection; review the change and start a new turn when ready.

Remembered approvals bind the workspace, server configuration, and advertised catalog identity. Changing those invalidates the approval. Reconnecting with identical configuration and catalog can retain the remembered permission, but never revives an old turn's connection snapshot. Auto approval does not bypass stale-snapshot checks.

A call already sent may have changed remote data even if its response is lost, cancelled, or interrupted by a connection change. Speedrail does not automatically repeat such calls. Undo/redo restores recorded conversation state, not external effects, and does not call the server again.

## Bounds and lifecycle

Catalog discovery is bounded: up to 20 pages, 1,000 tools, and 1 MiB of validated tool catalog data per server. Duplicate names, malformed schemas, repeated cursors, or exceeded limits reject the catalog rather than silently truncating it. A connection/catalog operation has a total deadline of 30 seconds and individual discovery requests are limited to 15 seconds. Tool calls have a 60-second deadline and return at most 60,000 bytes of text; non-text resource/media bodies are omitted. Individual protocol frames are limited to 2 MiB before parsing. At most eight lifecycle operations run concurrently, with one per server and at most 30 configured servers.

A disconnected lifecycle HTTP request or app shutdown cancels its preparation. A late result cannot publish a catalog after cancellation or replace a newer configuration. Shutdown closes connections and waits for tracked lifecycle cleanup. New server processes require an explicit connection after restarting Speedrail.

## Current scope

Supported workflows are explicit stdio/Streamable HTTP/legacy SSE tool connection, discovery, approval, dispatch, cancellation, status, refresh, and reconnect. MCP OAuth login, resources, prompts, and automatic reconnection are not part of this version. Provider API keys are not forwarded to local MCP subprocesses by the app; configure only the environment entries the tool needs and never place secrets in prompts or share unreviewed configuration exports.
