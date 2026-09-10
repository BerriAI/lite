#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ensureTuiServer } from './tui-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.argv.slice(2);
const optionArgs = raw.includes('--') ? raw.slice(0, raw.indexOf('--')) : raw;
const help = ['help', '--help', '-h'].includes(raw[0]) || optionArgs.some(value => value === '--help' || value === '-h');
const command = help ? 'help' : !raw.length || raw[0].startsWith('--') ? 'tui' : raw[0];
const options = new Map();
const positional = [];
let base;
const valueOptions = new Set(['--url', '--port', '--workspace', '--model', '--provider', '--session', '--profile', '--skills', '--days']);
const booleanOptions = new Set(['--plan', '--build', '--auto', '--json', '--reindex']);
const supported = {
  serve: new Set(['--port', '--workspace']),
  run: new Set(['--url', '--model', '--provider', '--session', '--profile', '--skills', '--plan', '--build', '--auto', '--json']),
  tui: new Set(['--url', '--workspace', '--model', '--provider', '--session', '--plan', '--build', '--auto']),
  profiles: new Set(['--url', '--workspace', '--json']),
  sessions: new Set(['--url']), models: new Set(['--url', '--provider']), export: new Set(['--url']),
  plugin: new Set(['--url', '--workspace', '--json']),
  usage: new Set(['--url', '--days', '--json']),
  doctor: new Set(['--url', '--json', '--reindex']),
};
const pluginSubcommands = new Set(['plan', 'install', 'list', 'remove']);
const option = (name, fallback) => options.get(name) ?? fallback;

