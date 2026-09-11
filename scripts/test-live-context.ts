import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { Message, Provider } from '../shared/types.js';
import type { RequestUsage } from '../shared/usage.js';

// Explicit opt-in: real provider requests incur usage. All sessions and history
// live in a temporary store, never in the user's installed application.
if (process.env.LITESPEED_LIVE !== '1') throw new Error('Set LITESPEED_LIVE=1 to run paid gateway tests.');
const baseUrl = process.env.LITELLM_BASE_URL, apiKey = process.env.LITELLM_API_KEY;
const driver = process.env.LITESPEED_TEST_DRIVER, worker = process.env.LITESPEED_TEST_WORKER;
if (!baseUrl || !driver || !worker) throw new Error('Set LITELLM_BASE_URL, LITESPEED_TEST_DRIVER and LITESPEED_TEST_WORKER (and LITELLM_API_KEY if required).');
const output = resolve(process.env.LITESPEED_LIVE_RESULTS || 'test-results/live-context');
await mkdir(output, { recursive: true });
const results: unknown[] = [];
const expected = { project: 'harbor-lantern', port: 43127, retryCount: 7, color: 'cerulean' };
const brief = 'Return only a JSON object with the four decisions from the earlier conversation: project, port, retryCount, color. Do not use tools or invent missing values.';
function seed(id: string): Message[] {
  const filler = Array.from({ length: 480 }, (_, i) => `Archived observation ${i}: the old benchmark inspected module ${i % 43}, recorded ${i * 17 + 3} samples, and completed a read-only comparison. These notes do not change the agreed configuration.\n`).join('');
  return [
    { id: randomUUID(), sessionId: id, role: 'user', content: `Remember these final decisions for this task: ${JSON.stringify(expected)}. Preserve all four values through context compaction.`, createdAt: 1 },
    { id: randomUUID(), sessionId: id, role: 'assistant', content: 'I recorded the four decisions.', createdAt: 2 },
    { id: randomUUID(), sessionId: id, role: 'user', content: 'Review the historical benchmark notes, without changing our decisions.', createdAt: 3 },
    { id: randomUUID(), sessionId: id, role: 'assistant', content: filler, createdAt: 4 },
  ];
}

