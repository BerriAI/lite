# Install and update Speedrail

## macOS package

Speedrail releases include Node, Bun, the native terminal packages, and the built web app for Apple silicon and Intel Macs. You do not need to install Node or run npm. Git and project-specific tools remain separate.

```sh
curl -fsSL https://github.com/BerriAI/speedrail/releases/latest/download/install.sh | sh
```

The installer chooses your Mac architecture, verifies the archive checksum, checks that the included runtime starts, and installs into `~/.local/share/speedrail`. It creates `~/.local/bin/speedrail`. Existing unrelated commands or nonempty installation directories are left alone. The installer prints the exact command to start Speedrail; if `~/.local/bin` is not on PATH, it also prints the line to add to your shell configuration.

From the project you want to work on:

```sh
cd /path/to/your/project
~/.local/bin/speedrail
```

Once `~/.local/bin` is on PATH, use `speedrail`. The first launch asks for your gateway base URL and API key. For the browser, open `http://localhost:3210`, or run `speedrail serve` for a web-only session.

You can also download the archive for your Mac from [Releases](https://github.com/BerriAI/speedrail/releases), alongside its `manifest.json`. Extract it and run `speedrail/runtime/node speedrail/bin/install.mjs /absolute/path/to/archive.tar.gz /absolute/path/to/manifest.json`. These are terminal/server packages, not a signed/notarized `.app` or `.pkg` installer.

## Updates

Speedrail checks release metadata in the background, at most once a day after a successful check. Failed checks retry later and never block chat. Both UIs show a small notice when an update is available. Use **Install update**, then **Restart** when your tasks and workspace terminals are finished. The web page reloads after the new backend responds; the terminal reloads its client and returns to the same session. Other already-open terminal clients should be reopened to load their new UI.

Or run:

```sh
speedrail update
```

This downloads and verifies the latest stable release, switches the installed version atomically, and restarts the matching local server if idle. If work is active, installation completes and the server keeps running. Run the command again after work finishes. An explicit `--url` selects your local server if you use a nondefault port. `speedrail --version` prints the installed CLI version.

No update is installed merely because a check found one. Update requests go only to the public Speedrail GitHub releases; no prompts, keys, or session data are sent. `SPEEDRAIL_NO_UPDATE_CHECK=1` disables background checks. Checksums protect against incomplete/corrupt downloads; they are published through the same GitHub release trust boundary, not a separate signing service.

## Data and existing source installations

Packaged installs store sessions, settings, and provider keys in `~/.local/share/speedrail-data`, outside version directories. `SPEEDRAIL_DATA_DIR` can select an existing absolute data directory. Terminal preferences retain their existing `~/.config/speedrail` and `~/.local/state/speedrail` locations. Old application versions remain available on disk; downgrades and database rollback are not automatic.

To carry a source installation's data forward, stop its server and set `SPEEDRAIL_DATA_DIR` to the absolute path of its `.speedrail` directory before starting the package. Back up that directory first. Keep the same address/port to retain browser drafts. Do not merge databases or run two servers against one data directory. If your data is still under `.lite`, first use the [rename migration](upgrading.md).

The installer supports `SPEEDRAIL_INSTALL_DIR` and `SPEEDRAIL_BIN_DIR` for custom installation paths. It does not automatically replace an npm-linked command elsewhere on PATH. Check `command -v speedrail` and use the printed packaged launcher path until PATH selects it.

## Build from source

The source workflow remains available with Node 26.4+ and npm:

```sh
git clone https://github.com/BerriAI/speedrail.git &&
cd speedrail &&
npm ci &&
npm run build &&
npm link
```

Keep that checkout in place. Pull changes, run `npm ci && npm run build`, and restart your server when updating. Source checkouts show update information but never let the packaged updater replace your Git working tree.

## Publishing a release

Bump `package.json` and the lockfile root version, update `docs/release-notes.md`, and push a matching `vX.Y.Z` tag. The release workflow independently builds and tests both macOS architectures. It verifies checksums, combines their manifests, and publishes assets only after both package smoke tests pass. A workflow dispatch builds verification artifacts without publishing a release.

Locally, `npm run package:macos` builds for the current Mac and `npm run test:package` verifies the bundled install and a synthetic upgrade in a disposable directory. The smoke test removes system Node/Bun from PATH, boots the native TUI and web server, completes a synthetic provider call, refuses a busy restart, and checks session/settings preservation after restarting the updated server.
