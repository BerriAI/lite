# Multi-model architectures

Lite's founding opinion is that a coding harness is intrinsically multi-model.
"Which model?" is often the wrong question — the right one is "which
arrangement of models?". A session therefore runs either a single model or a
named **architecture**: a fixed arrangement of cooperating models with defined
roles, picked from the same model picker where you would pick a plain model.

## The registry

`shared/architectures.ts` is the single source of truth. It exports:

- `ArchitectureSelection` — the discriminated union persisted on
  `Session.architecture`. Each architecture is one variant carrying the models
  the user chose for its roles (`{ kind: 'sidekick-fusion', sidekick:
  { providerId, model } }`).
- `ARCHITECTURES` — the display registry (`kind`, `name`, one-line
  `description`, and the `roles` the picker asks the user to fill). Both the
  web picker and the terminal picker render from this list, and the server
  validates selections against the same union.

`Session.architecture` sits beside `planner` and follows the same contract:
nullable, validated on create/PATCH (each role's provider must be connected),
a config change (idle session required, `configRevision` bump), dropped on
import when the named provider does not exist locally.

## Sidekick Fusion

The first architecture: two *parallel, persistent* agents in one session.

- The **main agent** runs on the session's model — typically the frontier
  model you'd pick anyway. It plans, interprets ambiguity, delegates, monitors,
  and does the final review. Under this architecture its system prompt tells it
  to take minimal actions and read only what is strictly necessary: by default
  it hands work to the sidekick and verifies the reports.
- The **sidekick** runs on the model you pick for the role — usually cheaper
  and faster. It is the delegated executor: it explores the codebase, writes
  and edits code, runs commands and tests, and fixes bugs, with the full tool
  set except delegation itself (`task`/`sidekick`), user questions, memory, and
  goal editing.

What makes it Fusion rather than a subagent call: the sidekick is **one
continuous transcript for the whole session**. The main agent's `sidekick`
tool sends each task into the *same* child session, so earlier turns are real
shared context — the sidekick does not re-explore what it already learned, and
its provider-side prompt cache stays warm across tasks. This is deliberately
not the "smart friend" pattern of one-shot advisor queries; both agents keep
their own persistent cached context and work in parallel lanes.

### Trust and permission flow

The sidekick has no authority of its own:

- Every mutating action the sidekick takes (file writes, shell commands) goes
  through the **user's normal permission flow, surfaced in the parent
  session's UI** and labeled as a sidekick request. "Always allow" grants are
  stored under the parent session, so they behave exactly like grants you gave
  the main agent.
- The sidekick's report returns to the main agent prefixed as untrusted data,
  never as user authorization. The main agent is instructed to verify before
  presenting work as done.
- The sidekick cannot delegate further, cannot ask the user questions, and
  children never inherit hooks.

### Budgets and lifecycle

Sidekick limits are wider than researcher (`task`) limits because the sidekick
is the executor, not a scout: per call it may run up to 50 model steps and 10
minutes, and per turn up to 8 launches, 120 cumulative steps, and 30 minutes,
with a 64 KiB report bound and a 16 MiB transcript budget (constants in
`server/runner.ts`).

Lifecycle details:

- One durable sidekick child per session. Each `sidekick` call re-points the
  single delegation record to the new parent turn, appends the new task to the
  child transcript, and settles the record to a terminal status when the call
  ends — so transcripts freeze between turns and undo/redo of the parent stays
  coherent.
- An **interrupted** sidekick (server restart mid-task) is not resumed; the
  next call starts a fresh child. A torn transcript is worse context than an
  empty one.
- Changing the sidekick model in the picker applies on the next call: the
  runner resolves the provider and model from the live selection each launch,
  even though the persisted child session still names the old pair.
- The read-only `task` researcher is unchanged and still available alongside
  the sidekick; the two never count against each other's budgets.

### Cache-aware model switching (future hook)

The Fusion design treats compaction boundaries as the sanctioned point where
the in-charge model could swap "for free" — the transcript is being rewritten
anyway, so no warm cache is sacrificed. In v1 the roles are fixed (main stays
main, sidekick stays sidekick) and compaction of each agent's history happens
independently; the swap policy is a registry-shaped extension point, not a
hard-coded behavior to work around.

## Adding a new architecture

1. Add a variant to `ArchitectureSelection` and an entry to `ARCHITECTURES`
   in `shared/architectures.ts` (kind, name, one-line description, roles).
2. Extend the zod `architectureSchema` in `server/app.ts` so create/PATCH
   validate the new variant and each role's provider.
3. Implement the runtime in `server/runner.ts`: gate any new tools on
   `policy.session.architecture?.kind`, give the arrangement its own limits,
   and route child permissions through the parent as `sidekick()` does.
4. The pickers need no structural work: they render the registry. Add any
   role-specific flow only if the architecture has more than one role.
5. Cover it with a runner integration test (see
   `tests/sidekick-runner.test.ts` for the pattern) asserting tool
   advertisement gating, permission routing, and lifecycle.
