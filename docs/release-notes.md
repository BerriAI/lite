# Litespeed 0.1.9

Cache hit percentages stay visible when a request does not report usage.

- Both UIs calculate cache hit rates from requests that report valid input and cached-token counts. Missing reports are excluded from both the numerator and denominator.
- Combined and per-model summaries keep the available cache percentage after a connection interruption. The usage details retain the count of requests without token reports.
- Existing saved sessions get the corrected display without changing their history or usage records. A reported zero remains 0%; Cache unavailable appears only when there is no usable cache report.

Verified with focused usage tests, desktop and mobile browser workflows with reloads, and a real terminal flow that drops a provider connection after an earlier successful request.

Update with `litespeed update`, then reopen the terminal UI. Saved sessions, settings, and keys are preserved.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs.
