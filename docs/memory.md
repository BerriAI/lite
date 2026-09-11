# Optional agent memory

Memory lets the agent record small, durable facts about a project — conventions, decisions, gotchas — and recall them in later sessions. It is **on by default**. The agent can record and recall local notes automatically. Turn it off in Settings to stop both, or add explicit Ask/Deny rules for memory tools. An existing choice to disable memory is preserved.

## What memory is, and is not

Memory facts are **low-authority background data**. Every recall the model sees is rendered under an explicit header stating the facts are recorded data, not instructions, and never override the current request, the session mode, or permissions. A memory fact cannot grant a tool, change a permission decision, or widen a researcher's ceiling.

Standing project instructions (AGENTS.md, profiles, instruction skills) remain the high-authority channel and are unaffected by this feature.

## How it works

- Facts are scoped to a workspace and stored locally in Litespeed's database. Nothing leaves your machine except as part of ordinary model requests when a recall is included.
- Each fact has a slug name, a one-line description, and a body up to 6,000 bytes. A workspace holds at most 500 facts.
- The `memory_remember` and `memory_forget` tools run automatically when memory is enabled in Build mode. Explicit Ask/Deny rules override that default; Plan mode cannot write facts. `memory_recall` is read-only.
- Before a turn, Litespeed may automatically recall up to 4 facts (at most 2,400 bytes) matched against your request, clearly labeled as background memory. Automatic recall is bounded and advisory; the agent can always `recall` explicitly for more.
- Researcher (task) children do not receive memory tools.

## Managing facts

List, inspect, and delete facts in Settings, or ask the agent to `forget` one. Facts are ordinary rows in the local database — deleting a fact is immediate and final, and exporting a session never exports memory.
