// Bounded, opt-in live comparison using providers already configured in Lite.
// Credentials stay on the server. Every arrangement gets the same fresh fixture.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  server: { type: 'string', default: 'http://127.0.0.1:3210' },
  'strong-provider': { type: 'string' }, 'strong-model': { type: 'string' },
  'cheap-provider': { type: 'string' }, 'cheap-model': { type: 'string' },
  'timeout-seconds': { type: 'string', default: '180' },
  architecture: { type: 'string', default: 'all' },
  output: { type: 'string' },
} });
for (const name of ['strong-provider', 'strong-model', 'cheap-provider', 'cheap-model']) if (!values[name]) throw new Error(`Provide --${name}. Provider IDs refer to Lite Settings; never pass credentials.`);
const timeout = Number(values['timeout-seconds']) * 1000;
if (!Number.isFinite(timeout) || timeout < 10_000 || timeout > 600_000) throw new Error('Use a timeout from 10 to 600 seconds.');
const base = new URL(values.server);
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Use a local Lite server.');
const strong = { providerId: values['strong-provider'], model: values['strong-model'] };
const cheap = { providerId: values['cheap-provider'], model: values['cheap-model'] };
if (!['all', 'single', 'sidekick-fusion', 'team-fusion', 'expert-fusion'].includes(values.architecture)) throw new Error('Choose all, single, sidekick-fusion, team-fusion, or expert-fusion.');
const output = values.output ?? join(await mkdtemp(join(tmpdir(), 'lite-fusion-comparison-')), 'results.json');
async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(`/api${path}`, base), { method, headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
const tests = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCsvLine} from './parse.js';
test('ordinary fields',()=>assert.deepEqual(parseCsvLine('a,b,c'),['a','b','c']));
test('empty and trailing fields',()=>assert.deepEqual(parseCsvLine(',a,'),['','a','']));
test('empty line',()=>assert.deepEqual(parseCsvLine(''),['']));
test('quoted commas',()=>assert.deepEqual(parseCsvLine('a,"b,c",d'),['a','b,c','d']));
test('escaped quotes',()=>assert.deepEqual(parseCsvLine('"a""b",c'),['a"b','c']));
test('unclosed quote',()=>assert.throws(()=>parseCsvLine('"abc'),SyntaxError));
test('trailing text after a quote',()=>assert.throws(()=>parseCsvLine('"abc"x'),SyntaxError));
test('quote in unquoted field',()=>assert.throws(()=>parseCsvLine('ab"c'),SyntaxError));
`;
const prompt = 'Implement parseCsvLine in parse.js, preserving its exported name. Parse one CSV record with comma separators, empty fields, quoted fields, and doubled quote escaping. Throw SyntaxError for unmatched quotes, quotes inside an unquoted field, and trailing text after a closed quote. Do not change package.json or parse.test.js. Read the tests and run npm test. Complete the implementation and verify it.';
const results = [];
for (const [architecture, route] of [[null, strong], [{ kind: 'sidekick-fusion', sidekick: cheap }, strong], [{ kind: 'team-fusion', worker: cheap }, strong], [{ kind: 'expert-fusion', expert: strong }, cheap]]) {
  if (values.architecture !== 'all' && values.architecture !== (architecture?.kind ?? 'single')) continue;
  const workspace = await mkdtemp(join(tmpdir(), `lite-live-${architecture?.kind ?? 'single'}-`));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test parse.test.js' } }));
  await writeFile(join(workspace, 'parse.js'), 'export function parseCsvLine(line) { throw new Error("Not implemented"); }\n');
  await writeFile(join(workspace, 'parse.test.js'), tests);
  let session;
  const result = { architecture: architecture?.kind ?? 'single', workspace, driver: route, ...(architecture ? { worker: architecture.sidekick ?? architecture.worker ?? architecture.expert } : {}), passed: false };
  const started = Date.now();
  try {
    session = await api('/sessions', { ...route, title: `Live Fusion comparison · ${result.architecture}`, workspace, architecture, planner: null, modelReasoning: {}, outputStyle: null, mode: 'build', permissionMode: 'auto' });
    result.sessionId = session.id;
    await api(`/sessions/${session.id}/messages`, { content: prompt });
    let detail;
    while (Date.now() - started < timeout) {
      detail = await api(`/sessions/${session.id}`);
      if (!['running', 'waiting'].includes(detail.session.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!detail || ['running', 'waiting'].includes(detail.session.status)) { result.error = 'Comparison time limit reached; the task was stopped.'; await api(`/sessions/${session.id}/cancel`, {}); }
    detail = await api(`/sessions/${session.id}`);
    const final = detail.messages.findLast(message => message.role === 'assistant');
    Object.assign(result, { status: detail.session.status, usage: final?.turnUsage, receipts: final?.receipts, invocations: detail.delegations?.map(({ id, role, status }) => ({ id, role, status })), takeovers: detail.messages.flatMap(message => message.toolCalls ?? []).filter(call => call.name === 'takeover'), errors: detail.messages.filter(message => message.error).map(message => message.error) });
    result.toolFailures = detail.messages.flatMap(message => message.toolCalls ?? []).filter(call => ['error', 'denied'].includes(call.status)).map(({ name, status, output }) => ({ name, status, output }));
    // Empty new queues start paused without a reason. Only a host hold is a
    // failure signal; the default empty queue is not an incomplete response.
    result.queueHeld = Boolean(detail.queue?.paused && detail.queue.reason);
    if (result.queueHeld) result.holdReason = detail.queue.reason;
    // Restore the independent checks so a model cannot make the quality score
    // pass by weakening its test file or package scripts.
    await writeFile(join(workspace, 'parse.test.js'), tests);
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test parse.test.js' } }));
    try { const checked = await promisify(execFile)(process.execPath, ['--test', 'parse.test.js'], { cwd: workspace, timeout: 15_000, maxBuffer: 1024 * 1024 }); result.passed = true; result.checkOutput = checked.stdout; }
    catch (error) { result.checkOutput = `${error.stdout ?? ''}\n${error.stderr ?? ''}`; }
  } catch (error) { result.error = error.message; }
  finally {
    if (session) { await api(`/sessions/${session.id}/cancel`, {}).catch(() => {}); await api(`/sessions/${session.id}`, { archived: true }, 'PATCH').catch(() => {}); }
    result.completed = result.passed && result.status === 'idle' && !result.error && !result.errors?.length && !result.queueHeld;
    result.elapsedMs = Date.now() - started; results.push(result);
    await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), limitation: 'One small task per arrangement is a smoke comparison, not a general quality or savings benchmark. Costs are only provider-reported.', results }, null, 2) + '\n');
    console.log(`${result.architecture}: ${result.completed ? 'completed and tests passed' : result.passed ? 'tests passed, task incomplete' : 'not verified'} · ${(result.elapsedMs / 1000).toFixed(1)}s`);
  }
}
console.log(`Report: ${output}`);
if (results.some(result => !result.completed)) process.exitCode = 1;
