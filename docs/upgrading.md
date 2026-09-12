# Upgrading to Litespeed

For current packaged releases and `litespeed update`, see [installation and updates](installing.md). The instructions below migrate the older Speedrail and Lite names and source installation.

The coding agent is now **Litespeed**. Its package is `@litellm/litespeed`, its command is `litespeed`, and its repository is [BerriAI/litespeed](https://github.com/BerriAI/litespeed). The separate LiteLLM gateway-management CLI keeps its own `lite` command.

## Keep existing sessions and preferences

If you also use Claude Code or Codex skills, you can carry them into a project after upgrading: open **/skills** (terminal) or **Settings → Project profiles** (browser) and use **Import a Claude/Codex skill…**. It copies a `SKILL.md` skill and its support files into `.litespeed/skills` and registers it; nothing is auto-activated. See [Project profiles and skills](profiles.md).

Stop the old agent server first. From the updated checkout, run:

```sh
npm install
npm run migrate
npm run build
npm link
litespeed
```

The migration copies `.speedrail` (or `.lite` for the earliest installations) to `.litespeed`, renames the session database, and carries over terminal configuration, drafts, themes, and history. It updates pinned profile source paths and plugin installation records while preserving conversation text, provider keys, approvals, memory, and saved model choices. The browser copies existing drafts and its panel preference when opened on the same local address.

For a packaged installation, stop the old server before launching Litespeed for the first time, then use the included migration command:

```sh
~/.local/bin/litespeed migrate /absolute/path/to/old/checkout
~/.local/bin/litespeed
```

The packaged launcher selects its persistent data directory as the destination. If that directory already contains sessions, migration will not merge or replace them. Stop and choose a separate `LITESPEED_DATA_DIR` before migrating instead. If both old names have data, the newer Speedrail directory takes precedence; the older Lite copy remains untouched.

For projects with their own configuration, supply their directories:

```sh
npm run migrate -- /path/to/project /path/to/another-project
```

The original data remains as a backup. Existing Litespeed files are never overwritten. Keep the old server stopped after migration: changes made in the old app are not synchronized into Litespeed. Saved sessions retain their original workspace paths; the checkout directory does not need to be renamed.

| Before | Now |
| --- | --- |
| `bin/speedrail.mjs` / `bin/lite.mjs` | `bin/litespeed.mjs` |
| `.speedrail/speedrail.db` / `.lite/lite.db` | `.litespeed/litespeed.db` |
| `.speedrail/` / `.lite/` project configuration | `.litespeed/` |
| `SPEEDRAIL.md` / `LITE.md` | `LITESPEED.md` |
| `speedrail-tui.json[c]` / `lite-tui.json[c]` | `litespeed-tui.json` / `litespeed-tui.jsonc` |
| `speedrail-plugin.json` / `lite-plugin.json` package manifest | `litespeed-plugin.json` |
| `SPEEDRAIL_*` / `LITE_*` application variables | `LITESPEED_*` |
| `~/.config/speedrail` / `~/.config/lite` | `~/.config/litespeed` |
| `~/.local/state/speedrail` / `~/.local/state/lite` | `~/.local/state/litespeed` |

`LITELLM_BASE_URL` and `LITELLM_API_KEY` still describe the gateway and keep their names. Shell-exported application variables need to be renamed in your shell configuration; the migration updates the checkout's `.env` file and retains a private backup.

For a custom data directory, stop the server and back up the directory first. Temporarily place a copy at the checkout's `.lite` path, remove `SPEEDRAIL_DATA_DIR` / `LITE_DATA_DIR` / `LITESPEED_DATA_DIR` from the migration environment and `.env`, and run the migration. Move the resulting `.litespeed` directory to your chosen new location and set `LITESPEED_DATA_DIR` to it before starting. Do not merge two existing databases.

After linking, check `command -v litespeed`. A stale `speedrail` or `lite` link from this agent can be removed only after verifying its target; leave a separately installed LiteLLM CLI intact.
