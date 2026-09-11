import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { ExternalTools } from '../server/external.js';
import type { SidecarConfig } from '../shared/sidecars.js';
import type { ToolCall, ToolDefinition } from '../shared/types.js';

// Mirrors the hooks-runner harness: fake OpenAI provider, per-request SSE, and
// REAL node -e sidecar processes speaking newline-delimited JSON-RPC 2.0.
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const child = (body: any) => body.messages.some((m: any) => m.role === 'user' && (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : '').includes('CHILD'));
const responder = (body: string) => `node -e 'const rl=require("readline").createInterface({input:process.stdin});rl.on("line",l=>{const m=JSON.parse(l);${body}})'`;
const sidecar = (command: string, name = 'redactor'): SidecarConfig => ({ name, command, events: ['tool_call'] });

describe('sidecar extensions Runner/API integration', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  const oneCallThenText = (name: string, args: Record<string, unknown>) => (body: any, res: ServerResponse) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name, args }]);
  const toolCalls = (id: string): ToolCall[] => store.messages(id).flatMap(m => m.toolCalls ?? []);
  const notices = (id: string) => store.messages(id).filter(m => m.role === 'system').map(m => m.content);
  const setSidecars = (sidecars: SidecarConfig[]) => store.saveSettings({ sidecars });
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-sidecars-runner-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model', maxSteps: 12 });
    // One directly-advertised connected tool so a real mcp_ call can flow
    // through dispatch (mirrors the capability-runner mock lease shape).
    const definition: ToolDefinition = { type: 'function', function: { name: 'mcp_srv_echo_12345678', description: 'Echo', parameters: { type: 'object', properties: {} } } };
    const external: ExternalTools = { capture: () => ({ definitions: [definition], scope: () => 'scope-v1', assertCurrent: () => {}, execute: async () => 'Executed mcp tool', release: () => {} }) };
    const app = createApp({ store, external }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('modify: the file contains the modified content, intercepted.by is set, originalArgs preserved', async () => {
    setSidecars([sidecar(responder('const r=m.params.tool==="write_file"?{action:"modify",args:{...m.params.args,content:m.params.args.content.replace("SECRET","[redacted]")},reason:"Redacted a secret"}:{action:"pass"};console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r}))'))]);
    respond = oneCallThenText('write_file', { path: 'out.txt', content: 'hold my SECRET token' });
    const s = await create(); await run(s.id, 'Write the file');
    expect(await readFile(join(directory, 'out.txt'), 'utf8')).toBe('hold my [redacted] token'); // Modified args executed.
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('completed');
    expect(call.args).toEqual({ path: 'out.txt', content: 'hold my [redacted] token' });
    expect(call.intercepted).toEqual({ by: 'redactor', originalArgs: { path: 'out.txt', content: 'hold my SECRET token' }, reason: 'Redacted a secret' });
    expect(store.session(s.id).status).toBe('idle');
  });

  it('block: denied with attribution, the file is never written', async () => {
    setSidecars([sidecar(responder('console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{action:"block",reason:"Writes are frozen"}}))'), 'freezer')]);
    respond = oneCallThenText('write_file', { path: 'frozen.txt', content: 'x' });
    const s = await create(); await run(s.id);
    await expect(access(join(directory, 'frozen.txt'))).rejects.toThrow();
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('denied');
    expect(call.output).toBe('Blocked by sidecar freezer: Writes are frozen');
    expect(call.intercepted).toBeUndefined(); // A block modifies nothing.
    // The model saw an ordinary denied tool result.
    expect(store.messages(s.id).find(m => m.role === 'tool')?.content).toContain('Blocked by sidecar freezer');
  });

  it('pass: the call runs untouched with no attribution and no notices', async () => {
    setSidecars([sidecar(responder('console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{action:"pass"}}))'), 'observer')]);
    respond = oneCallThenText('write_file', { path: 'plain.txt', content: 'ok' });
    const s = await create(); await run(s.id);
    expect(await readFile(join(directory, 'plain.txt'), 'utf8')).toBe('ok');
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('completed');
    expect(call.intercepted).toBeUndefined();
    expect(notices(s.id).filter(n => n.startsWith('[Sidecar'))).toEqual([]); // Silent pass is silent.
  });

  it('timeout: the tool runs unmodified and a warn notice lands after the tool result', async () => {
    runner.sidecars.timeoutMs = 200; // Injectable test override of the 3s contract.
    setSidecars([sidecar(responder('void m'), 'sleeper')]); // Reads, never answers.
    respond = oneCallThenText('write_file', { path: 'slow.txt', content: 's' });
    const s = await create(); await run(s.id);
    expect(await readFile(join(directory, 'slow.txt'), 'utf8')).toBe('s');
    expect(toolCalls(s.id)[0].status).toBe('completed');
    expect(toolCalls(s.id)[0].intercepted).toBeUndefined();
    const notice = notices(s.id).find(n => n.startsWith('[Sidecar sleeper]'))!;
    expect(notice).toContain('did not respond');
    // Deferred like hook notices: never between the assistant tool_call and its result.
    const rows = store.messages(s.id).map(m => m.role);
    expect(rows.indexOf('system')).toBeGreaterThan(rows.indexOf('tool'));
  });

  it('mcp_/task/memory_ calls are never sent to the sidecar (sentinel file stays absent)', async () => {
    const sentinel = join(directory, 'sidecar-saw-call');
    setSidecars([sidecar(responder(`require("fs").appendFileSync(${JSON.stringify(sentinel)},m.params.tool+"\\n");console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{action:"pass"}}))`), 'watcher')]);
    await writeFile(join(directory, 'research.txt'), 'evidence');
    // Turn 1: memory_remember (whitelisted? no — memory_* is excluded).
    respond = oneCallThenText('memory_remember', { name: 'fact', description: 'a fact', body: 'body' });
    store.saveSettings({ memoryEnabled: true });
    const s1 = await create(); await run(s1.id, 'Remember');
    // Turn 2: a task delegation whose CHILD calls whitelisted read_file — the
    // task call itself and every child call must stay invisible to the sidecar.
    respond = (body, res) => { if (child(body)) { if (body.messages.at(-1)?.role === 'tool') text(res, 'Child report'); else tools(res, [{ name: 'read_file', args: { path: 'research.txt' } }]); } else if (body.messages.at(-1)?.role === 'tool') text(res); else tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect' } }]); };
    const s2 = await create(); await run(s2.id, 'Research');
    expect(runner.delegations.list(s2.id)[0].status).toBe('completed');
    // Turn 3: a real mcp_ call through the connected-tool dispatch path.
    respond = oneCallThenText('mcp_srv_echo_12345678', {});
    const s3m = await create(); await run(s3m.id, 'Call connected tool');
    expect(toolCalls(s3m.id)[0].status).toBe('completed');
    expect(toolCalls(s3m.id)[0].output).toBe('Executed mcp tool');
    await expect(access(sentinel)).rejects.toThrow(); // Nothing was ever sent.
    // Control: a parent whitelisted call IS sent — proves the sentinel works.
    respond = oneCallThenText('read_file', { path: 'research.txt' });
    const s3 = await create(); await run(s3.id, 'Read');
    expect((await readFile(sentinel, 'utf8')).trim()).toBe('read_file');
  });

  it('modified args re-validate: a sidecar cannot smuggle invalid args past execution', async () => {
    // A sidecar still cannot supply an invalid path after interception.
    setSidecars([sidecar(responder('console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:m.params.tool==="write_file"?{action:"modify",args:{path:"invalid"+String.fromCharCode(0),content:"x"},reason:"redirect"}:{action:"pass"}}))'), 'escaper')]);
    respond = oneCallThenText('write_file', { path: 'inside.txt', content: 'x' });
    const s = await create(); await run(s.id);
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('error'); // The normal validation path threw — an ordinary tool error.
    expect(call.intercepted?.by).toBe('escaper'); // The attempt is still attributed and auditable.
    await expect(access(join(directory, 'inside.txt'))).rejects.toThrow();
  });

  it('sidecar changes between turns apply to the next accepted turn', async () => {
    setSidecars([]);
    respond = oneCallThenText('write_file', { path: 'first.txt', content: 'a' });
    const s = await create(); await run(s.id, 'Write first');
    expect(toolCalls(s.id)[0].intercepted).toBeUndefined();
    // Install a blocker AFTER the first turn; the next turn's interception sees it
    // because the new turn captures the updated configuration.
    setSidecars([sidecar(responder('console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{action:"block",reason:"now blocked"}}))'), 'late')]);
    respond = oneCallThenText('write_file', { path: 'second.txt', content: 'b' });
    await run(s.id, 'Write second');
    await expect(access(join(directory, 'second.txt'))).rejects.toThrow();
    expect(toolCalls(s.id).at(-1)?.output).toBe('Blocked by sidecar late: now blocked');
  });

  it('blocks an intercepted action if sidecar configuration changes after acceptance', async () => {
    setSidecars([]);
    const reply = oneCallThenText('write_file', { path: 'unapproved-policy.txt', content: 'Do not write' });
    respond = (body, res) => {
      if (body.messages.at(-1)?.role !== 'tool') setSidecars([sidecar('exit 0', 'new-policy')]);
      reply(body, res);
    };
    const session = await create(); await run(session.id);
    expect(toolCalls(session.id)[0].status).toBe('denied');
    expect(toolCalls(session.id)[0].output).toContain('Sidecar configuration changed');
    await expect(access(join(directory, 'unapproved-policy.txt'))).rejects.toThrow();
  });

  it('sidecars run AFTER PreToolUse hooks: a hook block means the sidecar never sees the call', async () => {
    const sentinel = join(directory, 'sidecar-after-hook');
    store.saveSettings({ hooks: [{ event: 'PreToolUse', command: 'exit 2', matcher: 'write_file' }] });
    setSidecars([sidecar(responder(`require("fs").writeFileSync(${JSON.stringify(sentinel)},"seen");console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{action:"pass"}}))`), 'after')]);
    respond = oneCallThenText('write_file', { path: 'gated.txt', content: 'g' });
    const s = await create(); await run(s.id);
    expect(toolCalls(s.id)[0].output).toContain('Blocked by PreToolUse hook');
    await expect(access(sentinel)).rejects.toThrow(); // The heavier layer was never consulted.
  });

  it('PATCH /api/settings validates sidecars: cap, slug, uniqueness, event enum', async () => {
    const tooMany = await api('/settings', { sidecars: Array.from({ length: 4 }, (_, i) => sidecar('echo x', `s-${i}`)) }, 'PATCH');
    expect(tooMany.status).toBe(400);
    const badName = await api('/settings', { sidecars: [sidecar('echo x', 'Bad Name!')] }, 'PATCH');
    expect(badName.status).toBe(400);
    const badEvent = await api('/settings', { sidecars: [{ name: 'ok', command: 'echo x', events: ['tool_result'] }] }, 'PATCH');
    expect(badEvent.status).toBe(400);
    const duplicate = await api('/settings', { sidecars: [sidecar('echo x', 'same'), sidecar('echo y', 'same')] }, 'PATCH');
    expect(duplicate.status).toBe(400);
    expect(store.settings().sidecars).toBeUndefined();
    const valid = await api('/settings', { sidecars: [sidecar('echo x', 'ok-name')] }, 'PATCH');
    expect(valid.status).toBe(200);
    expect(store.settings().sidecars).toEqual([{ name: 'ok-name', command: 'echo x', events: ['tool_call'] }]);
  });
});
