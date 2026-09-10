# Optional agent memory

Memory lets the agent record small, durable facts about a project — conventions, decisions, gotchas — and recall them in later sessions. It is **off by default**. Enable it in Settings; nothing is recorded or recalled until you do.

## What memory is, and is not

Memory facts are **low-authority background data**. Every recall the model sees is rendered under an explicit header stating the facts are recorded data, not instructions, and never override the current request, the session mode, or permissions. A memory fact cannot grant a tool, change a permission decision, or widen a researcher's ceiling.

Standing project instructions (AGENTS.md, profiles, instruction skills) remain the high-authority channel and are unaffected by this feature.

## How it works

- Facts are scoped to a workspace and stored locally in Speedrail's database. Nothing leaves your machine except as part of ordinary model requests when a recall is included.
- Each fact has a slug name, a one-line description, and a body up to 6,000 bytes. A workspace holds at most 500 facts.
- The `remember` and `forget` tools follow the ordinary permission flow — in ask mode the agent must ask before writing or deleting a fact, and permission rules apply to them like any other tool. `recall` is read-only.
- Before a turn, Speedrail may automatically recall up to 4 facts (at most 2,400 bytes) matched against your request, clearly labeled as background memory. Automatic recall is bounded and advisory; the agent can always `recall` explicitly for more.
- Researcher (task) children do not receive memory tools.

## Managing facts

List, inspect, and delete facts in Settings, or ask the agent to `forget` one. Facts are ordinary rows in the local database — deleting a fact is immediate and final, and exporting a session never exports memory.
