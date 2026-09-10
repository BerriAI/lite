import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

// Mirrors the guidance-runner harness: fake OpenAI provider, per-request SSE.
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const child = (body: any) => body.messages.some((m: any) => m.role === 'user' && (typeof m.content === 'string' ? m.content : '').startsWith('CHILD'));

describe('end-of-turn evidence receipts in the Runner', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown) => { const response = await fetch(url + '/api' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  const finalAssistant = (id: string) => store.messages(id).filter(m => m.role === 'assistant').at(-1)!;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-receipts-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model', maxSteps: 12 });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('appends the no-checks notice and persists receipts on a write turn without checks', async () => {
    const session = await create();
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res, 'File written.') : tools(res, [{ name: 'write_file', args: { path: 'made.txt', content: 'evidence' } }]);
    await run(session.id, 'Create a file');
    expect(await readFile(join(directory, 'made.txt'), 'utf8')).toBe('evidence');
    const final = finalAssistant(session.id);
    expect(final.content).toBe('File written.\n\n[Receipts: 1 file(s) changed, no checks were run.]');
    expect(final.receipts).toEqual({ filesChanged: ['made.txt'], commandsRun: [], checksRun: [], checksFailed: [], unresolvedChecks: [], filesChangedAfterLastCheck: [], unreadFilesChanged: ['made.txt'] });
    // Receipts survive persistence and reach the session detail projection.
    expect((await api(`/sessions/${session.id}`)).body.messages.at(-1).receipts.filesChanged).toEqual(['made.txt']);
  });

  it('appends no warning when a passing check follows the write', async () => {
    const session = await create();
    // 'npm test --help' matches the heuristic (starts with 'npm test') and
    // exits 0 quickly even in a directory with no package.json (verified).
    respond = (body, res) => {
      const results = body.messages.filter((m: any) => m.role === 'tool').length;
      if (results === 0) return tools(res, [{ name: 'write_file', args: { path: 'checked.txt', content: 'v' } }]);
      if (results === 1) return tools(res, [{ name: 'bash', args: { command: 'npm test --help' } }]);
      return text(res, 'Verified.');
    };
    await run(session.id, 'Write then verify');
    const final = finalAssistant(session.id);
    expect(final.content).toBe('Verified.');
    expect(final.receipts).toMatchObject({ filesChanged: ['checked.txt'], checksRun: ['npm test --help'], checksFailed: [], unresolvedChecks: [], filesChangedAfterLastCheck: [] });
    const bash = store.messages(session.id).flatMap(m => m.toolCalls ?? []).find(call => call.name === 'bash')!;
    expect(bash.output).toMatch(/Exit code: 0\s*$/); // The heuristic's failure probe stays honest.
  });

  it('flags files edited after the last check', async () => {
    const session = await create();
    await writeFile(join(directory, 'late.txt'), 'before');
    respond = (body, res) => {
      const results = body.messages.filter((m: any) => m.role === 'tool').length;
      if (results === 0) return tools(res, [{ name: 'bash', args: { command: 'npm test --help' } }]);
      if (results === 1) return tools(res, [{ name: 'write_file', args: { path: 'late.txt', content: 'after' } }]);
      return text(res, 'Tweaked.');
    };
    await run(session.id, 'Check then edit');
    const final = finalAssistant(session.id);
    expect(final.content).toBe('Tweaked.\n\n[Receipts: 1 file(s) changed, 1 changed after the last check.]');
    expect(final.receipts?.filesChangedAfterLastCheck).toEqual(['late.txt']);
  });

  it('persists empty-of-changes receipts with no appended text on a pure-read turn', async () => {
    const session = await create();
    await writeFile(join(directory, 'readme.txt'), 'content');
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res, 'Read only.') : tools(res, [{ name: 'read_file', args: { path: 'readme.txt' } }]);
    await run(session.id, 'Just read');
    const final = finalAssistant(session.id);
    expect(final.content).toBe('Read only.');
    expect(final.receipts).toEqual({ filesChanged: [], commandsRun: [], checksRun: [], checksFailed: [], unresolvedChecks: [], filesChangedAfterLastCheck: [], unreadFilesChanged: [] });
  });

  it('never attaches receipts to a child researcher transcript', async () => {
    const session = await create();
    await writeFile(join(directory, 'research.txt'), 'evidence');
    respond = (body, res) => {
      if (child(body)) return body.messages.at(-1)?.role === 'tool' ? text(res, 'Child report') : tools(res, [{ name: 'read_file', args: { path: 'research.txt' } }]);
      return body.messages.at(-1)?.role === 'tool' ? text(res, 'Root done') : tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect' } }]);
    };
    await run(session.id, 'ROOT research');
    const delegation = runner.delegations.list(session.id)[0];
    expect(delegation.status).toBe('completed');
    for (const message of runner.delegations.transcript(session.id, delegation.id).messages) expect(message.receipts).toBeUndefined();
    // The parent's own final message still gets (empty-of-changes) receipts, unappended.
    const final = finalAssistant(session.id);
    expect(final.content).toBe('Root done');
    expect(final.receipts?.filesChanged).toEqual([]);
  });
});
