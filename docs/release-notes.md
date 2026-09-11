# Litespeed 0.1.4

The terminal now shows Sidekick and worker activity in the main conversation, with readable approvals and a persistent task list.

- Sidekick, worker, and expert transcripts share the conversation's scroll area. Scroll back while work continues, then use Ctrl+G or Latest to return to live output.
- Tasks stay visible on the right in wide terminals; narrow terminals show the current task below the header. Use `/todos` for the full list.
- One Thinking indicator appears during reasoning. Completed reasoning appears before the response, with an option to expand it.
- Live tool calls appear as they happen. Completed activity can collapse between responses, and task updates display checklists.
- Approval prompts show the action, file, or command in plain text. Allow once, Allow this tool, Deny, and Allow all tools share a row and wrap only when needed. Full arguments and file diffs remain available in Details.
- A successful test retry resolves an earlier failure even if its numeric `tail` output limit changes. Check pipelines preserve the test runner's exit status, and unresolved worker failures name the specific check or action.
- Drivers can request corrections to completed work using `repairOf`. A rejected invocation ID no longer leaves a later successful assignment permanently blocked.
- The release checks now replay a complete Sidekick turn in a real terminal, checking streamed ordering, scrolling, pinned tasks, and approval layout at wide and narrow sizes.

Update with `litespeed update`, then reopen the terminal UI. Saved sessions, settings, and keys are preserved.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs. See the [installation guide](https://github.com/BerriAI/litespeed/blob/main/docs/installing.md) and [terminal guide](https://github.com/BerriAI/litespeed/blob/main/docs/tui.md).
