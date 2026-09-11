import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { PermissionRuleSet } from '../shared/permissions.js';
import type { ToolCall, ToolDefinition } from '../shared/types.js';

// Runner integration for background shell jobs. Mirrors the permission-runner
// harness: a fake OpenAI provider whose SSE responses are chosen per request.
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 5)); } };
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Math.random().toString(36).slice(2)}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const names = (body: any) => body.tools.map((tool: ToolDefinition) => tool.function.name) as string[];
const child = (body: any) => body.messages.some((m: any) => m.role === 'user' && (typeof m.content === 'string' ? m.content : '').startsWith('CHILD'));
const rules = (items: PermissionRuleSet['rules']): PermissionRuleSet => ({ version: 1, rules: items });

describe('background shell jobs in the Runner', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'], calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'ask', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  const toolCalls = (id: string): ToolCall[] => store.messages(id).flatMap(m => m.toolCalls ?? []);
  const prompts = (id: string) => store.events(id, 0).filter(e => e.type === 'permission');
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-jobs-runner-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: await listen(provider), apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('starts a background job in auto mode, ends the turn while it runs, and reports completion exactly once on the next turn', async () => {
    // Turn 1: launch a job that lives past the turn, then finish the assistant turn.
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res, 'Launched') : tools(res, [{ name: 'bash', args: { command: 'sleep 0.4; echo BG_DONE', run_in_background: true } }]);
    const s = await create({ permissionMode: 'auto' });
    await run(s.id, 'Start a background build');
    const call = toolCalls(s.id).find(c => c.name === 'bash')!;
    expect(call.status).toBe('completed');
    expect(call.output).toMatch(/Started background job job-1 \(pid \d+\)/);
    expect(runner.jobs.list(s.id)[0].status).toBe('running'); // Turn ended, job still runs.

    // Let the job finish, then run turn 2 and inspect the outbound envelope.
    await until(() => runner.jobs.list(s.id)[0].status === 'exited');
    calls = [];
    respond = (_body, res) => text(res, 'Ack');
    await run(s.id, 'What finished?');
    const turn2 = JSON.stringify(calls.at(-1));
    expect(turn2).toContain('Background jobs finished since the last turn: job-1 (exit 0');

    // Turn 3 must NOT repeat the notice (consumed once).
    calls = [];
    await run(s.id, 'Anything else?');
    expect(JSON.stringify(calls.at(-1))).not.toContain('Background jobs finished');
  });

  it('polls new output with bash_output without any approval', async () => {
    respond = (body, res) => {
      const last = body.messages.at(-1);
      if (last?.role !== 'tool') return tools(res, [{ name: 'bash', args: { command: 'echo POLLED_LINE', run_in_background: true } }]);
      // After the bash result, poll once; after the poll result, finish.
      const outputs = body.messages.filter((m: any) => m.role === 'tool');
      return outputs.length === 1 ? tools(res, [{ name: 'bash_output', args: { job_id: 'job-1', wait_ms: 2000 } }]) : text(res, 'Seen');
    };
    const s = await create({ permissionMode: 'auto' });
    await run(s.id, 'Poll a job');
    const poll = toolCalls(s.id).find(c => c.name === 'bash_output')!;
    expect(poll.status).toBe('completed');
    expect(poll.output).toContain('POLLED_LINE');
    // Read-only bash_output never prompts (and auto mode never prompts for bash).
    expect(prompts(s.id)).toEqual([]);
  });

  it('prompts for run_in_background in ask mode with the command visible, and a deny rule blocks it', async () => {
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name: 'bash', args: { command: 'sleep 5', run_in_background: true } }]);
    const s = await create({ permissionMode: 'ask' });
    runner.start(s.id, 'Background thing');
    await until(() => runner.permissions(s.id).length === 1);
    const request = runner.permissions(s.id)[0];
    expect(request.tool).toBe('bash');
    expect(request.args.command).toBe('sleep 5'); // Command visible for approval.
    runner.decide(s.id, request.id, 'deny');
    await runner.whenIdle();
    expect(runner.jobs.list(s.id)).toHaveLength(0); // Denied: never started.

    // A pattern deny rule on the command blocks the background start with no prompt.
    store.saveSettings({ permissionRules: rules([{ tool: 'bash', decision: 'deny', patterns: ['sleep **'] }]) });
    const s2 = await create({ permissionMode: 'auto' });
    await run(s2.id, 'Blocked background');
    const call = toolCalls(s2.id).find(c => c.name === 'bash')!;
    expect(call.status).toBe('denied');
    expect(call.output).toContain('denied by an explicit');
    expect(runner.jobs.list(s2.id)).toHaveLength(0);
  });

  it('prompts for kill_shell in ask mode (it is not read-only)', async () => {
    respond = (body, res) => {
      const last = body.messages.at(-1);
      if (last?.role !== 'tool') return tools(res, [{ name: 'bash', args: { command: 'sleep 30', run_in_background: true } }]);
      const outputs = body.messages.filter((m: any) => m.role === 'tool');
      return outputs.length === 1 ? tools(res, [{ name: 'kill_shell', args: { job_id: 'job-1' } }]) : text(res, 'Stopped');
    };
    // Auto-approve the initial bash so we reach kill_shell; then assert kill prompts.
    const s = await create({ permissionMode: 'ask' });
    store.saveSettings({ permissionRules: rules([{ tool: 'bash', decision: 'allow' }]) });
    runner.start(s.id, 'Start then kill');
    await until(() => runner.permissions(s.id).some(p => p.tool === 'kill_shell'));
    const request = runner.permissions(s.id).find(p => p.tool === 'kill_shell')!;
    runner.decide(s.id, request.id, 'allow');
    await runner.whenIdle();
    const kill = toolCalls(s.id).find(c => c.name === 'kill_shell')!;
    expect(kill.status).toBe('completed');
    expect(kill.output).toContain('killed');
  });

  it('does not advertise the job tools to child researchers', async () => {
    respond = (body, res) => {
      if (child(body)) return text(res, 'Child evidence');
      if (body.messages.at(-1)?.role === 'tool') return text(res);
      return tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect' } }]);
    };
    const s = await create({ permissionMode: 'auto' });
    await run(s.id, 'Delegate');
    const childCall = calls.find(c => child(c));
    expect(names(childCall)).not.toContain('bash_output');
    expect(names(childCall)).not.toContain('kill_shell');
    expect(names(childCall)).not.toContain('wait');
    expect(names(childCall)).not.toContain('bash');
    // But the parent turn advertised them.
    expect(names(calls[0])).toEqual(expect.arrayContaining(['bash_output', 'kill_shell', 'wait']));
  });

  it('exposes running jobs on SessionDetail and session delete kills them', async () => {
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name: 'bash', args: { command: 'sleep 30', run_in_background: true } }]);
    const s = await create({ permissionMode: 'auto' });
    await run(s.id, 'Start a durable job');
    const detail = await api(`/sessions/${s.id}`);
    expect(detail.body.jobs).toHaveLength(1);
    expect(detail.body.jobs[0]).toMatchObject({ id: 'job-1', status: 'running' });
    const pid = detail.body.jobs[0].pid as number;
    expect(() => process.kill(pid, 0)).not.toThrow(); // Alive.
    expect((await api(`/sessions/${s.id}`, undefined, 'DELETE')).status).toBe(200);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });
});