function parse() {
  if (command === 'help') return;
  if (!supported[command]) throw new Error(`Unknown command: ${command}. Use speedrail --help.`);
  const args = raw[0] === command ? raw.slice(1) : raw;
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (!arg.startsWith('-') || positionalOnly) { positional.push(arg); continue; }
    if (!valueOptions.has(arg) && !booleanOptions.has(arg)) throw new Error(`Unknown option: ${arg}. Use speedrail --help.`);
    if (!supported[command].has(arg)) throw new Error(`${arg} is not supported by speedrail ${command}.`);
    if (options.has(arg)) throw new Error(`Duplicate option: ${arg}.`);
    if (valueOptions.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options.set(arg, value);
    } else options.set(arg, true);
  }
  if (command === 'run' && (positional.length !== 1 || !positional[0].trim())) throw new Error('Usage: speedrail run "your prompt" [--model ID]');
  if (command === 'export' && (positional.length !== 1 || !positional[0].trim())) throw new Error('Usage: speedrail export <session-id>');
  if (command === 'plugin') {
    const usage = 'Usage: speedrail plugin plan <dir> | install <dir> | list | remove <name>';
    if (!pluginSubcommands.has(positional[0])) throw new Error(usage);
    const wantsArgument = positional[0] !== 'list';
    if (positional.length !== (wantsArgument ? 2 : 1) || (wantsArgument && !positional[1].trim())) throw new Error(usage);
  }
  if (!['run', 'export', 'plugin'].includes(command) && positional.length) throw new Error(`Unexpected argument: ${positional[0]}. Use speedrail --help.`);
  if (command === 'usage' && options.has('--days') && (!/^\d+$/.test(option('--days')) || Number(option('--days')) < 1 || Number(option('--days')) > 90)) throw new Error('--days must be an integer between 1 and 90.');
  if (command === 'run' && options.has('--session')) {
    const override = ['--model', '--provider', '--profile', '--skills', '--plan', '--build', '--auto'].find(name => options.has(name));
    if (override) throw new Error(`${override} cannot be combined with --session. Change the existing session settings in Speedrail, or start a new session.`);
  }
  if (options.has('--plan') && options.has('--build')) throw new Error('--plan and --build cannot be combined.');
  if (options.has('--profile') && !validProfileId(option('--profile'))) throw new Error('--profile requires a lowercase ID of 1–64 letters, digits, or hyphens, starting with a letter or digit.');
  const skills = selectedSkills();
  if (options.has('--profile') || skills.length) {
    if (options.has('--provider') !== options.has('--model')) throw new Error('Profile or skill selection requires both --provider and --model, or neither. Profile defaults are a provider/model pair.');
    if (['--provider', '--model'].some(name => options.has(name) && !option(name).trim())) throw new Error('Profile provider/model overrides must both be nonblank.');
  }
  if (options.has('--workspace') && !option('--workspace').trim()) throw new Error('--workspace requires a nonblank path.');
  const port = option('--port', process.env.SPEEDRAIL_PORT || '3210');
  if (command === 'serve' && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('--port must be an integer between 1 and 65535.');
  base = option('--url', process.env.SPEEDRAIL_URL || `http://localhost:${process.env.SPEEDRAIL_PORT || 3210}`);
  if (command !== 'serve') {
    let url; try { url = new URL(base); } catch { throw new Error('--url must be a valid HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('--url must be an HTTP or HTTPS URL without credentials, a query, or a fragment.');
    base = base.replace(/\/+$/, '');
  }
}

// Model- and configuration-authored content is data, never terminal escape sequences.
function terminalText(value, multiline = false) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, character => {
    if (multiline && (character === '\n' || character === '\t')) return character;
    const code = character.codePointAt(0);
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

async function api(path, body, signal, method) {
  const response = await fetch(`${base}/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'X-Speedrail-Client': 'cli' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`The Speedrail server returned an invalid response (HTTP ${response.status}).`); }
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

function validProfileId(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value); }
function selectedSkills() {
  const value = option('--skills');
  if (value === undefined || value === 'none') return [];
  const ids = value.split(',');
  if (ids.length > 8 || ids.some(id => !validProfileId(id))) throw new Error('--skills requires up to 8 comma-separated lowercase IDs (1–64 letters, digits, or hyphens); use --skills none for no skills.');
  if (new Set(ids).size !== ids.length) throw new Error('--skills contains duplicate IDs. Select each skill only once.');
  if (ids.includes('none')) throw new Error('--skills none cannot be combined with other skill IDs.');
  return ids;
}
async function profileCatalog(workspace) {
  const catalog = await api(`/profiles?workspace=${encodeURIComponent(workspace)}`);
  if (!catalog || typeof catalog.workspace !== 'string' || !catalog.workspace.trim() || typeof catalog.revision !== 'string' || !/^[a-f0-9]{64}$/.test(catalog.revision) ||
      !Array.isArray(catalog.profiles) || catalog.profiles.length > 32 || !Array.isArray(catalog.skills) || catalog.skills.length > 64 || !Array.isArray(catalog.diagnostics))
    throw new Error('The Speedrail server returned an invalid profile catalog. Update the server and retry.');
  for (const entries of [catalog.profiles, catalog.skills]) {
    if (entries.some(entry => !entry || !validProfileId(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200) || new Set(entries.map(entry => entry.id)).size !== entries.length)
      throw new Error('The Speedrail server returned invalid or duplicate profile/skill IDs. Update the server and retry.');
  }
  const text = (value, limit) => typeof value === 'string' && value.length <= limit;
  if (catalog.profiles.some(profile => !Array.isArray(profile.tools) || profile.tools.some(tool => !text(tool, 64)) ||
        (profile.description !== undefined && !text(profile.description, 2000)) ||
        (profile.defaultMode !== undefined && !['plan', 'build'].includes(profile.defaultMode)) ||
        (profile.defaultModel !== undefined && (!profile.defaultModel || !text(profile.defaultModel.providerId, 64) || !text(profile.defaultModel.model, 250))) ||
        (profile.skills !== undefined && (!Array.isArray(profile.skills) || profile.skills.length > 64 || profile.skills.some(id => !validProfileId(id)) || new Set(profile.skills).size !== profile.skills.length))) ||
      catalog.skills.some(skill => !text(skill.description, 2000)) ||
      catalog.diagnostics.length > 65 || catalog.diagnostics.some(item => !item || !text(item.path, 4096) || !text(item.code, 100) || !text(item.message, 2000)))
    throw new Error('The Speedrail server returned an invalid profile catalog. Update the server and retry.');
  return catalog;
}
function catalogDiagnostics(catalog) {
  for (const diagnostic of catalog.diagnostics) process.stderr.write(`Profile catalog: ${terminalText(diagnostic?.path)} (${terminalText(diagnostic?.code)}): ${terminalText(diagnostic?.message)}\n`);
}
async function listProfiles() {
  const catalog = await profileCatalog(resolve(option('--workspace', process.cwd())));
  if (options.has('--json')) { console.log(JSON.stringify(catalog)); return; }
  console.log(`Workspace: ${terminalText(catalog.workspace)}\nProfiles:`);
  if (!catalog.profiles.length) console.log('  None configured.');
  for (const profile of catalog.profiles) {
    const defaults = [profile.defaultMode, profile.defaultModel ? `${profile.defaultModel.providerId}/${profile.defaultModel.model}` : undefined].filter(Boolean);
    console.log(`  ${profile.id}  ${terminalText(profile.name)}${defaults.length ? `  [${defaults.map(value => terminalText(value)).join(', ')}]` : ''}`);
    if (profile.description) console.log(`    ${terminalText(profile.description)}`);
    if (profile.skills?.length) console.log(`    Recommended only (not selected): ${profile.skills.map(value => terminalText(value)).join(', ')}`);
  }
  console.log('Skills:');
  if (!catalog.skills.length) console.log('  None configured.');
  for (const skill of catalog.skills) console.log(`  ${skill.id}  ${terminalText(skill.name)}${skill.description ? ` — ${terminalText(skill.description)}` : ''}`);
  catalogDiagnostics(catalog);
  console.log('Skills activate only when explicitly selected with --skills. Profiles never grant tool approval.');
}
async function newRunSession() {
  const profileId = option('--profile', null), skillIds = selectedSkills();
  const explicitChoice = options.has('--profile') || options.has('--skills');
  const activeChoice = profileId !== null || skillIds.length > 0;
  const input = { workspace: process.cwd(), model: option('--model'), providerId: option('--provider'),
    ...(options.has('--plan') ? { mode: 'plan' } : options.has('--build') || !activeChoice ? { mode: 'build' } : {}),
    permissionMode: options.has('--auto') ? 'auto' : 'ask' };
  if (explicitChoice) {
    const catalog = await profileCatalog(input.workspace);
    if (profileId !== null && !catalog.profiles.some(profile => profile.id === profileId)) throw new Error(`Unknown project profile: ${profileId}. Use speedrail profiles to inspect this workspace.`);
    for (const id of skillIds) if (!catalog.skills.some(skill => skill.id === id)) throw new Error(`Unknown project skill: ${id}. Use speedrail profiles to inspect this workspace.`);
    catalogDiagnostics(catalog);
    input.workspace = catalog.workspace;
    input.profile = { profileId, skillIds, catalogRevision: catalog.revision };
  }
  return api('/sessions', input);
}
async function runPrompt(prompt) {
  const existingId = option('--session');
  const session = existingId ? { id: existingId } : await newRunSession();
  const path = `/sessions/${encodeURIComponent(session.id)}`;
  const controller = new AbortController();
  let cancellation, interrupted = false, started = false, finished = false, reported = false, activeInput;
  const inputTasks = new Set(), seenQuestions = new Set(), seenPermissions = new Set();
  const reportSession = () => { if (!reported) { process.stderr.write(`\nSession: ${terminalText(session.id)}\n`); reported = true; } };
  const dismissInput = (kind, id) => {
    if (!activeInput || (kind && (activeInput.kind !== kind || activeInput.id !== id))) return;
    const input = activeInput; activeInput = undefined;
    input.controller.abort(); input.rl.close();
  };
  const cancelRun = (code, message) => {
    if (interrupted) return;
    interrupted = true; process.exitCode = code;
    if (message) process.stderr.write(`\n${message}\n`);
    controller.abort(); dismissInput();
    cancellation = api(`${path}/cancel`, {}, AbortSignal.timeout(5000)).catch(() => { process.stderr.write('\nCould not confirm cancellation. Check the session in Speedrail.\n'); });
  };
  const interrupt = signal => cancelRun(signal === 'SIGTERM' ? 143 : 130);
  // Read input in a separate task: the SSE reader must continue consuming resolutions/done.
  const promptInput = (kind, id, ask) => {
    dismissInput();
    const input = { kind, id, controller: new AbortController(), rl: createInterface({ input: process.stdin, output: process.stderr }) };
    activeInput = input;
    input.rl.once('close', () => {
      if (activeInput === input && !input.controller.signal.aborted) cancelRun(1, 'Input closed before an answer was submitted. The run was cancelled; use Speedrail or an interactive terminal to continue.');
    });
    input.rl.once('SIGINT', () => interrupt('SIGINT'));
    const task = (async () => {
      try { await ask(input.rl, input.controller.signal); }
      catch (error) {
        if (!input.controller.signal.aborted && !interrupted) {
          if (error.status === 409) process.stderr.write('\nThis request was already resolved elsewhere. Waiting for the current run.\n');
          else cancelRun(1, `Could not submit the answer: ${terminalText(error.message)}. The run was cancelled; check the session in Speedrail.`);
        }
      } finally {
        if (activeInput === input) dismissInput();
        else { input.controller.abort(); input.rl.close(); }
      }
    })();
    inputTasks.add(task); void task.finally(() => inputTasks.delete(task));
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  try {
    const stream = await fetch(`${base}/api${path}/events`, { signal: controller.signal });
    if (!stream.ok) throw new Error('Could not connect to session stream.');
    const accepted = await api(`${path}/messages`, { content: prompt }, controller.signal); started = true;
    if (typeof accepted?.messageId !== 'string' || !accepted.messageId.trim()) {
      throw new Error('The Speedrail server did not return an accepted message ID. Update the server and check the session in Speedrail before retrying.');
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
        if (event.type === 'question' && (event.data?.turnId !== accepted.messageId || event.data.sessionId !== session.id)) continue;
        if (options.has('--json')) console.log(JSON.stringify(event));
        else if (event.type === 'delta') process.stdout.write(terminalText(event.data.delta, true));
        else if (event.type === 'tool' && event.data.tool.status === 'running') process.stderr.write(`\n  ≋ ${terminalText(event.data.tool.name)}\n`);
        if (event.type === 'error') {
          process.exitCode = 1;
          if (!options.has('--json')) process.stderr.write(`\n${terminalText(event.data.message, true)}\n`);
        }
        if (event.type === 'permission' && !seenPermissions.has(event.data.id)) {
          const permission = event.data; seenPermissions.add(permission.id);
          if (!process.stdin.isTTY) {
            await api(`${path}/permissions/${encodeURIComponent(permission.id)}`, { decision: 'deny' }, controller.signal);
            process.stderr.write(`\nDenied ${terminalText(permission.tool)}: interactive approval required (or explicitly use --auto).\n`);
          } else promptInput('permission', permission.id, async (rl, signal) => {
            const answer = await rl.question(`\nAllow ${terminalText(permission.tool)} ${terminalText(JSON.stringify(permission.args))}? [y/N] `, { signal });
            if (!signal.aborted) await api(`${path}/permissions/${encodeURIComponent(permission.id)}`, { decision: /^y(es)?$/i.test(answer.trim()) ? 'allow' : 'deny' }, signal);
          });
        }
        if (event.type === 'permission_resolved') dismissInput('permission', event.data.id);
        if (event.type === 'question' && !seenQuestions.has(event.data.id)) {
          const question = event.data; seenQuestions.add(question.id);
          if (!process.stdin.isTTY) {
            cancelRun(1, 'This run needs your answer. Non-interactive input cannot answer questions, even with --auto. The run was cancelled; use the Speedrail app or rerun in an interactive terminal.');
            return;
          }
          promptInput('question', question.id, async (rl, signal) => {
            process.stderr.write(`\n${terminalText(question.question, true)}\n`);
            question.options.forEach((item, index) => process.stderr.write(`  ${index + 1}. ${terminalText(item.label)}${item.description ? ` — ${terminalText(item.description)}` : ''}\n`));
            for (;;) {
              const value = (await rl.question(question.options.length ? 'Choose a number, or type a custom answer (text: forces custom): ' : 'Your answer: ', { signal })).trim();
              if (signal.aborted) return;
              const custom = value.startsWith('text:');
              const text = custom ? value.slice(5).trim() : value;
              const numeric = !custom && question.options.length > 0 && /^\d+$/.test(value);
              const item = numeric ? question.options[Number(value) - 1] : undefined;
              if (numeric && !item) { process.stderr.write('Choose a listed number, or use text: for a custom answer.\n'); continue; }
              if (!item && (!text || text.length > 8000)) { process.stderr.write('Enter a nonblank answer of at most 8000 characters.\n'); continue; }
              const answer = item ? { kind: 'option', optionId: item.id } : { kind: 'text', text };
              await api(`${path}/questions/${encodeURIComponent(question.id)}/answer`, answer, signal); return;
            }
          });
        }
        if (event.type === 'question_resolved') {
          dismissInput('question', event.data.id);
          if (seenQuestions.has(event.data.id) && event.data.status !== 'answered') process.exitCode = process.exitCode || 1;
        }
        if (event.type === 'done') {
          finished = true; dismissInput();
          if (event.data.status === 'error') process.exitCode = 1;
          if (!options.has('--json')) process.stdout.write('\n');
          reportSession(); return;
        }
      }
    }
    throw new Error('The session stream closed before completion. Check the session in Speedrail before retrying.');
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    controller.abort(); dismissInput();
    await Promise.all(inputTasks);
    if (cancellation) await cancellation;
    if (interrupted || (started && !finished)) reportSession();
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
}

// Plugin packages: everything runs against the server API (like run/profiles);
// local directories only — clone git packages first. The plan/install output
// escapes all package-controlled text before it reaches the terminal.
function printPlan(plan) {
  console.log(`Plugin: ${terminalText(plan.plugin.name)}@${terminalText(plan.plugin.version)}${plan.plugin.description ? ` — ${terminalText(plan.plugin.description)}` : ''}`);
  if (!plan.actions.length) console.log('  No installable items.');
  for (const action of plan.actions) {
    const status = action.conflict === 'exists' ? 'SKIP (exists)' : action.conflict === 'same-plugin-update' ? 'update' : 'add';
    console.log(`  ${status.padEnd(14)} ${action.kind.padEnd(8)} ${terminalText(action.name)}  -> ${terminalText(action.target)}`);
  }
  for (const warning of plan.warnings) process.stderr.write(`Warning: ${terminalText(warning)}\n`);
  for (const key of plan.unmapped ?? []) process.stderr.write(`Unmapped compatible-manifest key ignored: ${terminalText(key)}\n`);
}
async function pluginCommand(subcommand, argument) {
  const root = resolve(option('--workspace', process.cwd()));
  if (subcommand === 'plan' || subcommand === 'install') {
    const data = await api(`/plugins/${subcommand}`, { source: resolve(argument), workspace: root });
    if (options.has('--json')) { console.log(JSON.stringify(data)); return; }
    printPlan(data.plan);
    if (subcommand === 'install') {
      const landed = data.plan.actions.filter(action => action.conflict !== 'exists');
      console.log(`Installed ${terminalText(data.plugin.name)}@${terminalText(data.plugin.version)}: ${landed.length} item${landed.length === 1 ? '' : 's'} landed.`);
      if (landed.some(action => action.kind === 'mcp')) console.log('MCP servers were installed DISABLED; connect them explicitly in Settings.');
      if (landed.some(action => action.kind === 'hook')) console.log('Hooks were added to Settings; project workspaces still require explicit trust.');
    } else console.log('Dry run only. Use speedrail plugin install to apply.');
  } else if (subcommand === 'list') {
    const data = await api('/plugins');
    if (options.has('--json')) { console.log(JSON.stringify(data)); return; }
    const entries = Object.entries(data.plugins ?? {});
    if (!entries.length) { console.log('No plugins installed.'); return; }
    for (const [name, entry] of entries) console.log(`${terminalText(name)}@${terminalText(entry.version)}  ${entry.items?.length ?? 0} item${entry.items?.length === 1 ? '' : 's'}  ${terminalText(entry.workspace)}`);
  } else {
    const data = await api(`/plugins/${encodeURIComponent(argument)}?workspace=${encodeURIComponent(root)}`, undefined, undefined, 'DELETE');
    if (options.has('--json')) { console.log(JSON.stringify(data)); return; }
    for (const item of data.removed) console.log(`Removed ${item.kind}: ${terminalText(item.target)}`);
    for (const warning of data.warnings) process.stderr.write(`Warning: ${terminalText(warning)}\n`);
    console.log(`Uninstalled ${terminalText(argument)} (${data.removed.length} item${data.removed.length === 1 ? '' : 's'} removed).`);
  }
}

// Usage report (5.1): renders the server's day/provider/model aggregates.
// Token counts are provider-reported; costs are NOT computed (no rate card in
// v1), which the footer states plainly rather than guessing at prices.
async function usageCommand() {
  const days = option('--days', '30');
  const data = await api(`/usage?days=${encodeURIComponent(days)}`);
  if (options.has('--json')) { console.log(JSON.stringify(data)); return; }
  if (!data.days?.length) { console.log(`No recorded usage in the last ${days} day${days === '1' ? '' : 's'}.`); return; }
  const number = value => Number(value ?? 0).toLocaleString('en-US');
  const anyCached = data.days.some(day => day.entries.some(entry => entry.cachedTokens !== undefined));
  for (const day of data.days) {
    console.log(`${terminalText(day.day)}`);
    for (const entry of day.entries) console.log(`  ${terminalText(entry.providerId)}/${terminalText(entry.model)}  in ${number(entry.inputTokens)}  out ${number(entry.outputTokens)}${anyCached ? `  cached ${entry.cachedTokens !== undefined ? number(entry.cachedTokens) : '—'}` : ''}  req ${number(entry.requests)}`);
    console.log(`  day total  in ${number(day.totals.inputTokens)}  out ${number(day.totals.outputTokens)}${anyCached ? `  cached ${day.totals.cachedTokens !== undefined ? number(day.totals.cachedTokens) : '—'}` : ''}  req ${number(day.totals.requests)}`);
  }
  console.log(`Total (${days} day${days === '1' ? '' : 's'}): in ${number(data.totals.inputTokens)}  out ${number(data.totals.outputTokens)}${data.totals.cachedTokens !== undefined ? `  cached ${number(data.totals.cachedTokens)}` : ''}  req ${number(data.totals.requests)}`);
  console.log('Token counts are provider-reported. Costs are not computed (no rate card).');
}

// Doctor (5.2): prints the server's REDACTED diagnostics (hosts only, hasKey
// booleans, counts). --reindex additionally rebuilds the derived search index.
async function doctorCommand() {
  const data = await api('/doctor');
  if (options.has('--json') && !options.has('--reindex')) { console.log(JSON.stringify(data)); }
  else if (!options.has('--json')) {
    console.log(`Speedrail ${terminalText(data.version)}  node ${terminalText(data.node)}  ${terminalText(data.platform)}`);
    const database = data.database;
    console.log(`Database: ${terminalText(database.path)}${database.exists ? '' : '  (missing)'}`);
    console.log(`  size ${Number(database.sizeBytes).toLocaleString('en-US')} bytes  sessions ${database.sessions}  messages ${database.messages}  integrity ${terminalText(database.integrity)}`);
    console.log('Providers:');
    if (!data.settings.providers.length) console.log('  None configured.');
    for (const provider of data.settings.providers) console.log(`  ${terminalText(provider.id)}  ${terminalText(provider.kind)}  host ${terminalText(provider.host)}  key ${provider.hasKey ? 'configured' : 'none'}`);
    console.log('MCP servers:');
    if (!data.settings.mcpServers.length) console.log('  None configured.');
    for (const server of data.settings.mcpServers) console.log(`  ${terminalText(server.name)}  (${terminalText(server.transport)})`);
    console.log(`Settings: memory ${data.settings.memoryEnabled ? 'on' : 'off'}  hooks ${data.settings.hookCount}  sidecars ${data.settings.sidecarCount}  plugins ${data.settings.pluginCount}  permission rules ${data.settings.permissionRuleCount}`);
    console.log(`Workspace: ${terminalText(data.workspace.path)}  ${data.workspace.exists ? 'exists' : 'MISSING'}${data.workspace.isGit ? '  git' : ''}`);
    console.log('This report is redacted by construction: no keys, no env values, no full URLs, no message content.');
  }
  if (options.has('--reindex')) {
    const result = await api('/doctor/reindex', {});
    if (options.has('--json')) console.log(JSON.stringify({ doctor: data, reindex: result }));
    else console.log(`Search index rebuilt: ${result.sessions} session${result.sessions === 1 ? '' : 's'}, ${result.parts} indexed part${result.parts === 1 ? '' : 's'}.`);
  }
}

try {
  parse();
  if (command === 'help') console.log(`
≋ Speedrail — your ideas, up to speed.

  speedrail [options]            Open terminal chat in the current directory
  speedrail serve                Start the local web server
  speedrail run "your prompt"    Run a coding task on a running server
  speedrail tui                  Alias for speedrail
  speedrail sessions            List recent sessions
  speedrail models              List available models
  speedrail profiles            List project profiles, skills, and diagnostics
  speedrail export <session>    Export a session as JSON
  speedrail plugin plan <dir>       Dry-run: what a local plugin package would install
  speedrail plugin install <dir>    Install a local plugin package (plan + apply)
  speedrail plugin list             List installed plugins
  speedrail plugin remove <name>    Uninstall exactly the plugin's recorded items
  speedrail usage               Provider-reported token usage by day and model
  speedrail doctor              Redacted diagnostics report (add --reindex to
                           rebuild the derived search index)

Server: --port 3210, --workspace PATH
Client: --url URL (or SPEEDRAIL_URL)
Run:    --model ID, --provider ID, --session ID, --plan, --build, --auto, --json
        --profile ID, --skills ID,ID (or none)
Speedrail:   --workspace PATH, --model ID, --provider ID, --session ID, --plan, --build, --auto
        The terminal starts its local server automatically when needed.
Models: --provider ID
Profiles: --workspace PATH (default current directory), --json
Usage:   --days N (1-90, default 30), --json. Token counts are provider-
         reported; costs are not computed (no rate card).
Doctor:  --json, --reindex (rebuild the search index; the only repair in v1)
Plugin:  --workspace PATH (default current directory), --json
         Local directories only; clone git packages first. MCP servers install
         DISABLED; hooks stay behind workspace trust; conflicts are skipped.

--session continues existing settings; model, provider, profile, skills,
mode, and permission flags cannot override it. --json emits newline-delimited
run events, or a single catalog object for speedrail profiles.
A selected profile supplies model/provider and mode defaults. Override its
model with BOTH --provider and --model; --build overrides a Plan default.
--plan and --build conflict. Unprofiled runs keep the existing Build default.
Skills default to NONE. Recommendations never activate automatically.
Profile selection uses the server's canonical catalog for the current directory.
Tools ask for approval by default. --auto explicitly allows shell
commands and edits; it is not a sandbox. Keys stay server-side.
Questions require your answer in an interactive terminal or the Speedrail app.
Non-interactive runs cancel unanswered questions, including with --auto.
`);
  else if (command === 'serve') {
    const entry = existsSync(resolve(root, 'dist/server/index.js')) ? ['dist/server/index.js'] : ['--import', 'tsx', 'server/index.ts'];
    const child = spawn(process.execPath, entry.map(value => value.startsWith('dist/') || value.startsWith('server/') ? resolve(root, value) : value), {
      cwd: root, stdio: 'inherit', env: { ...process.env, SPEEDRAIL_WORKSPACE: option('--workspace', process.cwd()), SPEEDRAIL_PORT: option('--port', process.env.SPEEDRAIL_PORT || '3210') },
    });
    child.on('error', error => { console.error(`Speedrail: ${terminalText(error.message)}`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
    process.on('SIGINT', () => child.kill('SIGINT')); process.on('SIGTERM', () => child.kill('SIGTERM'));
  } else if (command === 'tui') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('speedrail needs an interactive terminal. Use speedrail run for scripted work.');
    const forwarded = ['--url', base, '--workspace', option('--workspace', process.cwd())];
    for (const name of ['--session', '--model', '--provider']) if (options.has(name)) forwarded.push(name, option(name));
    for (const name of ['--plan', '--build', '--auto']) if (options.has(name)) forwarded.push(name);
    if (options.has('--session') && ['--model', '--provider', '--plan', '--build', '--auto'].some(name => options.has(name))) throw new Error('An existing session keeps its configuration. Use the TUI Models or Settings menu to change it.');
    const runtime = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    if (!existsSync(runtime)) throw new Error('The TUI needs the bundled Bun runtime. Run npm install in the Speedrail directory.');
    const entry = [resolve(root, 'tui/main.tsx')];
    // cwd stays at the package root so the entry resolves; the caller's
    // directory travels as --workspace.
    const started = await ensureTuiServer({ base, root, workspace: option('--workspace', process.cwd()), explicit: options.has('--url') || Boolean(process.env.SPEEDRAIL_URL) });
    if (started) process.stderr.write(`Started Speedrail at ${base}. The server stays available after you exit. Stop it with: kill ${started.pid}\n`);
    const child = spawn(runtime, [...entry, ...forwarded], { cwd: root, stdio: 'inherit', env: process.env });
    child.on('error', error => { console.error(`Speedrail: ${terminalText(error.message)}`); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
    // The TUI owns the terminal; Ctrl+C reaches it in raw mode and SIGTERM forwards.
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  } else if (command === 'run') await runPrompt(positional[0]);
  else if (command === 'profiles') await listProfiles();
  else if (command === 'sessions') {
    for (const session of (await api('/sessions')).sessions) console.log(`${session.id}  ${session.status.padEnd(8)}  ${session.title}`);
  } else if (command === 'models') {
    const provider = option('--provider');
    const data = await api(`/models${provider ? '?providerId=' + encodeURIComponent(provider) : ''}`);
    if (data.error) throw new Error(data.error);
    for (const model of data.models) console.log(`${model.id}  (${model.providerId})`);
  } else if (command === 'export') console.log(JSON.stringify(await api(`/sessions/${encodeURIComponent(positional[0])}/export`), null, 2));
  else if (command === 'plugin') await pluginCommand(positional[0], positional[1]);
  else if (command === 'usage') await usageCommand();
  else if (command === 'doctor') await doctorCommand();
} catch (error) {
  console.error(`Speedrail: ${error.cause?.code === 'ECONNREFUSED' ? 'Start the local server with speedrail serve first.' : terminalText(error.message)}`);
  process.exitCode = process.exitCode || 1;
}
