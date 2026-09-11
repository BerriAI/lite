# Upgrading to Speedrail

For current packaged releases and `speedrail update`, see [installation and updates](installing.md). The instructions below migrate the older Lite name and source installation.

The coding agent is now **Speedrail**. Its package is `@litellm/speedrail`, its command is `speedrail`, and its repository is [BerriAI/speedrail](https://github.com/BerriAI/speedrail). The separate LiteLLM gateway-management CLI keeps its own `lite` command.

## Keep existing sessions and preferences

Stop the old agent server first. From the updated checkout, run:

```sh
npm install
npm run migrate
npm run build
npm link
speedrail
```

The migration copies `.lite` to `.speedrail`, renames the session database, and carries over terminal configuration, drafts, themes, and history. It updates pinned profile source paths and plugin installation records while preserving conversation text, provider keys, approvals, memory, and saved model choices. The browser copies existing drafts and its panel preference when opened on the same local address.

For projects with their own configuration, supply their directories:

```sh
npm run migrate -- /path/to/project /path/to/another-project
```

The original data remains as a backup. Existing Speedrail files are never overwritten. Keep the old server stopped after migration: changes made in the old app are not synchronized into Speedrail. Saved sessions retain their original workspace paths; the checkout directory does not need to be renamed.

| Before | Now |
| --- | --- |
| `bin/lite.mjs` | `bin/speedrail.mjs` |
| `.lite/lite.db` | `.speedrail/speedrail.db` |
| `.lite/` project configuration | `.speedrail/` |
| `LITE.md` | `SPEEDRAIL.md` |
| `lite-tui.json` / `lite-tui.jsonc` | `speedrail-tui.json` / `speedrail-tui.jsonc` |
| `lite-plugin.json` package manifest | `speedrail-plugin.json` |
| `LITE_*` application variables | `SPEEDRAIL_*` |
| `~/.config/lite` | `~/.config/speedrail` |
| `~/.local/state/lite` | `~/.local/state/speedrail` |

`LITELLM_BASE_URL` and `LITELLM_API_KEY` still describe the gateway and keep their names. Shell-exported application variables need to be renamed in your shell configuration; the migration updates the checkout's `.env` file and retains a private backup.

For a custom data directory, stop the server and back up the directory first. Temporarily place a copy at the checkout's `.lite` path, remove `LITE_DATA_DIR` / `SPEEDRAIL_DATA_DIR` from the migration environment and `.env`, and run the migration. Move the resulting `.speedrail` directory to your chosen new location and set `SPEEDRAIL_DATA_DIR` to it before starting. Do not merge two existing databases.

After linking, check `command -v speedrail`. A stale `lite` link from this agent can be removed only after verifying its target; leave a separately installed LiteLLM CLI intact.
