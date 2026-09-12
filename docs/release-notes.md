# Litespeed 0.1.11

Import existing skills and manage queued messages directly from the terminal.

- Import Claude Code and Codex skills from your machine into a project through `/skills` in the terminal or Settings → Project profiles in the web app. Preview the files before importing, then select the skill to activate it. Setup includes an optional import link.
- Press Escape once to interrupt the current response and its workers, then start the oldest queued message after cleanup. Explicitly paused queues stay paused; `/stop` stops work and holds the queue.
- Press Up on the first row of the terminal input to bring queued messages back into your draft for editing, including attachments. Individual messages can also be edited through `/queue`.
- Steering notes use the normal user-message presentation in both interfaces, with their attachments and without internal steering labels.

Update with `litespeed update`, then reopen the terminal UI. Saved sessions, settings, and keys are preserved.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs.
