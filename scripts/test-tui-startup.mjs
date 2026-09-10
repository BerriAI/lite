/** Production launcher smoke in an isolated install, without provider calls. */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import xterm from '@xterm/headless';

const source = resolve(import.meta.dirname, '..');
const install = await mkdtemp(join(tmpdir(), 'lite-production-tui-'));
const emulator = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
const screen = () => Array.from({ length: emulator.rows }, (_, i) => emulator.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
let terminal, serverPid, base;
const delay = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async (predicate, label) => { const end = Date.now() + 20000; while (Date.now() < end) { if (await predicate()) return; await delay(80); } throw new Error(`${label}\n${screen()}`); };
try {
  for (const path of ['bin', 'tui', 'shared', 'dist', 'package.json']) await cp(join(source, path), join(install, path), { recursive: true });
  await symlink(join(source, 'node_modules'), join(install, 'node_modules'), 'dir');
  await mkdir(join(install, 'global-bin'));
  await symlink(join(install, 'bin', 'lite.mjs'), join(install, 'global-bin', 'lite'));
  await mkdir(join(install, 'workspace'));
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  base = `http://localhost:${port}`;
  const env = { ...process.env, PATH: `${join(install, 'global-bin')}:${process.env.PATH}`, TERM: 'xterm-256color', LITE_PORT: String(port), LITE_MODEL: 'startup-smoke', LITE_DATA_DIR: join(install, 'state'), LITE_DISABLE_PROJECT_CONFIG: '1', XDG_CONFIG_HOME: join(install, 'config'), XDG_STATE_HOME: join(install, 'cache') };
  delete env.LITE_URL; delete env.LITE_TUI_CONFIG; delete env.LITE_CONFIG_DIR; delete env.LITE_WORKSPACE;
  terminal = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], { cwd: join(install, 'workspace'), cols: 100, rows: 30, name: 'xterm-256color', env: { ...env, PS1: 'LITE_SMOKE_SHELL> ' } });
  const exited = new Promise(done => terminal.onExit(done));
  terminal.onData(data => { const match = /Stop it with: kill (\d+)/.exec(data); if (match) serverPid = Number(match[1]); emulator.write(data); });
  await waitFor(() => screen().includes('LITE_SMOKE_SHELL>'), 'Invoking shell did not open');
  terminal.write('lite\r');
  await waitFor(() => screen().includes('A fresh start.') && screen().includes('Ctrl+P Commands'), 'Production TUI did not open');
  assert(serverPid, 'launcher reports the owned backend PID');
  const sessions = await (await fetch(`${base}/api/sessions`)).json();
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].workspace, await realpath(join(install, 'workspace')));
  terminal.write('\x1a');
  await waitFor(() => screen().includes('Stopped') && screen().includes('LITE_SMOKE_SHELL>'), 'Suspend did not return to invoking shell');
  terminal.write('fg\r');
  await waitFor(() => screen().includes('A fresh start.') && screen().includes('Ctrl+P Commands'), 'Foreground did not restore terminal');
  terminal.write('\x03'); await delay(100); terminal.write('\x03');
  await waitFor(() => screen().includes('LITE_SMOKE_SHELL>') && !screen().includes('Ctrl+P Commands'), 'Quit did not restore invoking shell');
  terminal.write('exit\r');
  const result = await Promise.race([exited, delay(5000).then(() => { throw new Error('Production TUI did not exit'); })]);
  assert.equal(result.exitCode, 0);
  assert((await fetch(`${base}/api/health`)).ok, 'leaving the TUI preserves the backend');
  console.log('Production TUI passed: bare lite on PATH, automatic backend startup, caller workspace, suspend/foreground, clean exit, and backend ownership.');
} catch (error) {
  console.error(await readFile(join(install, 'state', 'tui-server.log'), 'utf8').catch(() => 'No startup log.'));
  throw error;
} finally {
  terminal?.kill(); emulator.dispose();
  if (serverPid) { try { process.kill(serverPid, 'SIGTERM'); } catch {} await delay(500); }
  await rm(install, { recursive: true, force: true });
}
