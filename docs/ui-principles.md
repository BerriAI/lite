# UI principles

Speedrail should give most of its space and attention to the conversation and the next action.

- Show a state once, where it matters. A running task, approval, or question replaces the generic working indicator. Do not repeat it in the byline, header, and footer.
- Show token totals only after a turn completes. Keep request context estimates out of ordinary messages; expose the latest snapshot in Session actions after completion.
- Prefer compact rows and modest gaps. Add a bordered panel only when it establishes a useful boundary; avoid panels inside panels.
- Keep recovery and errors visible when actionable. Put occasional controls such as undo and redo in Session actions, with explanations at the point of use.
- Keep the composer focused on writing and sending. Avoid permanent instructional footers and labels announcing a default state.
- Make common settings fit a small dialog. Scroll long model or skill lists independently; disclose advanced settings and instruction previews on demand.
- Keep readable type, keyboard navigation, accessible labels, focus indicators, and usable touch targets. Density should come from removing repetition and padding.
- Model reasoning preferences belong to each provider/model pair in the session and should survive switching roles and models. Provider default means no override is sent.

- Show tool calls and reasoning live, anchored to the assistant message that initiated them. Combine consecutive tool-only rounds into one compact block; collapse it when the assistant adds text or finishes. Text and user/system messages are boundaries. Flag issues and modifications in the summary. Give every requested worker or expert a numbered card immediately, including queued calls, with its own assignment, status, and muted italic transcript. Bound worker transcript height so several workers remain visible; follow new activity unless the reader scrolls up.
- Open the workspace panel by default on desktop and remember the reader’s choice. Keep it closed by default on narrow screens.
- Project profiles belong in Settings, never in the composer. Show a single mode control and the main model; keep the sidekick's full configuration in the model picker.
- Do not confuse density with tiny type. Use readable answer text, quiet table rules, and consistent alignment; reserve stronger styling for user actions.

- Configure models in decision order: architecture dropdown with one-line descriptions, searchable dropdowns for the selected roles, then a separate optional Planner model section. Default a fresh workspace to Single model; remember explicit workspace choices.
- Project profiles use the same Settings navigation and form dimensions as other sections, with visible creation/editing controls. Saving a definition and applying it to the current session are separate actions.
- Keep the sidebar short: New session, the session list, and a Settings control in the bottom workspace row. Search stays available through the keyboard palette.
