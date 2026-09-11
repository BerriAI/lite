# Litespeed 0.1.0

The first self-contained macOS release supports Apple silicon and Intel Macs. It includes Node, Bun, native terminal dependencies, and the web app. Install once, then run `litespeed` from your project.

- Background update notices in the browser and terminal, plus `litespeed update`.
- Verified downloads and atomic version switching. Restart is blocked while tasks, background jobs, or workspace terminals are active.
- Session data, settings, and keys are stored separately from application versions.
- Long tasks can compact repeatedly without a fixed model-step ceiling. Memory is enabled unless you have turned it off.
- Worker failures include their error details. Model and worker timeouts require ten minutes without progress; approval waits pause the worker timer.

See the [installation and update guide](https://github.com/BerriAI/litespeed/blob/main/docs/installing.md). These are terminal/server packages, not a signed or notarized macOS `.app`. Git and other development tools used by your projects are separate.
