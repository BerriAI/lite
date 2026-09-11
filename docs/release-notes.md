# Litespeed 0.1.10

A quieter terminal transcript, clearer current tasks, and fixes for interrupted Sidekick work and long-running commands.

- Sidekick shows one assignment title. Driver labels mark changes of speaker, finished reasoning expands through a muted Thought disclosure, and completed tools no longer add generic issue counts. Full worker transcripts remain available inline.
- The task sidebar shows one current checklist per agent, including a reused Sidekick. Completed items collapse behind their completion count, and wide terminals give tasks more room.
- Queued messages appear above the composer with a Steer now action. The footer explains Enter to queue and Alt+Enter to steer. Notifications stay clear of the input when resizing.
- A Sidekick interrupted by steering can continue using its finished invocation ID. Ordinary task-list updates no longer prompt in Ask first mode; explicit permission rules still apply.
- Blocking polls of a running command no longer trigger the repeated-action guard. Invalid jobs, nonblocking polling loops, and repeated mutations retain protection.

Verified with 1,876 passing tests, typecheck, build, terminal interaction suites, and real Astra/DeepSeek sessions covering Sidekick coding, steering and recovery, parallel workers, Expert permissions, queues, scrolling, and resizing. A real CLI suite completed after eight repeated polls: 125 tests passed and the queued follow-up ran automatically.

Update with `litespeed update`, then reopen the terminal UI. Saved sessions, settings, and keys are preserved.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs.
