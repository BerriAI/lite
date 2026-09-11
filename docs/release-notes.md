# Litespeed 0.1.3

The installer now sets up the `litespeed` command in zsh and Bash. After installing, open a new terminal and run `litespeed` from your project. Existing shell settings are preserved.

- Optional Shunt uses a separately selected model for large reads and routine generation across all model architectures. Enable it in Advanced settings during setup or in Models; it is off by default.
- Model choices persist across new sessions and workspaces, including the driver, workers, planner, and Shunt model.
- Select text to copy automatically in the terminal and browser. The terminal also supports Cmd+C and Ctrl+Shift+C for selections.
- Inspect delegated transcripts inline in the terminal, with clearer tool details and Shunt activity.
- Clearer installation instructions explain when to open a new terminal and how to make the command available in the existing one.

Packages include Node, Bun, native terminal dependencies, and the web app for Apple silicon and Intel Macs. Updates preserve saved sessions, settings, and keys.

Install or rerun the [installer](https://github.com/BerriAI/litespeed/releases/latest/download/install.sh) to configure the shell command. Existing installations can also update with `litespeed update`.

See the [installation and update guide](https://github.com/BerriAI/litespeed/blob/main/docs/installing.md) and [Shunt guide](https://github.com/BerriAI/litespeed/blob/main/docs/shunt.md).
