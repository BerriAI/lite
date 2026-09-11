# Litespeed 0.1.7

Long tasks keep going, and a failing check no longer makes a completed Sidekick look like a failed model invocation.

- `/goal` has no turn limit by default in either UI. A positive turn limit is optional; existing saved limits are preserved.
- Slow shell commands continue as jobs after the foreground wait instead of being killed. Actual process exits, including background completion, determine check results. Numeric `tail` filters cannot mask failed test pipelines.
- A Sidekick, worker, or expert that finishes with unresolved checks shows **Completed · Needs review**. Agent failures still show the actual error.
- Removed the confusing “earlier attempts” warning. Unresolved checks have one **Checks need attention** row with the affected commands, including when viewing older sessions.
- Compaction retries empty or reasoning-only summaries, can fall back from a worker to its driver model, and can retry later in the same turn. Original history and Undo are retained; running command receipts settle before archiving.
- Guided terminal setup starts with the architecture, then connects the gateway and explains model roles. Gateways without API keys work too.
- `/new`, `/clear`, and `/reset` start a fresh terminal conversation while keeping the previous session and draft.

Validation includes real gateway compaction on/off comparisons across all four architectures, a Sidekick file-editing and test-running comparison, browser workflows, and real terminal input/rendering tests. The live compaction fixtures preserve four exact decisions from older history; they do not establish lossless summaries for every task.

Update with `litespeed update`, then reopen the terminal UI. Saved sessions, settings, and keys are preserved.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs. See the [installation guide](https://github.com/BerriAI/litespeed/blob/main/docs/installing.md) and [terminal guide](https://github.com/BerriAI/litespeed/blob/main/docs/tui.md).
