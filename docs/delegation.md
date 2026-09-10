# Read-only research tasks

A research task lets the main agent delegate a focused question to a separate model conversation. The researcher can inspect the project and return a report while keeping its working transcript out of the parent's main conversation. It does not run a second unrestricted coding agent.

## A complete research workflow

1. Ask the main agent to delegate a specific inspection: for example, find the modules responsible for configuration and summarize their behavior.
2. In ask mode, review the `task` launch request and choose Allow once, Always allow, or Deny. Plan mode does not automatically exempt task launches from approval. Automatic approval or a matching remembered task grant authorizes the launch, not additional researcher tools.
3. The **Research task** card shows the description and status. Choose **Open transcript** to inspect the separate conversation, including actual read/search results and streamed progress.
4. The parent waits for a bounded report before continuing. Its conversation records one task result. **Cancel task** stops that researcher; **Stop generation** stops the parent and its researcher.

Viewing a transcript does not launch, resume, or replay a task. Closing the transcript leaves the research running. You can keep an unrelated composer draft or queue a separate follow-up while it works.

## Restricted authority

Research tasks are available to ordinary sessions and sessions with instruction skills only. Named project profiles do not enable delegation. This restriction is intentional: a named profile's built-in tool allowlist is not silently expanded by adding another agent.

A researcher inherits the accepted parent turn's provider/model, canonical workspace, pinned instruction skills, and project guidance. It receives the explicit task prompt, not an automatic copy of the parent's full conversation, permissions, or provider-specific reasoning state.

Its tool ceiling is `read_file`, `view_image` (attach one workspace image, read-only), `glob`, `grep`, `web_fetch`, `web_search` (public search-result titles and snippets, read-only), `todo_read`, read-only `history_search` over saved local sessions, and `tool_output_page` for reading back its own truncated tool results, intersected with the parent's allowed scope. It cannot write/edit files, run shell commands, update todos, use MCP, ask the user a question, or launch another researcher. An instruction in a file or model response cannot add those tools. Provider credentials remain server-side and are not persisted in the task's linkage or transcript as configuration.

Read-only here describes the available tools, not an operating-system sandbox. Web retrieval still sends network requests. As with any model workflow, review conclusions against the recorded evidence rather than treating a confident report as proof.

## Cancellation and failure

A parent turn can launch at most four researchers, one at a time. At most four researchers run across the app. Each child is limited to 12 model steps and 120 seconds; the parent turn has a shared 24 delegated-step and 300-second research budget. The child's step limit also respects a lower configured session step limit. Prompts are limited to 16 KiB, reports to 32 KiB, and child transcripts to 4 MiB. Exceeded limits produce a visible failure or timeout rather than an unbounded background task. Model steps count logical requests, not each physical retry after an explicit transient provider rejection.

Cancelling the child records its cancelled result once and lets the parent explain the outcome. Queued follow-ups are held for deliberate Resume. Cancelling the parent or shutting down Speedrail aborts the child and waits for its bookkeeping before the parent finishes. Already-sent provider requests may still incur usage; cancellation cannot undo a request already received by a remote service.

A failed task is not silently recreated. Restart interrupts unfinished research rather than replaying it. There is no detached/background resume, nested delegation, or mutable child workspace in this version.

## Transcript and history boundaries

Research transcripts are accessible through their originating parent task. Internal children are hidden from the ordinary session list and cannot be addressed as normal mutable sessions. They have no composer, queue, settings, terminal, or history controls. Knowing a child ID does not authorize its mutation or attach a shell.

Undo/redo restores the parent's exact recorded conversation and task references without rerunning a child. Undo hides references removed from the current parent conversation. Redo can show the same retained research transcript again. Forks, compacted archives, and imports retain inert task text rather than gaining authority to control the original child.

Research tasks do not extend filesystem undo to external services. This implementation deliberately excludes child writes instead of implying that independent mutable child histories can be safely undone as one parent turn.
