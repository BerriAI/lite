/** @jsxImportSource @opentui/react */
/** Terminal client entry. Runs under Bun (the renderer's native layer does not
 * load under plain Node); `bin/litespeed.mjs tui` re-execs this file with the local
 * Bun binary. Renderer options match the verified working set — changing them
 * (notably useKittyKeyboard or exitOnCtrlC) breaks keyboard delivery in some
 * terminals, so treat this block as load-bearing. */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { Session } from '../shared/types.js';
import { LitespeedClient } from './client.js';
import { parseOptions } from './options.js';
import { SessionSync } from './sync.js';
import { App } from './app.tsx';
import { TerminalController } from './controller.js';
import { TerminalStorage } from './storage.js';
import { getTheme, setCustomThemes, type Theme } from './theme.js';
import { BUILTIN_THEMES, DEFAULT_THEME_NAME } from './themes.js';
import { ACTIVE_KEY_ACTIONS } from './commands.js';
import { KeymapRouter, buildBindings, resolveLeader } from './keymap.js';
import { discoverCustomThemes, loadTuiConfig } from './tuiConfig.js';

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('litespeed tui needs an interactive terminal. Use litespeed run "prompt" for scripted use.\n');
    process.exitCode = 1;
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const client = new LitespeedClient(options.url);

  let sessionId = options.sessionId;
  if (!sessionId) {
    try {
      const body: Record<string, unknown> = {
        workspace: options.workspace,
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      };
      if (options.model) body.model = options.model;
      if (options.providerId) body.providerId = options.providerId;
      sessionId = (await client.api<Session>('/sessions', body)).id;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error instanceof Error ? error.message : '');
      process.stderr.write(/fetch failed|ECONNREFUSED|ConnectionRefused/i.test(String(cause))
        ? 'Could not reach the Litespeed server. Start it with litespeed serve first.\n'
        : `${error instanceof Error ? error.message : 'Could not create a session.'}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const existing = await client.api<import('../shared/types.js').SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
  const workspace = existing.session.workspace;
  let config = loadTuiConfig({ cwd: workspace });
  setCustomThemes(discoverCustomThemes({ cwd: workspace }));
  const storage = new TerminalStorage();
  let themeName = config.theme ?? storage.preferences().theme ?? DEFAULT_THEME_NAME;
  let router = new KeymapRouter(resolveLeader(config.keybinds), config.leader_timeout);
  router.addLayer({ name: 'app', bindings: buildBindings(config.keybinds, ACTIVE_KEY_ACTIONS) });
  const renderer = await createCliRenderer({
    useMouse: config.mouse,
    externalOutputMode: 'passthrough',
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
  });

  const sync = new SessionSync(client, sessionId);
  const terminalMode = await renderer.waitForThemeMode(250) ?? 'dark';
  let theme = getTheme(themeName, terminalMode, BUILTIN_THEMES) ?? getTheme(DEFAULT_THEME_NAME, terminalMode, BUILTIN_THEMES)!;
  if (config.cursor) renderer.setCursorStyle({ style: config.cursor.style === 'bar' ? 'line' : config.cursor.style, blinking: config.cursor.blink });
  const controller = new TerminalController(client, sync, storage);
  void controller.settings().catch(error => controller.notice(String(error)));

  let workspaceUnsubscribe = () => {};
  let quitting = false;
  const quit = (code = 0) => {
    if (quitting) return;
    quitting = true;
    process.exitCode = code;
    workspaceUnsubscribe();
    router.dispose();
    controller.stop();
    renderer.destroy();
    try { storage.flush(); } catch { process.stderr.write('Could not save the terminal draft cache.\n'); }
  };
  process.on('SIGTERM', () => quit(143));
  process.on('SIGHUP', () => quit(129));
  const finished = new Promise<void>(resolve => renderer.once('destroy', () => resolve()));

  const root = createRoot(renderer);
  let activeWorkspace = workspace;
  const render = () => root.render(<App key={activeWorkspace} controller={controller} config={config} storage={storage} theme={theme} themeName={themeName} router={router} onQuit={code => quit(code ?? 0)} />);
  workspaceUnsubscribe = controller.subscribe(() => {
    const nextWorkspace = controller.detail?.session.workspace;
    if (!nextWorkspace || nextWorkspace === activeWorkspace) return;
    activeWorkspace = nextWorkspace;
    config = loadTuiConfig({ cwd: nextWorkspace, warn: message => controller.notice(message) });
    setCustomThemes(discoverCustomThemes({ cwd: nextWorkspace }));
    themeName = config.theme ?? storage.preferences().theme ?? DEFAULT_THEME_NAME;
    theme = getTheme(themeName, renderer.themeMode ?? 'dark', BUILTIN_THEMES) ?? getTheme(DEFAULT_THEME_NAME, renderer.themeMode ?? 'dark', BUILTIN_THEMES)!;
    router.dispose(); router = new KeymapRouter(resolveLeader(config.keybinds), config.leader_timeout);
    router.addLayer({ name: 'app', bindings: buildBindings(config.keybinds, ACTIVE_KEY_ACTIONS) });
    renderer.useMouse = config.mouse;
    renderer.setCursorStyle({ style: config.cursor?.style === 'bar' ? 'line' : config.cursor?.style ?? 'block', blinking: config.cursor?.blink ?? true });
    render();
  });
  render();

  await finished;
  root.unmount();
  process.exit(process.exitCode ?? 0);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
