# Design note: stable tool surface for connected tools

Status: implemented. The hybrid gateway now includes tool search and isolated TypeScript execution; see [MCP integration](mcp.md#tool-search-and-typescript-execution).

## Problem

Every tool advertised to the model costs schema bytes in the cached request prefix, and any change to the advertised list invalidates the provider's prompt cache for the whole conversation tail. Built-in tools are stable, but connected (MCP) servers are not: a browser-automation server exposes ~20 tools, a reconnect or refresh changes the catalog, and today each change reshapes the tools array — a guaranteed cache miss and a permanent per-turn schema tax even when the tools go unused.

## Options considered

1. **Advertise everything (today).** Simple; every connected tool is directly callable. Cost: schema bytes scale with catalog size, and catalog changes churn the prefix.
2. **One fixed-schema gateway tool** for all connected tools (`capability` with `list`/`inspect`/`call` operations). The tools array never changes shape when servers connect, refresh, or grow. Cost: one indirection hop (the model must `list` before first `call`), and per-tool argument schemas are validated by us at `call` time instead of by the provider at decode time.
3. **Hybrid (proposed).** Built-ins stay directly advertised (stable, small, hand-written schemas). Connected tools route through the gateway. A per-server setting `advertise: true` opts a trusted, frequently-used server's tools back into direct advertisement for users who prefer decode-time schemas over cache stability.

## Proposal

Option 3. The gateway tool:

- `{operation: 'list'}` → bounded catalog (names + one-line descriptions) from the **frozen per-turn lease** — never live discovery.
- `{operation: 'inspect', name}` → full argument schema for one tool.
- `{operation: 'call', name, arguments}` → accepts a JSON argument object (validated by the MCP server), then follows the **existing** approval path (permission scope, remembered grants, and lease `assertCurrent` are unchanged — the gateway is a transport, not an authority change).
- `{operation: 'search', query, limit?, offset?}` → ranked matching tool names, descriptions, and TypeScript signatures from the frozen lease. The model is instructed to start here by default.
- `{operation: 'execute', code}` → TypeScript orchestration in QuickJS/WASM with a JSON-only host bridge. Inner calls reuse the real tool's approval and lease checks, and intermediate data stays outside model history.

Cache effect: while at least one gateway tool is available, catalog changes leave the gateway schema unchanged. Search/list results change as conversation content rather than prefix bytes. Connecting the first gateway server or disconnecting the last changes whether the gateway is present; tools explicitly configured with `advertise: true` still change the advertised tool array. The lease freezes which catalog each accepted turn can call.

## What this does not change

- Explicit Connect stays. No server process starts because the model called `list`.
- Approval semantics, scopes, and stale-lease refusals are byte-for-byte the same checks, one layer deeper.
- Built-in tool advertisement (including permission-rule hiding) is untouched.

## Open questions

- Should `inspect` results be cached in-conversation (they're content, so yes by default)?
- Naming: `capability` vs `connected_tool` — pick at implementation.
- Migration: sessions with remembered grants for direct `mcp_*` names keep working until their next turn captures the gateway surface; grants map by underlying scope hash, which is name-independent already.
