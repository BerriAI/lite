/** Real bundled runtimes, isolated state, and a synthetic next release. No provider credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pty from 'node-pty';
import xterm from '@xterm/headless';
const source = resolve(import.meta.dirname, '../..'), platform = `${process.platform}-${process.arch}`;
const artifacts = resolve(process.argv[2] || join(source, 'release-artifacts'));
const release = JSON.parse(await readFile(join(artifacts, `manifest-${platform}.json`), 'utf8'));
const asset = release.assets[platform], archive = join(artifacts, asset.file);
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-package-smoke-')));
let server, terminal, provider, held, updatedPid;
const delay = ms => new Promise(done => setTimeout(done, ms));
const emulator = new xterm.Terminal({ cols: 110, rows: 34, allowProposedApi: true });
const screen = () => Array.from({ length: emulator.rows }, (_, i) => emulator.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
const waitFor = async (predicate, message, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await delay(80); } throw new Error(`${message}\n${screen()}`); };
const apiAt = base => async (path, body, method) => { const response = await fetch(`${base}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status }); return value; };
try {
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', temporary]);
  const unpacked = join(temporary, 'litespeed'), home = join(temporary, 'home'), install = join(home, 'app'), bin = join(home, 'bin'), state = join(home, 'state'), workspace = join(temporary, 'project');
  await mkdir(home); await mkdir(workspace); await writeFile(join(workspace, 'keep.txt'), 'user work stays here');
  const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/sh', TERM: 'xterm-256color', LITESPEED_INSTALL_DIR: install, LITESPEED_BIN_DIR: bin, LITESPEED_DATA_DIR: state, LITESPEED_DISABLE_PROJECT_CONFIG: '1', XDG_STATE_HOME: join(home, 'tui'), XDG_CONFIG_HOME: join(home, 'config'), LITESPEED_NO_UPDATE_CHECK: '1' };
  const metadata = join(temporary, 'manifest.json'); await writeFile(metadata, JSON.stringify(release));
  execFileSync(join(unpacked, 'runtime/node'), [join(unpacked, 'bin/install.mjs'), archive, metadata], { cwd: workspace, env, stdio: 'pipe' });
  const command = join(bin, 'litespeed');
  assert.equal(execFileSync(command, ['--version'], { env, encoding: 'utf8' }).trim(), release.version);
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(done => probe.close(done));
  const base = `http://127.0.0.1:${port}`, api = apiAt(base);
  let nextRelease, nextArchive;
  const finish = res => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"index":0,"delta":{"content":"Package smoke answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5}}\n\ndata: [DONE]\n\n'); };
  const sessionHeaders = [];
  provider = createServer(async (req, res) => {
    if (req.url.endsWith('/manifest.json')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(nextRelease || release)); return; }
    if (nextRelease && req.url.endsWith(nextRelease.assets[platform].file)) { res.end(await readFile(nextArchive)); return; }
    if (req.url.endsWith('/chat/completions')) { let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); sessionHeaders.push(req.headers['x-litellm-session-id']); if (body.messages.at(-1)?.content === 'hold for update') { held = res; return; } finish(res); return; }
    res.writeHead(404).end();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); const gateway = `http://127.0.0.1:${provider.address().port}`;
  const hook = join(temporary, 'fixture-fetch.mjs');
  await writeFile(hook, `const original = globalThis.fetch; globalThis.fetch = (input, options) => { const url = String(input); if (url.startsWith('https://github.com/BerriAI/litespeed/releases/')) return original(${JSON.stringify(gateway)} + new URL(url).pathname, options); if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) throw new Error('External network disabled in package smoke'); return original(input, options); };`);
  env.NODE_OPTIONS = `--import=${pathToFileURL(hook).href}`; env.LITESPEED_NO_UPDATE_CHECK = '0'; env.LITESPEED_PORT = String(port);
  server = spawn(command, ['serve', '--port', String(port), '--workspace', workspace], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
  await waitFor(async () => { try { return (await api('/health')).version === release.version; } catch { if (server.exitCode !== null) throw new Error(log); return false; } }, 'Bundled backend did not start');
  assert.match(await (await fetch(base)).text(), /Litespeed|litespeed/);
  assert.equal((await api('/settings')).memoryEnabled, true);
  await api('/settings', { providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: gateway }], defaultProvider: 'fixture', defaultModel: 'fixture' }, 'PATCH');
  const session = await api('/sessions', { workspace, providerId: 'fixture', model: 'fixture', permissionMode: 'auto' });
  await api(`/sessions/${session.id}/messages`, { content: 'hello from the package' });
  await waitFor(async () => (await api(`/sessions/${session.id}`)).messages.some(message => message.content === 'Package smoke answer'), 'Bundled provider call failed');
  terminal = pty.spawn(command, ['--url', base, '--session', session.id], { cwd: workspace, env, cols: 110, rows: 34, name: 'xterm-256color' });
  const tuiExited = new Promise(done => terminal.onExit(done)); terminal.onData(data => emulator.write(data));
  await waitFor(() => screen().includes('Ctrl+P Commands') && screen().includes('Package smoke answer'), 'Bundled TUI did not render');
  terminal.write('\x03'); await delay(120); terminal.write('\x03');
  assert.equal((await Promise.race([tuiExited, delay(5000).then(() => { throw new Error('TUI did not exit'); })])).exitCode, 0);
  terminal = undefined;
  const nextVersion = release.version.split('.').map(Number); nextVersion[2]++;
  const version = nextVersion.join('.'), upgraded = join(temporary, 'upgrade'); await mkdir(upgraded); await cp(unpacked, join(upgraded, 'litespeed'), { recursive: true, verbatimSymlinks: true });
  const target = join(upgraded, 'litespeed');
  for (const path of ['package.json', 'release.json']) { const value = JSON.parse(await readFile(join(target, path), 'utf8')); value.version = version; await writeFile(join(target, path), JSON.stringify(value)); }
  let changed = 0;
  for (const file of await readdir(join(target, 'dist/server'))) if (file.endsWith('.js')) {
    const path = join(target, 'dist/server', file), text = await readFile(path, 'utf8'), replacement = text.replace(`version: ${JSON.stringify(release.version)},`, `version: ${JSON.stringify(version)},`);
    if (text !== replacement) { await writeFile(path, replacement); changed++; }
  }
  assert.equal(changed, 1, 'The synthetic upgrade must change the bundled application version exactly once');
  const nextFile = `litespeed-${version}-${platform}.tar.gz`; nextArchive = join(temporary, nextFile);
  execFileSync('/usr/bin/tar', ['-czf', nextArchive, '-C', upgraded, 'litespeed']);
  const bytes = await readFile(nextArchive);
  nextRelease = { schema: 1, version, assets: { [platform]: { file: nextFile, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } };
  await delay(1100);
  assert.equal((await api('/updates?check=true')).latestVersion, version);
  await api(`/sessions/${session.id}/messages`, { content: 'hold for update' }); await waitFor(() => Boolean(held), 'Fixture did not hold an active turn');
  const staged = await api('/updates/install', {}); assert.equal(staged.restartRequired, true);
  await assert.rejects(api('/updates/restart', {}), /Finish active tasks/);
  assert.equal((await api('/health')).version, release.version);
  finish(held); held = undefined;
  await waitFor(async () => (await api(`/sessions/${session.id}`)).session.status === 'idle', 'Task did not finish before restart');
  await api('/updates/restart', {});
  await waitFor(async () => { try { return (await api('/health')).version === version; } catch { return false; } }, 'Updated backend did not start');
  const oldSession = await api(`/sessions/${session.id}`); assert.equal(oldSession.session.id, session.id); assert.equal(oldSession.messages.filter(message => message.content === 'Package smoke answer').length, 2);
  assert.equal(await readFile(join(workspace, 'keep.txt'), 'utf8'), 'user work stays here');
  assert.equal(execFileSync(command, ['--version'], { env, encoding: 'utf8' }).trim(), version);
  assert(sessionHeaders.every(id => id === session.id));
  updatedPid = (await api('/health')).pid;
  assert(Number.isInteger(updatedPid), 'Replacement server must identify its PID');
  console.log('Package E2E passed: no system Node/Bun, isolated install, web assets, native TUI, provider call, stable session ID, real download/checksum/activation, busy restart refusal, restart, preserved sessions/settings/workspace, and version update.');
} finally {
  terminal?.kill(); emulator.dispose();
  held?.destroy();
  if (server?.exitCode === null) server.kill('SIGTERM');
  if (updatedPid) { try { process.kill(updatedPid, 'SIGTERM'); } catch {} }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)); }
  await delay(500);
  await rm(temporary, { recursive: true, force: true });
}
