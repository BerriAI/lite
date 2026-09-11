# Speedrail

A local coding agent for your terminal and browser, built around **multi-model workflows**. Use one model or combine a driver with sidekicks, workers, or experts. Follow their work, approve changes, and review the result in one conversation. Pairing models lets a faster, cheaper model handle routine work while a stronger model handles planning or difficult tasks, which can reduce cost and wait time.

Connect through LiteLLM, OpenAI-compatible APIs, native Anthropic, or ChatGPT device sign-in. Your project stays on your machine; prompts and selected context go to your chosen provider.

## Quick start

For the macOS launch, use **Node 26.4+** and npm. Git is needed to clone the repository and use Git tools; Bash is needed for shell tools. Paste this once:

```sh
git clone https://github.com/BerriAI/speedrail.git &&
cd speedrail &&
npm ci &&
npm run build &&
npm link
```

This installs the locked dependencies, builds Speedrail, and makes the command available. Bun and the native terminal packages are installed automatically by npm.

Then open Speedrail from **the project you want to work on**:

```sh
cd /path/to/your/project
speedrail
```

That directory becomes your workspace. Speedrail starts its local backend automatically. Keep the cloned checkout in place: `npm link` points the command to it.

Speedrail has its own command, separate from the [LiteLLM gateway CLI](https://docs.litellm.ai/docs/proxy/management_cli). If you used an earlier version of this agent, follow the [upgrade guide](docs/upgrading.md) to carry over saved sessions and configuration.

1. On your first launch, enter your **LiteLLM gateway base URL** and **API key**, then choose your setup and models. **Sidekick Fusion is recommended:** pick a powerful driver and an efficient coding workhorse as its Sidekick. Choose **Single model** if you prefer one model for everything. Speedrail remembers the connection and model; running `speedrail` in another project opens chat directly.
2. Use **Models** or `/models` to change your arrangement. **Ask first** is the default; **Allow all tools** is available in permissions. The full setup is available from the web sidebar or `/setup`.
3. Type a task. **Build** can edit files and run commands; **Plan** uses read-only tools. Type `/` for command suggestions in either client; use **↑/↓**, **Tab** or **Enter** to complete, and **Esc** to dismiss. **Ctrl+P** opens terminal commands and navigation.

See the [terminal guide](docs/tui.md) for shortcuts, resuming sessions, and configuration.

## Prefer the browser?

Once Speedrail is running, open **http://localhost:3210**. The browser and terminal share saved sessions, providers, and model settings.

For a web-only session, run `speedrail serve`. For development, use `npm run dev` from the checkout. See [development and updating](docs/development.md).

## Choose how models work together

| Architecture | How it works |
| --- | --- |
| **Single model** | One model investigates, implements, and checks the task. |
| **Sidekick Fusion** · Recommended | A strong driver plans and reviews; a cheaper sidekick keeps context across handoffs. |
| **Team Fusion** | A strong driver assigns fresh cheaper workers, runs independent work in parallel, and verifies the combined result. |
| **Expert Fusion** | A cheaper driver coordinates fresh strong experts and verifies their work. Independent assignments can run in parallel. |

Choose any connected model for each role. An optional **Planner model** handles Plan mode separately. Speedrail remembers your model arrangement per workspace; existing sessions keep their settings. Cost and quality depend on the models and task. See [architecture details and limits](docs/architectures.md).

## Guides

- [Using Speedrail](docs/usage.md): queue follow-ups, steer a response, answer questions, manage context, and customize projects.
- [Providers](docs/providers.md) · [CLI and scripting](docs/cli.md) · [Terminal controls](docs/tui.md)
- [Permissions](docs/permissions.md) · [Undo/redo, recovery, and local data](docs/local-data.md)
- [Project profiles and skills](docs/profiles.md) · [MCP connections](docs/mcp.md) · [Hooks and plugins](docs/design-hooks-plugins.md)
- [Agent memory](docs/memory.md) · [History search](docs/search.md) · [Research tasks](docs/delegation.md)
- [Feature coverage and known gaps](docs/coverage.md) · [Development and tests](docs/development.md)

Approved commands run with your local user’s capabilities; permissions are not a sandbox. Keep the server local. Provider keys stay server-side, and provider usage may incur charges.

## License

Speedrail is licensed under [Apache-2.0](LICENSE). Bundled themes and fonts retain their original licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
