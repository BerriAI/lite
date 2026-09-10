# UI principles

Lite should give most of its space and attention to the conversation and the next action.

- Show a state once, where it matters. A running task, approval, or question replaces the generic working indicator. Do not repeat it in the byline, header, and footer.
- Show token totals only after a turn completes. Keep request context estimates out of ordinary messages; expose the latest snapshot in Session actions after completion.
- Prefer compact rows and modest gaps. Add a bordered panel only when it establishes a useful boundary; avoid panels inside panels.
- Keep recovery and errors visible when actionable. Put occasional controls such as undo and redo in Session actions, with explanations at the point of use.
- Keep the composer focused on writing and sending. Avoid permanent instructional footers and labels announcing a default state.
- Make common settings fit a small dialog. Scroll long model or skill lists independently; disclose advanced settings and instruction previews on demand.
- Keep readable type, keyboard navigation, accessible labels, focus indicators, and usable touch targets. Density should come from removing repetition and padding.
- Model reasoning preferences belong to each provider/model pair in the session and should survive switching roles and models. Provider default means no override is sent.

- Completed execution belongs behind one response-level steps disclosure. Tool cards, task transcripts, and reasoning should not interrupt the answer by default. Flag tool issues and modifications in the collapsed summary.
- Project profiles belong in Settings, never in the composer. Show a single mode control and the main model; keep the sidekick's full configuration in the model picker.
- Do not confuse density with tiny type. Use readable answer text, quiet table rules, and consistent alignment; reserve stronger styling for user actions.
