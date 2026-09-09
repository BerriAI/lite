# Design note: planner + executor model composition

Status: proposed → implementing. This note records the decisions before code.

## Shape

A session may optionally pair two models: a **planner** and an **executor**. The user picks the pair in the session's model selector ("Use a planner"), stored as `Session.planner?: { providerId: string; model: string }`. Everything else about the session — workspace, permissions, rules, profile — is shared; the pair is a model-routing decision, not a second session.

## Routing (deliberately simple)

- **Plan mode turns** run on the planner model when one is set; Build turns run on the executor. That's it — no automatic phase detection, no arbiter, no mid-turn handoff. The user's existing Plan/Build toggle IS the routing control; it already gates tools correctly (Plan = read-only) and its semantics are understood.
- A researcher child inherits the parent turn's captured provider/model exactly as today — one captured pair per accepted turn, no second resolution path — so a researcher launched from a planner-routed Plan turn runs on the planner.
- The context-estimate row and usage already record per-message provider/model, so attribution comes free.

## Why not an in-turn coordinator

The reference-grade alternative (planner and executor arbitrating within one turn, rollback on failed handoffs) buys automation at the cost of a second in-flight authority and a much larger correctness surface (which model's captured policy governs a step? whose cache prefix?). Our captured-at-acceptance policy model assumes one model per accepted turn. Mapping planner→Plan-mode turns keeps that invariant exactly, gets 80% of the value (big model thinks, small model does), and remains honest in the UI: every turn shows which model ran it.

## Capture semantics

`start()` captures the resolved model for THIS turn (planner if plan mode and a planner is set, else the session model) into RunPolicy exactly as today. Cache diagnostics track prefix shape per session; a mode flip changes the model and therefore the prefix — the diagnostics will (correctly, honestly) attribute the miss. Each model keeps its own warm cache when the gateway caches per-model.

## Bounded reviewers (4.2) ride the same decision

The goal-mode evaluator (already implemented as a tool-less, history-less, bounded single request) generalizes into a small `boundedReview(provider, model, system, prompt, timeoutMs)` helper in the providers layer. Reviewers default to the session's planner model when set (a reviewer is a planning-shaped task), else the session model. No tools, no history, hard timeout, failure never breaks the caller.

## UI

Model button shows `executor (+planner)` when a pair is set; the Plan/Build toggle already communicates which brain is engaged. Session settings gains a planner picker (default: none).
