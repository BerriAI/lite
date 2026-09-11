import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { ToolCall, ToolDefinition } from '../shared/types.js';

// 5.5 image-input delivery through the RUNNER: the view_image tool result must
// carry the attachment on the persisted tool message, and providerMessages must
// project it as an image_url part on the openai route. tools.test.ts covers the
// tool itself (sniffing, caps, honest fallback); this file covers the wiring.
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const names = (body: any) => body.tools.map((tool: ToolDefinition) => tool.function.name) as string[];
// Minimal real PNG header: sniffable magic bytes + IHDR dimensions.
const png = (width: number, height: number) => { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };

describe('view_image and web_search runner integration', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Look at the diagram') => { runner.start(id, content); await runner.whenIdle(); };
  const toolCalls = (id: string): ToolCall[] => store.messages(id).flatMap(m => m.toolCalls ?? []);
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-image-tools-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('advertises view_image and web_search in Build and read-only Plan mode', async () => {
    const build = await create(); await run(build.id);
    expect(names(calls[0])).toContain('view_image');
    expect(names(calls[0])).toContain('web_search');
    calls = [];
    const plan = await create({ mode: 'plan' }); await run(plan.id);
    expect(names(calls[0])).toContain('view_image');
    expect(names(calls[0])).toContain('web_search');
    expect(names(calls[0])).not.toContain('write_file');
  });

  it('view_image runs without approval, persists the attachment on the tool result, and the outbound openai tool message carries the image_url part', async () => {
    const image = png(320, 200);
    await writeFile(join(directory, 'diagram.png'), image);
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res, 'I can see it') : tools(res, [{ name: 'view_image', args: { path: 'diagram.png' } }]);
    const s = await create({ permissionMode: 'ask' }); // Read-only: no prompt even in ask mode.
    await run(s.id);
    expect(runner.permissions(s.id)).toEqual([]);
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('completed');
    expect(call.output).toBe('[Image diagram.png attached: image/png, 320x200, 64 bytes]');
    // The persisted tool result message carries the data-URL attachment.
    const result = store.messages(s.id).find(m => m.role === 'tool')!;
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]).toMatchObject({ name: 'diagram.png', path: 'diagram.png', mimeType: 'image/png' });
    expect(result.attachments![0].dataUrl).toBe(`data:image/png;base64,${image.toString('base64')}`);
    // The SECOND provider request projects the tool result as text + image_url parts.
    const outbound = calls[1].messages.find((m: any) => m.role === 'tool');
    expect(Array.isArray(outbound.content)).toBe(true);
    expect(outbound.content[0]).toEqual({ type: 'text', text: call.output });
    expect(outbound.content[1]).toEqual({ type: 'image_url', image_url: { url: result.attachments![0].dataUrl } });
    expect(outbound.tool_call_id).toBe(call.id);
  });

  it('a failed view_image keeps the tool message a plain string with no attachment', async () => {
    await writeFile(join(directory, 'fake.png'), 'not an image at all');
    respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name: 'view_image', args: { path: 'fake.png' } }]);
    const s = await create(); await run(s.id);
    const call = toolCalls(s.id)[0];
    expect(call.status).toBe('error');
    expect(call.output).toContain('magic bytes');
    expect(store.messages(s.id).find(m => m.role === 'tool')!.attachments).toBeUndefined();
    expect(typeof calls[1].messages.find((m: any) => m.role === 'tool').content).toBe('string');
  });

  it('web_search failure surfaces one honest error result without retry loops or approval prompts', async () => {
    // No DNS/HTTP mocks here: the guarded fetch rejects the invalid-TLD host
    // BEFORE any network request, exercising the honest-error path end to end.
    const { webSearchEndpoint } = await import('../server/tools.js');
    const original = webSearchEndpoint.url;
    webSearchEndpoint.url = 'https://search.invalid/html/';
    try {
      respond = (body, res) => body.messages.at(-1)?.role === 'tool' ? text(res) : tools(res, [{ name: 'web_search', args: { query: 'anything' } }]);
      const s = await create({ permissionMode: 'ask' });
      await run(s.id);
      expect(runner.permissions(s.id)).toEqual([]); // Read-only: never prompts.
      const call = toolCalls(s.id)[0];
      expect(call.status).toBe('error');
      expect(call.output).toMatch(/Web search failed/);
      expect(calls).toHaveLength(2); // One attempt, one final answer — no retries.
    } finally { webSearchEndpoint.url = original; }
  });
});
