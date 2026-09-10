import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function healthy(base) {
  const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Speedrail returned HTTP ${response.status}.`);
  const value = await response.json();
  if (value.ok !== true || typeof value.version !== 'string') throw new Error('This address is not a Speedrail server.');
  if (value.name !== 'speedrail') throw new Error('An older agent server is already running at this address. Stop it, migrate saved data if needed, and run speedrail again.');
}

/** An explicit --url is always an attachment. HTTP errors never mean “start a
 * second server”. A local startup lock serializes simultaneous TUI launches. */
export async function ensureTuiServer({ base, root, workspace, explicit, env = process.env }) {
  try { await healthy(base); return; }
  catch (error) {
    if (explicit || !['ECONNREFUSED', 'ConnectionRefused'].includes(error?.cause?.code)) throw error;
  }
  const address = new URL(base);
  if (!['localhost', '127.0.0.1'].includes(address.hostname) || address.pathname !== '/' || address.protocol !== 'http:') throw new Error('Start the server with speedrail serve, then attach with --url.');
  const directory = resolve(root, env.SPEEDRAIL_DATA_DIR || '.speedrail');
  if (!existsSync(join(directory, 'speedrail.db')) && existsSync(join(root, '.lite', 'lite.db'))) throw new Error('Saved data from the previous agent was found. Stop its server and run npm run migrate in the Speedrail checkout.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'tui-start.lock');
  let acquired = false;
  const lockDeadline = Date.now() + 20000;
  while (Date.now() < lockDeadline) {
    try { await mkdir(lock); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { await healthy(base); return; } catch { /* The owner is still starting. */ }
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30000) await rm(lock, { recursive: true, force: true }); } catch { /* Another launcher released it. */ }
      await delay(100);
    }
  }
  if (!acquired) throw new Error('Another Speedrail server startup is in progress. Try again shortly.');
  try {
    try { await healthy(base); return; } catch (error) { if (!['ECONNREFUSED', 'ConnectionRefused'].includes(error?.cause?.code)) throw error; }
    const log = join(directory, 'tui-server.log'), fd = openSync(log, 'a', 0o600);
    const entry = existsSync(join(root, 'dist/server/index.js')) ? [join(root, 'dist/server/index.js')] : ['--import', 'tsx', join(root, 'server/index.ts')];
    const server = spawn(process.execPath, entry, { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...env, SPEEDRAIL_PORT: address.port || '80', SPEEDRAIL_WORKSPACE: workspace } });
    closeSync(fd);
    let failed;
    server.on('error', error => { failed = error; });
    server.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (failed || server.exitCode !== null) { server.kill('SIGTERM'); throw new Error(`Could not start Speedrail. Check ${log}.`); }
      try { await healthy(base); return { pid: server.pid, log }; } catch { /* Wait for the owned process to listen. */ }
      await delay(100);
    }
    server.kill('SIGTERM');
    throw new Error(`Speedrail did not become ready. Check ${log}.`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
