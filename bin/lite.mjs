#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.argv.slice(2);
const optionArgs = raw.includes('--') ? raw.slice(0, raw.indexOf('--')) : raw;
const help = ['help', '--help', '-h'].includes(raw[0]) || optionArgs.some(value => value === '--help' || value === '-h');
const command = help ? 'help' : !raw.length || raw[0].startsWith('--') ? 'serve' : raw[0];
const options = new Map();
const positional = [];
let base;
const valueOptions = new Set(['--url', '--port', '--workspace', '--model', '--provider', '--session']);
const booleanOptions = new Set(['--plan', '--auto', '--json']);
const supported = {
  serve: new Set(['--port', '--workspace']),
  run: new Set(['--url', '--model', '--provider', '--session', '--plan', '--auto', '--json']),
  sessions: new Set(['--url']), models: new Set(['--url', '--provider']), export: new Set(['--url']),
};
const option = (name, fallback) => options.get(name) ?? fallback;

function parse() {
  if (command === 'help') return;
  if (!supported[command]) throw new Error(`Unknown command: ${command}. Use lite --help.`);
  const args = raw[0] === command ? raw.slice(1) : raw;
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (!arg.startsWith('-') || positionalOnly) { positional.push(arg); continue; }
    if (!valueOptions.has(arg) && !booleanOptions.has(arg)) throw new Error(`Unknown option: ${arg}. Use lite --help.`);
    if (!supported[command].has(arg)) throw new Error(`${arg} is not supported by lite ${command}.`);
    if (options.has(arg)) throw new Error(`Duplicate option: ${arg}.`);
    if (valueOptions.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options.set(arg, value);
    } else options.set(arg, true);
  }
  if (command === 'run' && (positional.length !== 1 || !positional[0].trim())) throw new Error('Usage: lite run "your prompt" [--model ID]');
  if (command === 'export' && (positional.length !== 1 || !positional[0].trim())) throw new Error('Usage: lite export <session-id>');
  if (!['run', 'export'].includes(command) && positional.length) throw new Error(`Unexpected argument: ${positional[0]}. Use lite --help.`);
  if (command === 'run' && options.has('--session')) {
    const override = ['--model', '--provider', '--plan', '--auto'].find(name => options.has(name));
    if (override) throw new Error(`${override} cannot be combined with --session. Change the existing session settings in Lite, or start a new session.`);
  }
  const port = option('--port', process.env.LITE_PORT || '3210');
  if (command === 'serve' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('--port must be an integer between 1 and 65535.');
  base = option('--url', process.env.LITE_URL || `http://localhost:${process.env.LITE_PORT || 3210}`);
  if (command !== 'serve') {
    let url; try { url = new URL(base); } catch { throw new Error('--url must be a valid HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('--url must be an HTTP or HTTPS URL without credentials, a query, or a fragment.');
    base = base.replace(/\/+$/, '');
  }
}

async function api(path, body, signal) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`The Lite server returned an invalid response (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function runPrompt(prompt) {
  const existingId = option('--session');
  const session = existingId ? { id: existingId } : await api('/sessions', {
    workspace: process.cwd(), model: option('--model'), providerId: option('--provider'),
    mode: options.has('--plan') ? 'plan' : 'build', permissionMode: options.has('--auto') ? 'auto' : 'ask',
  });
  const path = `/sessions/${encodeURIComponent(session.id)}`;
  const controller = new AbortController();
  let cancellation, interrupted = false, started = false, finished = false, reported = false;
  const reportSession = () => { if (!reported) { process.stderr.write(`\nSession: ${session.id}\n`); reported = true; } };
  const interrupt = signal => {
    if (interrupted) return;
    interrupted = true; process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    controller.abort();
    cancellation = api(`${path}/cancel`, {}, AbortSignal.timeout(5000)).catch(() => { process.stderr.write('\nCould not confirm cancellation. Check the session in Lite.\n'); });
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  try {
    const stream = await fetch(`${base}/api${path}/events`, { signal: controller.signal });
    if (!stream.ok) throw new Error('Could not connect to session stream.');
    const accepted = await api(`${path}/messages`, { content: prompt }, controller.signal); started = true;
    if (typeof accepted?.messageId !== 'string' || !accepted.messageId.trim()) {
      throw new Error('The Lite server did not return an accepted message ID. Update the server and check the session in Lite before retrying.');
    }
    let buffer = '', matched = false;
    const decoder = new TextDecoder();
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const line = frame.split('\n').find(value => value.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.sessionId !== session.id) continue;
        // A previous run may finish after subscribing but before this POST is accepted.
        // Ignore every event before our exact user-message boundary, including done/errors.
        if (!matched) {
          if (event.type !== 'message' || event.data?.role !== 'user' || event.data.id !== accepted.messageId) continue;
          matched = true;
        }
        if (options.has('--json')) console.log(JSON.stringify(event));
        else if (event.type === 'delta') process.stdout.write(event.data.delta);
        else if (event.type === 'tool' && event.data.tool.status === 'running') process.stderr.write(`\n  ≋ ${event.data.tool.name}\n`);
        if (event.type === 'error') {
          process.exitCode = 1;
          if (!options.has('--json')) process.stderr.write(`\n${event.data.message}\n`);
        }
        if (event.type === 'permission') {
          const permission = event.data;
          if (!process.stdin.isTTY) {
            await api(`${path}/permissions/${permission.id}`, { decision: 'deny' }, controller.signal);
            process.stderr.write(`\nDenied ${permission.tool}: interactive approval required (or explicitly use --auto).\n`);
          } else {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const answer = await rl.question(`\nAllow ${permission.tool} ${JSON.stringify(permission.args)}? [y/N] `, { signal: controller.signal });
              await api(`${path}/permissions/${permission.id}`, { decision: /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny' }, controller.signal);
            } finally { rl.close(); }
          }
        }
        if (event.type === 'done') {
          finished = true;
          if (event.data.status === 'error') process.exitCode = 1;
          if (!options.has('--json')) process.stdout.write('\n');
          reportSession(); return;
        }
      }
    }
    throw new Error('The session stream closed before completion. Check the session in Lite before retrying.');
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    controller.abort();
    if (cancellation) await cancellation;
    if (interrupted || (started && !finished)) reportSession();
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
}

try {
  parse();
  if (command === 'help') console.log(`
≋ Lite — your ideas, up to speed.

  lite [serve]              Start the local app
  lite run "your prompt"    Run a coding task on a running server
  lite sessions            List recent sessions
  lite models              List available models
  lite export <session>    Export a session as JSON

Server: --port 3210, --workspace PATH
Client: --url URL (or LITE_URL)
Run:    --model ID, --provider ID, --session ID, --plan, --auto, --json
Models: --provider ID

--session continues existing settings; model, provider, and permission
flags cannot override it. --json emits newline-delimited run events.
Tools ask for approval by default. --auto explicitly allows shell
commands and edits; it is not a sandbox. Keys stay server-side.
`);
  else if (command === 'serve') {
    const entry = existsSync(resolve(root, 'dist/server/index.js')) ? ['dist/server/index.js'] : ['--import', 'tsx', 'server/index.ts'];
    const child = spawn(process.execPath, entry.map(value => value.startsWith('dist/') || value.startsWith('server/') ? resolve(root, value) : value), {
      cwd: root, stdio: 'inherit', env: { ...process.env, LITE_WORKSPACE: option('--workspace', process.cwd()), LITE_PORT: option('--port', process.env.LITE_PORT || '3210') },
    });
    child.on('error', error => { console.error(`Lite: ${error.message}`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
    process.on('SIGINT', () => child.kill('SIGINT')); process.on('SIGTERM', () => child.kill('SIGTERM'));
  } else if (command === 'run') await runPrompt(positional[0]);
  else if (command === 'sessions') {
    for (const session of (await api('/sessions')).sessions) console.log(`${session.id}  ${session.status.padEnd(8)}  ${session.title}`);
  } else if (command === 'models') {
    const provider = option('--provider');
    const data = await api(`/models${provider ? '?providerId=' + encodeURIComponent(provider) : ''}`);
    if (data.error) throw new Error(data.error);
    for (const model of data.models) console.log(`${model.id}  (${model.providerId})`);
  } else if (command === 'export') console.log(JSON.stringify(await api(`/sessions/${encodeURIComponent(positional[0])}/export`), null, 2));
} catch (error) {
  console.error(`Lite: ${error.cause?.code === 'ECONNREFUSED' ? 'Start the local server with lite serve first.' : error.message}`);
  process.exitCode = process.exitCode || 1;
}
