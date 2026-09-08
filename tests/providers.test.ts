import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { configureCodexAuth, endpoint, listModels, parseSSE, streamCompletion } from '../server/providers.js';
import type { Provider, StreamChunk } from '../shared/types.js';

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function mock(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    try { await handler(req, res, data ? JSON.parse(data) : undefined); }
    catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: String(error) } })); }
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
const frame = (data: any) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const choice = (delta: any, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const provider = (baseUrl: string): Provider => ({ id: 'test', kind: 'openai', name: 'Test', baseUrl, apiKey: 'test-secret-never-expose' });
async function collect(p: Provider, signal = new AbortController().signal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of streamCompletion({ provider: p, model: 'my-model', messages: [{ role: 'user', content: 'hello' }], signal })) chunks.push(chunk);
  return chunks;
}

describe('provider protocol', () => {
  it('normalizes API roots without duplicating v1 or dropping a gateway prefix', () => {
    expect(endpoint('https://example.org/', 'models')).toBe('https://example.org/v1/models');
    expect(endpoint('https://example.org/v1/v1/', 'chat/completions')).toBe('https://example.org/v1/chat/completions');
    expect(endpoint('https://example.org/gateway/v1/chat/completions', 'models')).toBe('https://example.org/gateway/v1/models');
    expect(() => endpoint('https://secret@example.org/v1', 'models')).toThrow('without credentials');
    expect(() => endpoint('file:///tmp/key', 'models')).toThrow('HTTP(S)');
  });
  it('streams fragmented UTF-8, reasoning, interleaved tool arguments, and trailing usage', async () => {
    let received: any;
    const base = await mock(async (req, res, body) => {
      received = { path: req.url, key: req.headers.authorization, body };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = ': heartbeat\r\n\r\n' + frame(choice({ content: 'héllo ' })) + frame(choice({ reasoning_content: 'Checking.' })) +
        frame(choice({ tool_calls: [{ index: 0, id: 'call-a', function: { name: 'read_file', arguments: '{"pa' } }, { index: 1, id: 'call-b', function: { name: 'glob', arguments: '{"pat' } }] })) +
        frame(choice({ tool_calls: [{ index: 1, function: { arguments: 'tern":"*.ts"}' } }, { index: 0, function: { arguments: 'th":"file.ts"}' } }] })) +
        frame(choice({}, 'tool_calls')) + frame({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } } }) + 'data: [DONE]\r\n\r\n';
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 3) { res.write(bytes.subarray(i, i + 3)); if (i % 30 === 0) await delay(1); }
      res.end();
    });
    const chunks = await collect(provider(`${base}/v1/`));
    expect(received.path).toBe('/v1/chat/completions');
    expect(received.key).toBe('Bearer test-secret-never-expose');
    expect(received.body.stream_options).toEqual({ include_usage: true });
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).toBe('héllo ');
    expect(chunks.find(c => c.type === 'reasoning')?.text).toBe('Checking.');
    const calls = new Map<number, string>();
    for (const chunk of chunks) if (chunk.tool) calls.set(chunk.tool.index, (calls.get(chunk.tool.index) || '') + (chunk.tool.arguments || ''));
    expect(JSON.parse(calls.get(0)!)).toEqual({ path: 'file.ts' });
    expect(JSON.parse(calls.get(1)!)).toEqual({ pattern: '*.ts' });
    expect(chunks.find(c => c.type === 'usage')?.usage).toEqual({ inputTokens: 42, outputTokens: 12, cachedTokens: 8 });
  });
  it('parses CR/LF split boundaries and multiline SSE data', async () => {
    const bytes = new TextEncoder().encode('event: custom\r\ndata: {"a":\r\ndata: 1}\r\n\r\n');
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    const events = []; for await (const event of parseSSE(response, new AbortController().signal)) events.push(event);
    expect(events).toEqual([{ event: 'custom', data: '{"a":\n1}' }]);
  });
  it('does not silently complete truncated streams or execute partial calls', async () => {
    const base = await mock((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame(choice({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'bash', arguments: '{"command":' } }] }))); });
    await expect(collect(provider(base))).rejects.toThrow('ended before completion');
  });
  it('rejects malformed stream JSON and output-limit truncation', async () => {
    const base = await mock((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: nope\n\n'); });
    await expect(collect(provider(base))).rejects.toThrow('malformed streaming JSON');
    const second = await mock((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame(choice({}, 'length'))); });
    await expect(collect(provider(second))).rejects.toThrow('output limit');
  });
  it('cancels pending stream reads and closes the connection', async () => {
    let closed = false;
    const base = await mock((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(frame(choice({ content: 'start' })));
      res.on('close', () => { closed = true; });
    });
    const controller = new AbortController();
    const stream = streamCompletion({ provider: provider(base), model: 'x', messages: [], signal: controller.signal });
    expect((await stream.next()).value).toEqual({ type: 'text', text: 'start' });
    const pending = stream.next(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  it('sanitizes HTTP and mid-stream errors and never retries visible output', async () => {
    let requests = 0;
    const base = await mock((_req, res) => { requests++; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'secret=test-secret-never-expose', code: 'invalid_api_key' } })); });
    await expect(collect(provider(base))).rejects.toThrow('HTTP 401');
    expect(requests).toBe(1);
    try { await collect(provider(base)); } catch (e) { expect(String(e)).not.toContain('test-secret-never-expose'); }
    const streamed = await mock((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frame(choice({ content: 'partial' })) + frame({ error: { message: 'test-secret-never-expose', type: 'overloaded_error' } })); });
    await expect(collect(provider(streamed))).rejects.toThrow('stream failed');
  });
  it('does not forward API credentials through redirects', async () => {
    let hits = 0;
    const target = await mock((_req, res) => { hits++; res.end('{}'); });
    const redirect = await mock((_req, res) => { res.writeHead(302, { Location: target }).end(); });
    await expect(listModels(provider(redirect))).rejects.toThrow('Cannot reach provider');
    expect(hits).toBe(0);
  });
  it('lists gateway model aliases and explicit model IDs', async () => {
    const base = await mock((req, res) => { expect(req.url).toBe('/v1/models'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'team-coder' }, { id: 'vision', name: 'Vision', context_window: 128000 }] })); });
    expect(await listModels({ ...provider(base), models: ['extra'] })).toEqual([
      { id: 'extra', name: 'extra', providerId: 'test' }, { id: 'team-coder', name: 'team-coder', providerId: 'test' },
      { id: 'vision', name: 'Vision', providerId: 'test', contextWindow: 128000 },
    ]);
  });
  it('translates native Anthropic tool results and accumulates usage', async () => {
    let received: any;
    const base = await mock((req, res, body) => {
      received = { req: { headers: req.headers, url: req.url }, body };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
        { type: 'message_stop' },
      ].map(frame).join(''));
    });
    const chunks = [];
    for await (const c of streamCompletion({ provider: { ...provider(base), kind: 'anthropic' }, model: 'claude-model', system: 'system',
      messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'old' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } }], signal: new AbortController().signal })) chunks.push(c);
    expect(received.req.url).toBe('/v1/messages'); expect(received.req.headers['anthropic-version']).toBe('2023-06-01');
    expect(received.req.headers['x-api-key']).toBe('test-secret-never-expose');
    expect(received.body.messages[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'result' }] });
    expect(received.body.tools[0].input_schema).toEqual({ type: 'object', properties: {} });
    expect(chunks.at(-1)?.usage).toEqual({ inputTokens: 17, outputTokens: 6, cachedTokens: 4 });
  });
  it('refuses Anthropic subscriptions without an API key', async () => {
    await expect(collect({ ...provider('https://api.anthropic.com'), kind: 'anthropic', apiKey: '' })).rejects.toThrow('Subscription login is not supported');
  });
  it('preserves signed thinking blocks through the tool loop and scopes replay to the original model', async () => {
    const bodies: any[] = [];
    const base = await mock((_req, res, body) => {
      bodies.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(frame(choice({ reasoning_content: 'Think', thinking_blocks: [{ type: 'thinking', thinking: 'Think' }] })) +
        frame(choice({ thinking_blocks: [{ type: 'thinking', thinking: 'Think', signature: 'signed-state' }] })) + frame(choice({}, 'stop')) + 'data: [DONE]\n\n');
    });
    const chunks = await collect(provider(base));
    const providerMetadata = chunks.find(c => c.type === 'metadata')?.metadata;
    expect(providerMetadata?.thinking_blocks).toEqual([{ type: 'thinking', thinking: 'Think', signature: 'signed-state' }]);
    const run = async (model: string) => { for await (const _ of streamCompletion({ provider: provider(base), model, messages: [{ role: 'assistant', content: 'Answer', providerMetadata }], signal: new AbortController().signal })) { /* drain */ } };
    await run('my-model');
    expect(bodies[1].messages[0].thinking_blocks[0].signature).toBe('signed-state');
    expect(bodies[1].messages[0]).not.toHaveProperty('providerMetadata');
    await run('different-model');
    expect(bodies[2].messages[0]).not.toHaveProperty('thinking_blocks');
    expect(bodies[2].messages[0]).not.toHaveProperty('reasoning_content');
  });
  it('preserves complete encrypted Responses items without server-side item IDs', async () => {
    configureCodexAuth(async () => ({ accessToken: 'own-token' }));
    const events = [
      { type: 'response.output_item.done', output_index: 0, item: { id: 'reasoning-id', type: 'reasoning', summary: [], encrypted_content: 'opaque-state' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '' } },
      { type: 'response.output_item.done', output_index: 1, item: { id: 'function-id', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(events.map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } }); }));
    const p: Provider = { ...provider('https://unused.example'), kind: 'codex' };
    const chunks = await collect(p), providerMetadata = chunks.find(c => c.type === 'metadata')?.metadata;
    for await (const _ of streamCompletion({ provider: p, model: 'my-model', messages: [{ role: 'assistant', content: null, providerMetadata,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'call-1' }], signal: new AbortController().signal })) { /* drain */ }
    expect(bodies[1].input).toEqual([
      { type: 'reasoning', summary: [], encrypted_content: 'opaque-state' },
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'result' },
    ]);
  });
  it('uses the fixed Codex Responses endpoint and normalizes function calls', async () => {
    configureCodexAuth(async () => ({ accessToken: 'own-token', accountId: 'own-account', residency: 'us' }));
    const fetcher = vi.fn(async (_url: any, _init: any) => new Response([
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"a"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
    ].map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const chunks = await collect({ ...provider('https://not-the-token-recipient.example'), kind: 'codex' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(init.headers['ChatGPT-Account-Id']).toBe('own-account');
    expect(init.headers['x-openai-internal-codex-residency']).toBe('us');
    const body = JSON.parse(init.body); expect(body.store).toBe(false); expect(body.instructions).toBeTruthy(); expect(body.max_output_tokens).toBeUndefined();
    expect(chunks.filter(c => c.type === 'tool').map(c => c.tool?.arguments || '').join('')).toBe('{"path":"a"}');
  });
});
