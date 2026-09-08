import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

if (existsSync('.env')) loadEnvFile('.env');
const { createApp } = await import('./app.js');
const { Store } = await import('./store.js');
const { McpManager } = await import('./mcp.js');
const { CodexAuth } = await import('./auth.js');
const { configureCodexAuth } = await import('./providers.js');
const { attachTerminals } = await import('./terminal.js');
const store = new Store();
const mcp = new McpManager(() => store.settings().mcpServers);
const auth = new CodexAuth(store.directory);
configureCodexAuth(id => auth.credentials(id));
const { app, runner } = createApp({ store, external:mcp, auth });
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
const port = Number(process.env.LITE_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LITE_PORT must be a valid port number.');
const server = app.listen(port,'127.0.0.1', () => {
  console.log(`\n  ≋ Lite\n  Your ideas, up to speed.\n\n  http://localhost:${port}\n  Workspace: ${store.settings().workspace}\n  Press Ctrl+C to stop.\n`);
});
const terminals = attachTerminals(server,store);
server.on('error',error => { console.error(error.message); process.exitCode=1; });
let closing=false;
async function close() {
  if(closing)return;closing=true;
  runner.stopAll();
  const timeout=setTimeout(()=>process.exit(0),3000);timeout.unref();
  await Promise.allSettled([terminals.close(), mcp.close(), Promise.resolve(auth.close()),vite?.close()]);
  server.close(()=>{store.close();process.exit(0);});
  server.closeAllConnections();
}
process.on('SIGTERM',close);process.on('SIGINT',close);
