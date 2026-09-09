/** @jsxImportSource @opentui/react */
/** Terminal client entry. Runs under Bun (the renderer's native layer does not
 * load under plain Node); `bin/lite.mjs tui` re-execs this file with the local
 * Bun binary. Renderer options match the verified working set — changing them
 * (notably useKittyKeyboard or exitOnCtrlC) breaks keyboard delivery in some
 * terminals, so treat this block as load-bearing. */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { Session } from '../shared/types.js';
import { LiteClient } from '../tui/client.js';
import { parseOptions } from './options.js';
import { SessionSync } from './sync.js';
import { App } from './app.tsx';
import { getTheme, setCustomThemes, type Theme } from './theme.js';
import { BUILTIN_THEMES, DEFAULT_THEME_NAME } from './themes.js';
import { KeymapRouter, buildBindings, resolveLeader } from './keymap.js';
import { discoverCustomThemes, loadTuiConfig } from './tuiConfig.js';

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('lite tui needs an interactive terminal. Use lite run "prompt" for scripted use.\n');
    process.exitCode = 1;
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const client = new LiteClient(options.url);

  // Config + theme + keymap load before the renderer so a bad config file
  // warns on stderr while it is still visible.
  const config = loadTuiConfig();
  setCustomThemes(discoverCustomThemes());
  const themeName = config.theme ?? DEFAULT_THEME_NAME;
  const theme: Theme = getTheme(themeName, 'dark', BUILTIN_THEMES)
    ?? getTheme(DEFAULT_THEME_NAME, 'dark', BUILTIN_THEMES)!;
  const router = new KeymapRouter(resolveLeader(config.keybinds), config.leader_timeout);
  router.addLayer({ name: 'app', bindings: buildBindings(config.keybinds, ['app_exit', 'session_interrupt']) });

  let sessionId = options.sessionId;
  if (!sessionId) {
    try {
      const body: Record<string, unknown> = {
        workspace: options.workspace,
        permissionMode: options.permissionMode ?? 'ask',
        mode: options.mode ?? 'build',
      };
      if (options.model) body.model = options.model;
      if (options.providerId) body.providerId = options.providerId;
      sessionId = (await client.api<Session>('/sessions', body)).id;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error instanceof Error ? error.message : '');
      process.stderr.write(/fetch failed|ECONNREFUSED|ConnectionRefused/i.test(String(cause))
        ? 'Could not reach the Lite server. Start it with lite serve first.\n'
        : `${error instanceof Error ? error.message : 'Could not create a session.'}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const renderer = await createCliRenderer({
    externalOutputMode: 'passthrough',
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
  });

  const sync = new SessionSync(client, sessionId);
  sync.start();

  let quitting = false;
  const quit = (code = 0) => {
    if (quitting) return;
    quitting = true;
    process.exitCode = code;
    router.dispose();
    sync.stop();
    renderer.destroy();
  };
  process.on('SIGTERM', () => quit(143));
  process.on('SIGHUP', () => quit(129));
  const finished = new Promise<void>(resolve => renderer.once('destroy', () => resolve()));

  const root = createRoot(renderer);
  root.render(<App sync={sync} theme={theme} router={router} onQuit={() => quit(0)} />);

  await finished;
  root.unmount();
  process.exit(process.exitCode ?? 0);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
