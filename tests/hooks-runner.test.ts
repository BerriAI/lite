import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { HookConfig } from '../shared/hooks.js';
import type { ToolCall } from '../shared/types.js';

// Mirrors the guidance/receipts-runner harness: fake OpenAI provider, per-request SSE.
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const child = (body: any) => body.messages.some((m: any) => m.role === 'user' && (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : '').includes('CHILD'));

describe('lifecycle hooks Runner/API integration', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  const oneCallThenText = (name: string, args: Record<string, unknown>) => (body: any, res: ServerResponse) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name, args }]);
  const toolCalls = (id: string): ToolCall[] => store.messages(id).flatMap(m => m.toolCalls ?? []);
  const notices = (id: string) => store.messages(id).filter(m => m.role === 'system').map(m => m.content);
  const setHooks = (hooks: HookConfig[]) => store.saveSettings({ hooks });
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-hooks-runner-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model', maxSteps: 12 });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('a PreToolUse exit-2 hook blocks an approved write_file with the hook stderr in the result', async () => {
    setHooks([{ event: 'PreToolUse', command: 'echo "no writes today" >&2; exit 2', matcher: 'write_file' }]);
    respond = oneCallThenText('write_file', { path: 'hello.txt', content: 'hi' });
    const s = await create(); await run(s.id, 'Write the file');
    await expect(access(join(directory, 'hello.txt'))).rejects.toThrow(); // File absent: the hook blocked before execution.
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('denied');
    expect(call.output).toContain('Blocked by PreToolUse hook');
    expect(call.output).toContain('no writes today');
    // The model saw it as an ordinary denied tool result.
    const result = store.messages(s.id).find(m => m.role === 'tool');
    expect(result?.content).toContain('Blocked by PreToolUse hook');
    expect(store.session(s.id).status).toBe('idle');
  });

  it('a PreToolUse exit-0 hook allows the approved tool to run', async () => {
    setHooks([{ event: 'PreToolUse', command: 'exit 0' }]);
    respond = oneCallThenText('write_file', { path: 'allowed.txt', content: 'ok' });
    const s = await create(); await run(s.id);
    expect(await readFile(join(directory, 'allowed.txt'), 'utf8')).toBe('ok');
    expect(toolCalls(s.id)[0].status).toBe('completed');
    // Silent success is silent: no hook notice rows.
    expect(notices(s.id).filter(n => n.startsWith('[Hook'))).toEqual([]);
  });

  it('a matcher-scoped PreToolUse hook only gates its named tool', async () => {
    setHooks([{ event: 'PreToolUse', command: 'exit 2', matcher: 'bash' }]);
    respond = oneCallThenText('write_file', { path: 'other.txt', content: 'ok' });
    const s = await create(); await run(s.id);
    expect(await readFile(join(directory, 'other.txt'), 'utf8')).toBe('ok');
  });

  it('PostToolUse stdout becomes a [Hook PostToolUse] system notice and receives the payload', async () => {
    setHooks([{ event: 'PostToolUse', command: 'cat', matcher: 'write_file' }]);
    respond = oneCallThenText('write_file', { path: 'observed.txt', content: 'v' });
    const s = await create(); await run(s.id);
    expect(await readFile(join(directory, 'observed.txt'), 'utf8')).toBe('v'); // Observational: the write still happened.
    const notice = notices(s.id).find(n => n.startsWith('[Hook PostToolUse]'))!;
    const payload = JSON.parse(notice.slice('[Hook PostToolUse] '.length));
    expect(payload).toMatchObject({ event: 'PostToolUse', sessionId: s.id, workspace: directory, tool: 'write_file', args: { path: 'observed.txt', content: 'v' } });
    expect(typeof payload.output).toBe('string');
    // The notice lands AFTER the tool result row, never between the assistant
    // tool_call and its result (provider adjacency requirement).
    const rows = store.messages(s.id).map(m => m.role);
    expect(rows.indexOf('system')).toBeGreaterThan(rows.indexOf('tool'));
  });

  it('UserPromptSubmit runs once per turn before the first provider request; exit 2 only warns', async () => {
    setHooks([{ event: 'UserPromptSubmit', command: 'cat; exit 2' }]);
    respond = oneCallThenText('write_file', { path: 'prompted.txt', content: 'p' });
    const s = await create(); await run(s.id, 'The exact prompt');
    // Exit 2 is a warn here (only PreToolUse blocks): the turn ran to completion.
    expect(await readFile(join(directory, 'prompted.txt'), 'utf8')).toBe('p');
    const prompts = notices(s.id).filter(n => n.startsWith('[Hook UserPromptSubmit]'));
    expect(prompts).toHaveLength(1); // Once per turn, despite two provider steps.
    expect(prompts[0]).toContain('warning only');
    expect(prompts[0]).toContain('"prompt":"The exact prompt"');
    // The notice precedes the first assistant row: it ran before the request.
    const rows = store.messages(s.id).map(m => m.role);
    expect(rows.indexOf('system')).toBeLessThan(rows.indexOf('assistant'));
  });

  it('Stop fires when the turn seals normally, with the bounded final text', async () => {
    setHooks([{ event: 'Stop', command: 'cat' }]);
    respond = (_body, res) => text(res, 'Final answer');
    const s = await create(); await run(s.id);
    const notice = notices(s.id).find(n => n.startsWith('[Hook Stop]'))!;
    const payload = JSON.parse(notice.slice('[Hook Stop] '.length));
    expect(payload).toEqual({ event: 'Stop', sessionId: s.id, workspace: directory, finalText: 'Final answer' });
  });

  it('hooks are captured at acceptance: changing settings.hooks mid-run has no effect', async () => {
    setHooks([]);
    respond = oneCallThenText('write_file', { path: 'captured.txt', content: 'c' });
    const s = await create({ permissionMode: 'ask' });
    runner.start(s.id, 'Write');
    // Install a blocking hook while the approval is pending — after acceptance.
    const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 5)); } };
    await until(() => runner.permissions(s.id).length === 1);
    setHooks([{ event: 'PreToolUse', command: 'exit 2' }]);
    runner.decide(s.id, runner.permissions(s.id)[0].id, 'allow');
    await runner.whenIdle();
    expect(await readFile(join(directory, 'captured.txt'), 'utf8')).toBe('c'); // The captured (empty) hooks ran, not the new deny.
    expect(toolCalls(s.id)[0].status).toBe('completed');
  });

  it('project hooks run only for a trusted workspace; untrusted gets the advisory', async () => {
    await mkdir(join(directory, '.litespeed'), { recursive: true });
    await writeFile(join(directory, '.litespeed', 'hooks.json'), JSON.stringify({ version: 1, hooks: [{ event: 'PreToolUse', command: 'exit 2', matcher: 'write_file' }] }));
    respond = oneCallThenText('write_file', { path: 'trusted.txt', content: 't' });
    const untrusted = await create(); await run(untrusted.id);
    expect(await readFile(join(directory, 'trusted.txt'), 'utf8')).toBe('t'); // Untrusted: the project hook did not fire.
    expect(notices(untrusted.id).some(n => n.includes('not trusted; enable in Settings'))).toBe(true);
    // Trust via the API (canonicalizes), then the project hook gates.
    const trust = await api('/workspaces/trust', { workspace: directory });
    expect(trust.status).toBe(200);
    expect(trust.body.trustedWorkspaces).toEqual([directory]);
    respond = oneCallThenText('write_file', { path: 'gated.txt', content: 'g' });
    const trusted = await create(); await run(trusted.id);
    await expect(access(join(directory, 'gated.txt'))).rejects.toThrow();
    expect(toolCalls(trusted.id)[0].output).toContain('Blocked by PreToolUse hook');
    // Untrust removes it again.
    const untrust = await api('/workspaces/trust', { workspace: directory }, 'DELETE');
    expect(untrust.body.trustedWorkspaces).toEqual([]);
  });

  it('a child researcher runs zero hooks (sentinel file stays absent)', async () => {
    const sentinel = join(directory, 'sentinel-hook-ran');
    // PreToolUse with no matcher would fire for EVERY tool the child calls if
    // hooks leaked into children; PostToolUse and Stop likewise write sentinels.
    setHooks([
      { event: 'PreToolUse', command: `touch ${JSON.stringify(sentinel)}` },
      { event: 'PostToolUse', command: `touch ${JSON.stringify(sentinel)}` },
      { event: 'Stop', command: `touch ${JSON.stringify(sentinel)}-stop` },
    ]);
    await writeFile(join(directory, 'research.txt'), 'evidence');
    respond = (body, res) => { if (child(body)) { if (body.messages.at(-1)?.role === 'tool') text(res, 'Child report'); else tools(res, [{ name: 'read_file', args: { path: 'research.txt' } }]); } else if (body.messages.at(-1)?.role === 'tool') text(res); else tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect' } }]); };
    const s = await create(); await run(s.id, 'Research');
    const delegation = runner.delegations.list(s.id)[0];
    expect(delegation.status).toBe('completed');
    // The child called read_file; a leaked PreToolUse/PostToolUse would have
    // touched the sentinel. The PARENT's task call legitimately fires hooks —
    // so assert on the child transcript instead of the parent-side sentinel:
    const childCalls = runner.delegations.transcript(s.id, delegation.id).messages.flatMap(m => m.toolCalls ?? []);
    expect(childCalls[0]?.status).toBe('completed');
    const childNotices = runner.delegations.transcript(s.id, delegation.id).messages.filter(m => m.role === 'system' && m.content.startsWith('[Hook'));
    expect(childNotices).toEqual([]);
  });

  it('parent hooks fire around the task tool while the child itself stays hook-free', async () => {
    const sentinel = join(directory, 'child-pre-sentinel');
    // A read_file-matched hook: the parent never calls read_file, only the
    // child does. If children ran hooks, the sentinel would exist.
    setHooks([{ event: 'PreToolUse', command: `touch ${JSON.stringify(sentinel)}`, matcher: 'read_file' }]);
    await writeFile(join(directory, 'research.txt'), 'evidence');
    respond = (body, res) => { if (child(body)) { if (body.messages.at(-1)?.role === 'tool') text(res, 'Child report'); else tools(res, [{ name: 'read_file', args: { path: 'research.txt' } }]); } else if (body.messages.at(-1)?.role === 'tool') text(res); else tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect' } }]); };
    const s = await create(); await run(s.id, 'Research');
    expect(runner.delegations.list(s.id)[0].status).toBe('completed');
    await expect(access(sentinel)).rejects.toThrow();
  });

  it('a hook timeout warns but the tool still runs', async () => {
    runner.hooks.timeoutMs = 200; // Injectable test override of the 10s contract.
    setHooks([{ event: 'PreToolUse', command: 'sleep 30' }]);
    respond = oneCallThenText('write_file', { path: 'slow.txt', content: 's' });
    const s = await create(); await run(s.id);
    expect(await readFile(join(directory, 'slow.txt'), 'utf8')).toBe('s');
    expect(toolCalls(s.id)[0].status).toBe('completed');
    expect(notices(s.id).some(n => n.includes('timed out') && n.includes('never block'))).toBe(true);
  });

  it('a crashing/nonzero hook warns and never fails the turn', async () => {
    setHooks([{ event: 'UserPromptSubmit', command: 'echo boom >&2; exit 7' }]);
    respond = (_body, res) => text(res, 'Fine');
    const s = await create(); await run(s.id);
    expect(store.session(s.id).status).toBe('idle');
    const notice = notices(s.id).find(n => n.startsWith('[Hook UserPromptSubmit]'))!;
    expect(notice).toContain('code 7');
    expect(notice).toContain('boom');
  });

  it('PATCH /api/settings validates hooks: 20-hook cap and shape are enforced with 400', async () => {
    const tooMany = await api('/settings', { hooks: Array.from({ length: 21 }, () => ({ event: 'Stop', command: 'echo x' })) }, 'PATCH');
    expect(tooMany.status).toBe(400);
    const badEvent = await api('/settings', { hooks: [{ event: 'NotAnEvent', command: 'x' }] }, 'PATCH');
    expect(badEvent.status).toBe(400);
    const longCommand = await api('/settings', { hooks: [{ event: 'Stop', command: 'x'.repeat(1001) }] }, 'PATCH');
    expect(longCommand.status).toBe(400);
    expect(store.settings().hooks).toBeUndefined();
    const valid = await api('/settings', { hooks: [{ event: 'PreToolUse', command: 'exit 0', matcher: 'bash' }] }, 'PATCH');
    expect(valid.status).toBe(200);
    expect(store.settings().hooks).toEqual([{ event: 'PreToolUse', command: 'exit 0', matcher: 'bash' }]);
  });
});
