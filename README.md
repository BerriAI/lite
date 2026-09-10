# Lite

A local coding agent for your terminal and browser, built around **multi-model workflows**. Use one model or combine a driver with sidekicks, workers, or experts. Follow their work, approve changes, and review the result in one conversation. Pairing models lets a faster, cheaper model handle routine work while a stronger model handles planning or difficult tasks, which can reduce cost and wait time.

Connect through LiteLLM, OpenAI-compatible APIs, native Anthropic, or ChatGPT device sign-in. Your project stays on your machine; prompts and selected context go to your chosen provider.

## Quick start

Requires **Node 22.13+** and npm. Git and Bash are needed for their corresponding tools. Install once:

```sh
git clone https://github.com/BerriAI/lite.git
cd lite
npm install
npm run build
npm link
```

Then, from **any project directory**:

```sh
cd /path/to/your/project
lite
```

That directory becomes your workspace. Lite starts its local backend automatically. Keep the cloned checkout in place: `npm link` points the command to it.

1. On your first launch, enter your **LiteLLM gateway base URL** and **API key**, then pick a model. You can start chatting immediately. Lite remembers the connection and model; running `lite` in another project opens chat directly.
2. Use **Models** or `/models` to add a Sidekick, workers, or experts. **Ask first** is the default; **Allow all tools** is available in permissions. The full setup is available from the web sidebar or `/setup`.
3. Type a task. **Build** can edit files and run commands; **Plan** uses read-only tools. **Ctrl+P** opens terminal commands and navigation.

See the [terminal guide](docs/tui.md) for shortcuts, resuming sessions, and configuration.

## Prefer the browser?

Once Lite is running, open **http://localhost:3210**. The browser and terminal share saved sessions, providers, and model settings.

For a web-only session, run `lite serve`. For development, use `npm run dev` from the checkout. See [development and updating](docs/development.md).

## Choose how models work together

| Architecture | How it works |
| --- | --- |
| **Single model** | One model investigates, implements, and checks the task. |
| **Sidekick Fusion** | A strong driver plans and reviews; a cheaper sidekick keeps context across handoffs. |
| **Team Fusion** | A strong driver assigns fresh cheaper workers, runs independent work in parallel, and verifies the combined result. |
| **Expert Fusion** | A cheaper driver coordinates fresh strong experts and verifies their work. Independent assignments can run in parallel. |

Choose any connected model for each role. An optional **Planner model** handles Plan mode separately. Lite remembers your model arrangement per workspace; existing sessions keep their settings. Cost and quality depend on the models and task. See [architecture details and limits](docs/architectures.md).

## Guides

- [Using Lite](docs/usage.md): queue follow-ups, steer a response, answer questions, manage context, and customize projects.
- [Providers](docs/providers.md) · [CLI and scripting](docs/cli.md) · [Terminal controls](docs/tui.md)
- [Permissions](docs/permissions.md) · [Undo/redo, recovery, and local data](docs/local-data.md)
- [Project profiles and skills](docs/profiles.md) · [MCP connections](docs/mcp.md) · [Hooks and plugins](docs/design-hooks-plugins.md)
- [Agent memory](docs/memory.md) · [History search](docs/search.md) · [Research tasks](docs/delegation.md)
- [Feature coverage and known gaps](docs/coverage.md) · [Development and tests](docs/development.md)

Approved commands run with your local user’s capabilities; permissions are not a sandbox. Keep the server local. Provider keys stay server-side, and provider usage may incur charges.
