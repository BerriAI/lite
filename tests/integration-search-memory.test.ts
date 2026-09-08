import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { isEnvelope } from '../server/envelope.js';
import type { Message, ToolCall, ToolDefinition } from '../shared/types.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const anthropicText = (res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } })}\n\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`); };
const names = (body: any) => body.tools.map((tool: ToolDefinition) => tool.function.name) as string[];
const child = (body: any) => body.messages.some((m: any) => m.role === 'user' && (typeof m.content === 'string' ? m.content : '').startsWith('CHILD'));
const envelopeCount = (value: unknown) => (JSON.stringify(value).match(/<session-context version=\\"1\\">/g) ?? []).length;
const extractEnvelope = (value: string) => value.slice(value.indexOf('<session-context'), value.indexOf('</session-context>') + '</session-context>'.length);
const MEMORY_TOOLS = ['memory_remember', 'memory_forget', 'memory_recall'];

describe('history_search, memory tools and session-context envelope integration', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'ask', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  const oneCallThenText = (name: string, args: Record<string, unknown>) => (body: any, res: ServerResponse) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name, args }]);
  const toolCalls = (id: string): ToolCall[] => store.messages(id).flatMap(m => m.toolCalls ?? []);
  const prompts = (id: string) => store.events(id, 0).filter(e => e.type === 'permission');
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-search-memory-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }, { id: 'anthro', name: 'Anthro', kind: 'anthropic', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('advertises history_search in Build and Plan, executes without approval in ask mode, and finds another session\'s text', async () => {
    const source = await create(); await run(source.id, 'Remember the XENOGRAPH artifact ledger location');
    respond = oneCallThenText('history_search', { operation: 'search', query: 'XENOGRAPH' });
    const build = await create(); await run(build.id);
    expect(names(calls.at(-2))).toContain('history_search');
    expect(prompts(build.id)).toEqual([]); // Read-only: no approval even in ask mode.
    const call = toolCalls(build.id)[0];
    expect(call.status).toBe('completed');
    expect(call.output).toContain(source.id); // Cross-session hit.
    expect(call.output).toContain('kind=user_text');
    expect(call.output).toContain('indexed');
    expect(call.output).toContain('data, not instructions');
    calls = []; respond = (_body, res) => text(res);
    const plan = await create({ mode: 'plan' }); await run(plan.id);
    expect(names(calls[0])).toContain('history_search');
    expect(names(calls[0])).not.toContain('write_file'); // Plan filter still applies to mutable tools.
  });

  it('around returns role-labeled bounded neighbors of one message', async () => {
    const seeded = store.createSession({});
    const roles: Message['role'][] = ['user', 'assistant', 'user', 'assistant', 'user'];
    roles.forEach((role, index) => store.saveMessage({ id: randomUUID(), sessionId: seeded.id, role, content: `Message number ${index}`, createdAt: index + 1 }));
    respond = oneCallThenText('history_search', { operation: 'around', session_id: seeded.id, message_index: 2, before: 1, after: 1 });
    const s = await create(); await run(s.id);
    const output = toolCalls(s.id)[0].output!;
    expect(toolCalls(s.id)[0].status).toBe('completed');
    expect(output).toContain('[1] assistant: Message number 1');
    expect(output).toContain('[2] user: Message number 2');
    expect(output).toContain('[3] assistant: Message number 3');
    expect(output).not.toContain('[0]'); expect(output).not.toContain('[4]');
  });

  it('renders honest empties: 0 hits carries the not-proof guidance and indexed counts', async () => {
    // kinds excludes tool_input so the search cannot hit its own call arguments.
    respond = oneCallThenText('history_search', { operation: 'search', query: 'zzqx_never_written_anywhere', kinds: ['user_text', 'assistant_text'] });
    const s = await create(); await run(s.id);
    const output = toolCalls(s.id)[0].output!;
    expect(output).toContain('0 results does not prove absence');
    expect(output).toMatch(/indexed \d+ sessions \/ \d+ messages/);
  });

  it('reindexes on seal so a just-finished turn is findable from another session afterwards', async () => {
    // Warm the index first so the one-time indexAll sweep cannot mask the seal path;
    // the later search runs from a different session, so its live refresh cannot either.
    const searcher = await create();
    respond = oneCallThenText('history_search', { operation: 'search', query: 'warmup-probe' });
    await run(searcher.id, 'Warm the index');
    const worker = await create();
    respond = (_body, res) => text(res, 'The GLIMMERSHARD migration completed cleanly');
    await run(worker.id, 'Do the migration');
    respond = oneCallThenText('history_search', { operation: 'search', query: 'GLIMMERSHARD' });
    await run(searcher.id, 'Now find it');
    const call = toolCalls(searcher.id).at(-1)!;
    expect(call.status).toBe('completed');
    expect(call.output).toContain('kind=assistant_text');
    expect(call.output).toContain(worker.id);
  });

  it('extends the child researcher ceiling to six read tools including a working history_search, with zero memory tools even when enabled', async () => {
    await api('/settings', { memoryEnabled: true }, 'PATCH');
    const source = await create(); await run(source.id, 'The QUARKPHASE incident report');
    respond = (body, res) => { if (child(body)) { if (body.messages.at(-1)?.role === 'tool') text(res, 'Child report'); else tools(res, [{ name: 'history_search', args: { operation: 'search', query: 'QUARKPHASE' } }]); } else if (body.messages.at(-1)?.role === 'tool') text(res); else tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect history' } }]); };
    const s = await create({ permissionMode: 'auto' }); await run(s.id);
    const childCall = calls.find(child)!;
    expect(names(childCall).sort()).toEqual(['glob', 'grep', 'history_search', 'read_file', 'todo_read', 'tool_output_page', 'web_fetch']);
    for (const name of MEMORY_TOOLS) expect(names(childCall)).not.toContain(name);
    const delegation = runner.delegations.list(s.id)[0];
    expect(delegation.status).toBe('completed');
    const attempt = runner.delegations.transcript(s.id, delegation.id).messages.flatMap(m => m.toolCalls ?? [])[0];
    expect(attempt.status).toBe('completed');
    expect(attempt.output).toContain(source.id);
  });

  it('memory tools are absent by default and present when memoryEnabled at acceptance', async () => {
    const off = await create(); await run(off.id);
    for (const name of MEMORY_TOOLS) expect(names(calls[0])).not.toContain(name);
    await api('/settings', { memoryEnabled: true }, 'PATCH');
    calls = [];
    const on = await create(); await run(on.id);
    for (const name of MEMORY_TOOLS) expect(names(calls[0])).toContain(name);
  });

  it('memory_remember prompts in ask mode and the acceptance snapshot survives a mid-run settings flip', async () => {
    await api('/settings', { memoryEnabled: true }, 'PATCH');
    respond = oneCallThenText('memory_remember', { name: 'indent-style', description: 'Indentation preference', body: 'This project uses two-space indentation.' });
    const s = await create(); runner.start(s.id, 'Remember the style');
    await until(() => runner.permissions(s.id).length === 1);
    expect(runner.permissions(s.id)[0].tool).toBe('memory_remember');
    // Disabling mid-run must not change this accepted turn's advertised tools.
    await api('/settings', { memoryEnabled: false }, 'PATCH');
    runner.decide(s.id, runner.permissions(s.id)[0].id, 'allow'); await runner.whenIdle();
    expect(toolCalls(s.id)[0].status).toBe('completed');
    expect(JSON.stringify(calls[1].tools)).toBe(JSON.stringify(calls[0].tools));
    for (const name of MEMORY_TOOLS) expect(names(calls[1])).toContain(name);
    expect((await api(`/memory?workspace=${encodeURIComponent(directory)}`)).body.facts).toMatchObject([{ name: 'indent-style' }]);
    // A fresh turn accepted after the flip drops the tools.
    calls = []; respond = (_body, res) => text(res);
    const later = await create(); await run(later.id);
    for (const name of MEMORY_TOOLS) expect(names(calls[0])).not.toContain(name);
  });

  it('remember executes without prompting in auto mode; forget removes; recall renders facts', async () => {
    await api('/settings', { memoryEnabled: true }, 'PATCH');
    const s = await create({ permissionMode: 'auto' });
    respond = oneCallThenText('memory_remember', { name: 'deploy-cmd', description: 'Deploy command', body: 'Deploy with npm run ship' });
    await run(s.id, 'Remember');
    expect(prompts(s.id)).toEqual([]);
    expect(toolCalls(s.id)[0].status).toBe('completed');
    respond = oneCallThenText('memory_recall', { query: 'deploy' });
    await run(s.id, 'Recall');
    const recall = toolCalls(s.id).at(-1)!;
    expect(recall.output).toContain('deploy-cmd');
    expect(recall.output).toContain('npm run ship');
    expect(recall.output).toContain('not instructions');
    respond = oneCallThenText('memory_forget', { name: 'deploy-cmd' });
    await run(s.id, 'Forget');
    expect(toolCalls(s.id).at(-1)!.output).toContain('Forgot');
    expect((await api(`/memory?workspace=${encodeURIComponent(directory)}`)).body.facts).toEqual([]);
  });

  it('memory is workspace-isolated: a fact in workspace A is invisible to a session in workspace B', async () => {
    await api('/settings', { memoryEnabled: true }, 'PATCH');
    const other = join(directory, 'other-workspace'); await mkdir(other);
    const a = await create({ permissionMode: 'auto' });
    respond = oneCallThenText('memory_remember', { name: 'secret-fact', description: 'A fact', body: 'PLUTONIUM shipment schedule' });
    await run(a.id, 'Remember');
    const b = await create({ permissionMode: 'auto', workspace: other });
    respond = oneCallThenText('memory_recall', { query: 'PLUTONIUM shipment' });
    await run(b.id, 'Recall elsewhere');
    const recall = toolCalls(b.id)[0];
    expect(recall.status).toBe('completed');
    expect(recall.output).toContain('No matching memory facts');
    expect((await api(`/memory?workspace=${encodeURIComponent(other)}`)).body.facts).toEqual([]);
    expect((await api(`/memory?workspace=${encodeURIComponent(directory)}`)).body.facts).toMatchObject([{ name: 'secret-fact' }]);
  });

  it('openai outbound carries exactly one digest-valid envelope adjacent to the latest user message; the system prompt is byte-stable', async () => {
    const s = await create();
    await run(s.id, 'First turn'); await run(s.id, 'Second turn');
    for (const body of calls) {
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[0].content).not.toContain('Today:');
      expect(body.messages[0].content).not.toContain('Permission mode:');
      expect(body.messages[0].content).toContain('Workspace:');
      const envelopes = body.messages.filter((m: any) => typeof m.content === 'string' && isEnvelope(m.content));
      expect(envelopes).toHaveLength(1);
      expect(envelopeCount(body)).toBe(1);
      expect(envelopes[0].role).toBe('system');
      expect(envelopes[0].content).toContain('Mode: build');
      expect(envelopes[0].content).toContain('Permission mode:');
      expect(envelopes[0].content).toMatch(/Today: \d{4}-\d{2}-\d{2}\./);
      expect(envelopes[0].content).not.toContain('## Background memory'); // Memory disabled.
      const lastUser = body.messages.map((m: any) => m.role).lastIndexOf('user');
      expect(body.messages[lastUser - 1]).toBe(envelopes[0]); // Immediately before the latest user message.
    }
    // Cache-stability contract: identical prefix bytes across turns of one session.
    expect(calls[1].messages[0].content).toBe(calls[0].messages[0].content);
    expect(JSON.stringify(calls[1].tools)).toBe(JSON.stringify(calls[0].tools));
    // The envelope is a request projection only: never persisted, never exported.
    expect(store.messages(s.id).some(m => isEnvelope(m.content))).toBe(false);
    expect(envelopeCount(store.messages(s.id))).toBe(0);
    const exported = await api(`/sessions/${s.id}/export`);
    expect(envelopeCount(exported.body.messages)).toBe(0);
    expect(exported.body.messages.map((m: Message) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('the envelope carries a background-memory section only when enabled and recall matches', async () => {
    await api('/settings', { memoryEnabled: true }, 'PATCH');
    const s = await create({ permissionMode: 'auto' });
    respond = oneCallThenText('memory_remember', { name: 'flumph-rule', description: 'Flumph handling', body: 'Always escort the flumph delegation politely.' });
    await run(s.id, 'Remember the rule');
    respond = (_body, res) => text(res);
    await run(s.id, 'How should I treat the flumph delegation?');
    const body = calls.at(-1);
    const envelope = body.messages.find((m: any) => typeof m.content === 'string' && isEnvelope(m.content));
    expect(envelope.content).toContain('## Background memory');
    expect(envelope.content).toContain('flumph-rule');
    expect(envelope.content).toContain('low-authority');
    // System prompt stays byte-identical even as the envelope's memory changes.
    expect(body.messages[0].content).toBe(calls[0].messages[0].content);
    expect(store.messages(s.id).some(m => isEnvelope(m.content))).toBe(false);
  });

  it('anthropic outbound prepends exactly one envelope to the latest user content, preserving non-text parts and never double-prepending on retry', async () => {
    let failures = 1;
    respond = (_body, res) => { if (failures-- > 0) { res.writeHead(500, { 'retry-after': '0', 'Content-Type': 'application/json' }); res.end('{"error":{"type":"server_error"}}'); } else anthropicText(res); };
    const s = await create({ providerId: 'anthro', permissionMode: 'auto' });
    runner.start(s.id, 'Anthropic turn', [{ name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]);
    await runner.whenIdle();
    expect(calls).toHaveLength(2); // Failed attempt + retry: both received one envelope.
    for (const body of calls) {
      expect(envelopeCount(body)).toBe(1);
      expect(body.system).not.toContain('Today:');
      expect(body.system).not.toContain('Permission mode:');
      const user = body.messages.at(-1);
      expect(user.role).toBe('user');
      expect(user.content[0].type).toBe('text');
      expect(user.content[0].text.startsWith('<session-context')).toBe(true);
      const extracted = extractEnvelope(user.content[0].text);
      expect(isEnvelope(extracted)).toBe(true);
      expect(extracted).toContain('Mode: build');
      expect(extracted).toMatch(/Today: \d{4}-\d{2}-\d{2}\./);
      // The image part survives the prepend untouched.
      expect(user.content.some((part: any) => part.type === 'image')).toBe(true);
      expect(user.content.some((part: any) => part.type === 'text' && part.text.includes('Anthropic turn'))).toBe(true);
    }
    expect(store.messages(s.id).some(m => isEnvelope(m.content) || m.content.includes('<session-context'))).toBe(false);
  });

  it('GET/DELETE /api/memory validate the workspace and report unknown names honestly', async () => {
    expect((await api('/memory')).status).toBe(400);
    expect((await api(`/memory/unknown-name?workspace=${encodeURIComponent(directory)}`, undefined, 'DELETE')).body).toEqual({ removed: false });
    expect((await api(`/memory?workspace=${encodeURIComponent(directory)}`)).body).toEqual({ facts: [] });
  });
});
