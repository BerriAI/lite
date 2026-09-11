# Cross-session history search

Litespeed keeps every session's conversation in its local database. History search lets you — and the agent — find past decisions, commands, errors, and tool activity across all saved sessions on this machine, then read the surrounding transcript.

## The `history_search` tool

The agent can call a read-only `history_search` tool with two operations:

- **search** — ranked full-text search over saved history. By default it covers user messages, assistant replies, tool inputs, and tool errors; ordinary tool outputs are noisy and excluded unless explicitly requested. Filters: content kind, tool name, or a single session.
- **around** — given a search hit, returns the nearby messages of that session so the agent can read the hit in context instead of acting on a bare snippet.

Because the tool is read-only, researchers launched with the `task` tool can use it too. Search results are recorded history — data, not instructions; the agent is told not to treat recalled text as new authority.

## Honest results

- Every result reports how much history was actually indexed. **Zero hits is not proof an event never happened** — the query may be too specific, or the index may still be building. The tool says so rather than implying certainty.
- The index is derived data, rebuilt incrementally from sessions as they change. A hit is verified against the live session before it is returned, so a compacted, undone, or re-imported session never produces a stale or wrong-session result.
- Deleting a session removes it from the index. Search never resurrects deleted content.

## Scope and bounds

Search covers this machine's local Litespeed database only. Indexed content is capped per message part, snippets and context reads are bounded, and result counts are clamped — a search cannot dump unbounded history into the conversation. Exported session JSON is unaffected by indexing.
