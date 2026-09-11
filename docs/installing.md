# Install and update Litespeed

## macOS package

Litespeed releases include Node, Bun, the native terminal packages, and the built web app for Apple silicon and Intel Macs. You do not need to install Node or run npm. Git and project-specific tools remain separate.

```sh
curl -fsSL https://github.com/BerriAI/litespeed/releases/latest/download/install.sh | sh
```

The installer chooses your Mac architecture, verifies the archive checksum, checks that the included runtime starts, and installs into `~/.local/share/litespeed`. It creates `~/.local/bin/litespeed`. Existing unrelated commands or nonempty installation directories are left alone. The installer adds that directory to your zsh or Bash startup configuration without replacing your existing settings. Reinstalling does not add the same line twice.

Open a new terminal, then run it from the project you want to work on:

```sh
cd /path/to/your/project
litespeed
```

To use the current terminal instead, run `export PATH="$HOME/.local/bin:$PATH"` once. An installer launched with `curl … | sh` cannot change its parent terminal’s environment. The first launch asks for your gateway base URL and API key. For the browser, open `http://localhost:3210`, or run `litespeed serve` for a web-only session.

You can also download the archive for your Mac from [Releases](https://github.com/BerriAI/litespeed/releases), alongside its `manifest.json`. Extract it and run `litespeed/runtime/node litespeed/bin/install.mjs /absolute/path/to/archive.tar.gz /absolute/path/to/manifest.json`. These are terminal/server packages, not a signed/notarized `.app` or `.pkg` installer.

## Updates

Litespeed checks release metadata in the background, at most once a day after a successful check. Failed checks retry later and never block chat. Both UIs show a small notice when an update is available. Use **Install update**, then **Restart** when your tasks and workspace terminals are finished. The web page reloads after the new backend responds; the terminal reloads its client and returns to the same session. Other already-open terminal clients should be reopened to load their new UI.

Or run:

```sh
litespeed update
```

This downloads and verifies the latest stable release, switches the installed version atomically, and restarts the matching local server if idle. If work is active, installation completes and the server keeps running. Run the command again after work finishes. An explicit `--url` selects your local server if you use a nondefault port. `litespeed --version` prints the installed CLI version.

No update is installed merely because a check found one. Update requests go only to the public Litespeed GitHub releases; no prompts, keys, or session data are sent. `LITESPEED_NO_UPDATE_CHECK=1` disables background checks. Checksums protect against incomplete/corrupt downloads; they are published through the same GitHub release trust boundary, not a separate signing service.

## Data and existing source installations

Packaged installs store sessions, settings, and provider keys in `~/.local/share/litespeed-data`, outside version directories. `LITESPEED_DATA_DIR` can select an existing absolute data directory. Terminal preferences retain their existing `~/.config/litespeed` and `~/.local/state/litespeed` locations. Old application versions remain available on disk; downgrades and database rollback are not automatic.

To carry a source installation's data forward, stop its server and set `LITESPEED_DATA_DIR` to the absolute path of its `.litespeed` directory before starting the package. Back up that directory first. Keep the same address/port to retain browser drafts. Do not merge databases or run two servers against one data directory. If your data is still under `.speedrail` or `.lite`, first use the [rename migration](upgrading.md).

The installer supports `LITESPEED_INSTALL_DIR` and `LITESPEED_BIN_DIR` for custom installation paths. Set `LITESPEED_NO_MODIFY_PATH=1` to leave shell startup files alone. Other shells and unwritable startup files receive manual PATH instructions; `~/.local/bin/litespeed` remains available as a direct fallback. It does not automatically replace an npm-linked command elsewhere on PATH. Check `command -v litespeed` and use the printed packaged launcher path until PATH selects it.

## Build from source

The source workflow remains available with Node 26.4+ and npm:

```sh
git clone https://github.com/BerriAI/litespeed.git &&
cd litespeed &&
npm ci &&
npm run build &&
npm link
```

Keep that checkout in place. Pull changes, run `npm ci && npm run build`, and restart your server when updating. Source checkouts show update information but never let the packaged updater replace your Git working tree.

## Publishing a release

Bump `package.json` and the lockfile root version, update `docs/release-notes.md`, and push a matching `vX.Y.Z` tag. The release workflow independently builds and tests both macOS architectures. It verifies checksums, combines their manifests, and publishes assets only after both package smoke tests pass. A workflow dispatch builds verification artifacts without publishing a release.

Locally, `npm run package:macos` builds for the current Mac and `npm run test:package` verifies the bundled install and a synthetic upgrade in a disposable directory. The smoke test removes system Node/Bun from PATH, boots the native TUI and web server, completes a synthetic provider call, refuses a busy restart, and checks session/settings preservation after restarting the updated server.
