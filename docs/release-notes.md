# Litespeed 0.1.5

Agent handoffs are easier to follow in the terminal, and verification notes explain what needs attention without a command dump.

- Sidekick has a muted heading above its steps, matching Driver. The name stays visible when its activity is collapsed, and Driver is labeled again when it resumes.
- Parallel workers and experts keep their own numbered headings and independently expandable transcripts.
- Verification notices in both UIs distinguish missing checks, later edits, and earlier attempts without recorded successful reruns. Expand the notice for commands and file details. Historical receipts use the same presentation; saved evidence is preserved.
- Live tools, reasoning, task lists, approvals, and scrolling keep their existing behavior. Real terminal tests cover single Sidekick handoffs, two workers, two experts, and wide and narrow layouts.

Update with `litespeed update`, then reopen the terminal UI. Saved sessions, settings, and keys are preserved.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs. See the [installation guide](https://github.com/BerriAI/litespeed/blob/main/docs/installing.md) and [terminal guide](https://github.com/BerriAI/litespeed/blob/main/docs/tui.md).
