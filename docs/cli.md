# Command-line reference

Run `lite` in a project directory for interactive terminal chat. See the [installation instructions](../README.md#quick-start) and [terminal guide](tui.md). The commands below are for scripting and server management.

## Run a task

`lite run` uses the same backend as the interactive clients. If it is not running yet, start `lite serve` in a separate terminal. Run task commands from the project directory you want to work in.

```sh
lite run "Explain the architecture" --plan --model your-model-id
lite run "Add tests for the parser" --session SESSION_ID
lite sessions
lite models
lite export SESSION_ID > session.json
```

`run` connects to an already running server. Use `--url` to select another local Lite server and `--json` for newline-delimited events. In a noninteractive process, permission requests are denied rather than hanging. `--auto` deliberately allows edits and shell commands for a new session. An existing `--session` keeps its saved model, provider, mode, and permissions; change those in the app rather than passing conflicting flags. Use `--` before a prompt that begins with a dash.

Provider errors produce a nonzero exit status, including with `--json`. Ctrl+C/SIGTERM cancels the remote run and reports the session ID for resuming later. A disconnected event stream reports an error rather than silently replaying a task.

## Server and diagnostics

```sh
lite serve --workspace /path/to/project --port 3210
lite usage --days 7
lite doctor
lite --help
```

`lite serve` runs in the foreground. It is optional for interactive `lite`, which starts a local backend automatically. `LITE_URL` or `--url` selects an existing server for client commands; `LITE_PORT` changes the default local port.

See [profiles and skills](profiles.md) for `lite profiles` and task configuration, and [hooks and plugins](design-hooks-plugins.md) for local plugin packages.

[Back to Lite](../README.md)
