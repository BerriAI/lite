# Command-line reference

Run `litespeed` in a project directory for interactive terminal chat. See the [installation instructions](../README.md#quick-start) and [terminal guide](tui.md). The commands below are for scripting and server management.

## Run a task

`litespeed run` uses the same backend as the interactive clients. If it is not running yet, start `litespeed serve` in a separate terminal. Run task commands from the project directory you want to work in.

```sh
litespeed run "Explain the architecture" --plan --model your-model-id
litespeed run "Add tests for the parser" --session SESSION_ID
litespeed sessions
litespeed models
litespeed export SESSION_ID > session.json
```

`run` connects to an already running server. Use `--url` to select another local Litespeed server and `--json` for newline-delimited events. In a noninteractive process, permission requests are denied rather than hanging. `--auto` deliberately allows edits and shell commands for a new session. An existing `--session` keeps its saved model, provider, mode, and permissions; change those in the app rather than passing conflicting flags. Use `--` before a prompt that begins with a dash.

Provider errors produce a nonzero exit status, including with `--json`. Ctrl+C/SIGTERM cancels the remote run and reports the session ID for resuming later. A disconnected event stream reports an error rather than silently replaying a task.

## Server and diagnostics

```sh
litespeed serve --workspace /path/to/project --port 3210
litespeed usage --days 7
litespeed doctor
litespeed --help
```

`litespeed serve` runs in the foreground. It is optional for interactive `litespeed`, which starts a local backend automatically. `LITESPEED_URL` or `--url` selects an existing server for client commands; `LITESPEED_PORT` changes the default local port.

See [profiles and skills](profiles.md) for `litespeed profiles` and task configuration, and [hooks and plugins](design-hooks-plugins.md) for local plugin packages.

[Back to Litespeed](../README.md)