const kinds = ['single', 'sidekick-fusion', 'team-fusion', 'expert-fusion'] as const;
for (const kind of kinds) for (const compact of [false, true]) {
  const workflow=process.env.LITESPEED_LIVE_WORKFLOW==='1';
  const name = `${kind}-${compact ? 'compact' : 'baseline'}${workflow?'-tools':''}`;
  if (process.env.LITESPEED_LIVE_CASES && !process.env.LITESPEED_LIVE_CASES.split(',').includes(name)) continue;
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-live-context-')));
  const store = new Store(join(directory, 'state'));
  const checker=`import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nassert.deepEqual(JSON.parse(readFileSync('decisions.json','utf8')),${JSON.stringify(expected)});\nconsole.log('All four decisions verified.');\n`;
  const packageJson=JSON.stringify({type:'module',scripts:{test:'node check.mjs'}});
  if(workflow){await writeFile(join(directory,'package.json'),packageJson);await writeFile(join(directory,'check.mjs'),checker);}
  const provider: Provider = { id: 'live', name: 'Live gateway', kind: 'openai', baseUrl, apiKey, contextWindows: { [driver]: 200000, [worker]: compact ? 16384 : 200000 } };
  store.saveSettings({ providers: [provider], defaultProvider: provider.id, defaultModel: kind === 'single' ? worker : driver, workspace: directory, memoryEnabled: false, permissionMode: 'auto' });
  const { app, runner, bus } = createApp({ store });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, `${path}: HTTP ${response.status}`); return response.json();
  };
  let targetId = '', rootId = '', unsubscribe = () => {};
  const timer = setTimeout(() => runner.stopAll(), 6 * 60_000);
  const started = Date.now();
  console.log(`Starting ${name}`);
  try {
    const route = { providerId: 'live', model: worker };
    const architecture = kind === 'single' ? null : kind === 'sidekick-fusion' ? { kind, sidekick: route } : kind === 'team-fusion' ? { kind, worker: route } : { kind, expert: route };
    const session = await post('/sessions', { architecture, permissionMode: 'auto', workspace: directory }); rootId = session.id;
    if (kind === 'single') { targetId = session.id; store.replaceMessages(targetId, seed(targetId)); }
    else unsubscribe = bus.subscribe(session.id, event => {
      if (event.type !== 'delegation') return;
      const task = event.data as { status: string; childSessionId: string };
      if (task.status !== 'running' || targetId) return;
      targetId = task.childSessionId;
      store.replaceMessages(targetId, [...seed(targetId), ...store.messages(targetId)]);
    });
    const assignment=workflow?'Read package.json. Write decisions.json containing the four decisions from the earlier conversation (project, port, retryCount, color). Run npm test to verify it. Only create decisions.json; do not change package.json or check.mjs or any other file, and do not use network or install dependencies. Finish by returning only the JSON you wrote.':brief;
    await post(`/sessions/${session.id}/messages`, { content: kind === 'single' ? assignment : `Call ${kind === 'sidekick-fusion' ? 'sidekick' : 'delegate'} exactly once with this brief: ${assignment} The worker has the relevant earlier conversation in this test. After it returns, repeat its JSON only. Do not perform other work.`, attachments: [] });
    await runner.whenIdle();
    assert(targetId, 'The driver did not delegate the task.');
    assert.equal(store.session(session.id).status, 'idle');
    const messages = store.messages(targetId);
    const summary = messages.find(message => message.role === 'system' && message.content.startsWith('Session context summary'));
    assert.equal(Boolean(summary), compact, 'Unexpected compaction decision.');
    if (summary) for (const value of Object.values(expected)) assert(summary.content.includes(String(value)), `Summary lost ${value}`);
    const answer = messages.findLast(message => message.role === 'assistant' && message.content)?.content || '';
    const object = answer.match(/\{[^{}]*\}/)?.[0]; assert(object, 'No JSON answer.');
    assert.deepEqual(JSON.parse(object), expected, 'Continuation lost prior decisions.');
    if(workflow){
      assert.deepEqual(JSON.parse(await readFile(join(directory,'decisions.json'),'utf8')),expected);
      assert.equal(await readFile(join(directory,'check.mjs'),'utf8'),checker,'The checker was modified.');
      assert.equal(await readFile(join(directory,'package.json'),'utf8'),packageJson,'The test command was modified.');
      const checks=messages.flatMap(message=>message.toolCalls??[]).filter(call=>call.execution?.checkKey);
      assert(checks.some(call=>call.execution?.command==='npm test'&&call.execution.status==='exited'&&call.execution.exitCode===0),'The model did not execute a passing check.');
    }
    if (kind !== 'single') assert.equal(runner.delegations.list(session.id)[0].status, 'completed');
    const requests = (store.db.prepare('SELECT data FROM request_usage WHERE root_session_id=? ORDER BY rowid').all(session.id) as { data: string }[]).map(row => JSON.parse(row.data) as RequestUsage);
    assert(requests.every(request => request.rootSessionId === session.id && request.usage), 'Missing session-attributed usage.');
    assert.equal(requests.some(request => request.phase === 'compaction'), compact);
    const result = { name, status: 'passed', rootId, targetId, durationMs: Date.now() - started, answer: JSON.parse(object), originalChars: JSON.stringify(seed(targetId)).length, retainedChars: JSON.stringify(messages).length, summary: summary?.content, requests };
    results.push(result); await writeFile(join(output, `${name}.json`), JSON.stringify(result, null, 2));
    console.log(`Passed ${name}: ${requests.length} real requests, ${result.originalChars} -> ${result.retainedChars} history characters`);
  } catch (error) {
    const diagnostic = { name, status: 'failed', error: String(error), rootId, targetId, messages: targetId ? store.messages(targetId) : [], delegations: rootId ? runner.delegations.list(rootId) : [] };
    await writeFile(join(output, `${name}.json`), JSON.stringify(diagnostic, null, 2)); throw error;
  } finally {
    clearTimeout(timer); unsubscribe(); runner.stopAll(); await runner.whenIdle();
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    store.close(); await rm(directory, { recursive: true, force: true });
  }
}
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
