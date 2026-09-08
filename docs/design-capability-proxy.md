# Design note: stable tool surface for connected tools

Status: proposed. No code yet.

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
- `{operation: 'call', name, arguments}` → validates arguments against the leased schema, then follows the **existing** approval path (permission scope, remembered grants, and lease `assertCurrent` are unchanged — the gateway is a transport, not an authority change).

Cache effect: connecting, refreshing, or disconnecting servers no longer changes the advertised tool list at all. The lease still freezes which catalog a turn can call; `list` output changes between turns, but that is conversation content, not prefix.

## What this does not change

- Explicit Connect stays. No server process starts because the model called `list`.
- Approval semantics, scopes, and stale-lease refusals are byte-for-byte the same checks, one layer deeper.
- Built-in tool advertisement (including permission-rule hiding) is untouched.

## Open questions

- Should `inspect` results be cached in-conversation (they're content, so yes by default)?
- Naming: `capability` vs `connected_tool` — pick at implementation.
- Migration: sessions with remembered grants for direct `mcp_*` names keep working until their next turn captures the gateway surface; grants map by underlying scope hash, which is name-independent already.
