import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { updateService, installed, newer } from '../bin/updates.mjs';
import { VERSION } from '../shared/version.js';
import '../bin/check-node.mjs';
import { existsSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { default: express } = await import('express');
const { ownDataDirectory } = await import('./ownership.js');

if (existsSync('.env')) process.loadEnvFile('.env');
const { createApp } = await import('./app.js');
const { Store, assertNoLegacyStore } = await import('./store.js');
const { McpManager } = await import('./mcp.js');
const { CodexAuth } = await import('./auth.js');
const { configureCodexAuth } = await import('./providers.js');
const { attachTerminals } = await import('./terminal.js');
const port = Number(process.env.LITESPEED_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LITESPEED_PORT must be a valid port number.');
assertNoLegacyStore(resolve(process.env.LITESPEED_DATA_DIR || '.litespeed'));
const releaseOwnership = ownDataDirectory(resolve(process.env.LITESPEED_DATA_DIR || '.litespeed'));
process.once('exit', releaseOwnership);
const store = new Store();
const mcp = new McpManager(() => store.settings().mcpServers);
const auth = new CodexAuth(store.directory);
configureCodexAuth(id => auth.credentials(id));
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), fileURLToPath(import.meta.url).includes('/dist/') ? '../..' : '..');
const installation = await installed(packageRoot);
const updater = updateService({ root: packageRoot, version: VERSION, directory: store.directory });
let restarting = false;
const { app, runner } = createApp({ store, external:mcp, auth, updates: {
  ...updater, installation: installation?.home, draining: () => restarting,
  async restart() {
    if (!installation) throw Object.assign(new Error('Restart updates are only available in the packaged install.'), { status: 409 });
    const next = await realpath(resolve(installation.home, 'current'));
    const release = JSON.parse(await readFile(resolve(next, 'release.json'), 'utf8'));
    if (!newer(release.version, VERSION) || next !== resolve(installation.home, 'releases', release.version)) throw Object.assign(new Error('Install a newer version before restarting.'), { status: 409 });
    if (restarting || terminals.active()) throw Object.assign(new Error('Close workspace terminals before restarting. The update is installed.'), { status: 409 });
    runner.prepareRestart(); restarting = true;
    setTimeout(() => { void close(next); }, 100);
    return { version: release.version };
  },
} });
const production = fileURLToPath(import.meta.url).includes('/dist/');
let vite: import('vite').ViteDevServer | undefined;
if (production) {
  const client = resolve(dirname(fileURLToPath(import.meta.url)), '../client');
  app.use(express.static(client));
  app.get('/{*path}', (_req,res) => res.sendFile(resolve(client,'index.html')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ server:{ middlewareMode:true }, appType:'spa' });
  app.use(vite.middlewares);
}

const server = app.listen(port,'127.0.0.1', () => {
  console.log(`\n  ≋ Litespeed\n  Your ideas, up to speed.\n\n  http://localhost:${port}\n  Workspace: ${store.settings().workspace}\n  Press Ctrl+C to stop.\n`);
});
const terminals = attachTerminals(server,store,()=>restarting);
server.on('error',error => { console.error(error.message); process.exitCode=1; void close(); });
let closing=false;
async function close(restartRoot?: string) {
  if(closing)return;closing=true;
  const timeout=setTimeout(()=>{console.error('Shutdown timed out. Interrupted work may require recovery after restart.');process.exit(1);},5000);
  const disconnected=new Promise<void>(resolve=>server.close(()=>resolve()));
  server.closeAllConnections();
  runner.stopAll();
  const results=await Promise.allSettled([runner.whenIdle(),disconnected,terminals.close(),mcp.close(),Promise.resolve(auth.close()),vite?.close()]);
  const failed=results.some(result=>result.status==='rejected');
  if(failed)console.error('A resource could not close cleanly. Review interrupted work after restart.');
  store.close();releaseOwnership();clearTimeout(timeout);
  if (restartRoot && !failed) {
    const fd = openSync(resolve(store.directory, 'tui-server.log'), 'a', 0o600);
    const replacement = spawn(resolve(restartRoot, 'runtime/node'), [resolve(restartRoot, 'dist/server/index.js')], { cwd: restartRoot, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, LITESPEED_DATA_DIR: store.directory, LITESPEED_PORT: String(port) } });
    closeSync(fd);
    await new Promise<void>((done,reject)=>{replacement.once('spawn',()=>done());replacement.once('error',reject);});
    replacement.unref();
  }
  process.exit(failed?1:process.exitCode ?? 0);
}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
