import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCompletion, type CompletionOptions } from '../server/providers.js';
import { resolveContextBudget } from '../server/budget.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { Provider } from '../shared/types.js';

const native: Provider = { id: 'native', name: 'Native', kind: 'anthropic', baseUrl: 'https://provider.invalid', apiKey: 'synthetic' };
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const complete = () => new Response([
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const collect = async (options: Partial<CompletionOptions> = {}) => {
  for await (const _ of streamCompletion({ provider: native, model: 'test-model', messages: [], signal: new AbortController().signal, ...options })) { /* drain */ }
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('native Anthropic output configuration', () => {
  it.each([
    { value: undefined, expected: 8192 },
    { value: '', expected: 8192 },
    { value: '  ', expected: 8192 },
    { value: '32768', expected: 32768 },
    { value: ' 16384 ', expected: 16384 },
  ])('sends and reserves $expected tokens with env=$value', async ({ value, expected }) => {
    vi.stubEnv('LITESPEED_ANTHROPIC_MAX_TOKENS', value);
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => complete());
    vi.stubGlobal('fetch', fetcher);
    await collect();
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(expected);
    expect(resolveContextBudget(native, 'test-model').outputReserve).toBe(expected);
  });

  it.each(['32768', 'invalid'])('preserves explicit per-call limits with env=%s', async value => {
    vi.stubEnv('LITESPEED_ANTHROPIC_MAX_TOKENS', value);
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => complete());
    vi.stubGlobal('fetch', fetcher);
    await collect({ maxOutputTokens: 1024 });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).max_tokens).toBe(1024);
  });

  it.each(['0', '-1', '8192.5', '32k', '32768junk', 'NaN', 'Infinity', '1e4', '0x8000', '9007199254740992'])('rejects invalid env=%s before sending a request', async value => {
    vi.stubEnv('LITESPEED_ANTHROPIC_MAX_TOKENS', value);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(collect()).rejects.toThrow('LITESPEED_ANTHROPIC_MAX_TOKENS must be a positive whole number');
    expect(() => resolveContextBudget(native, 'test-model')).toThrow('positive whole number');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['32768', 'invalid'])('leaves OpenAI-compatible requests and budgets independent of env=%s', async value => {
    vi.stubEnv('LITESPEED_ANTHROPIC_MAX_TOKENS', value);
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(frame({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher);
    const provider: Provider = { ...native, kind: 'openai' };
    await collect({ provider, model: 'claude-gateway-alias' });
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(resolveContextBudget(provider, 'claude-gateway-alias').outputReserve).toBe(4096);
  });
});

it('preserves a truncated write and its usage, then completes after the cap is raised', async () => {
  vi.stubEnv('LITESPEED_ANTHROPIC_MAX_TOKENS', undefined);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-output-limit-')));
  const store = new Store(join(directory, 'state'));
  const content = Array.from({ length: 2000 }, (_, i) => `export const value${i} = ${i};`).join('\n');
  const args = JSON.stringify({ path: 'large.ts', content });
  const requests: any[] = [];
  let runner: ReturnType<typeof createApp>['runner'] | undefined;
  const server: Server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const hasResult = body.messages.some((message: any) => message.content?.some((block: any) => block.type === 'tool_result'));
    // A deterministic provider fixture: the write needs 12,000 output tokens.
    const truncated = !hasResult && body.max_tokens < 12000;
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } },
      ...(hasResult ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } }] : [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'write-large', name: 'write_file', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: truncated ? args.slice(0, 32000) : args } },
        { type: 'content_block_stop', index: 0 },
      ]),
      { type: 'message_delta', delta: { stop_reason: hasResult ? 'end_turn' : truncated ? 'max_tokens' : 'tool_use' }, usage: { output_tokens: hasResult ? 1 : truncated ? body.max_tokens : 12000 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events.map(frame).join(''));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    store.saveSettings({ workspace: directory, providers: [{ ...native, baseUrl }], defaultProvider: native.id, defaultModel: 'test-model' });
    runner = createApp({ store }).runner;
    const session = store.createSession({ permissionMode: 'auto', title: 'Large file fixture' });
    runner.start(session.id, 'Write large.ts'); await runner.whenIdle();
    expect(requests).toHaveLength(1); // No automatic replay of the failed call.
    expect(requests[0].max_tokens).toBe(8192);
    expect(store.session(session.id).status).toBe('error');
    const failed = store.messages(session.id).find(message => message.error)!;
    expect(failed.error).toContain('max_tokens: 8192');
    expect(failed.error).toContain('LITESPEED_ANTHROPIC_MAX_TOKENS');
    expect(failed.usage).toMatchObject({ inputTokens: 100, outputTokens: 8192 });
    expect(store.messages(session.id).flatMap(message => message.toolCalls ?? [])).toEqual([]);
    await expect(readFile(join(directory, 'large.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    vi.stubEnv('LITESPEED_ANTHROPIC_MAX_TOKENS', '32768');
    runner.start(session.id, 'Resume the file write'); await runner.whenIdle();
    expect(requests).toHaveLength(3); // Complete write, then final answer.
    expect(requests.slice(1).map(body => body.max_tokens)).toEqual([32768, 32768]);
    expect(store.session(session.id).status).toBe('idle');
    expect(await readFile(join(directory, 'large.ts'), 'utf8')).toBe(content);
    expect(store.messages(session.id).flatMap(message => message.toolCalls ?? [])).toMatchObject([{ name: 'write_file', status: 'completed' }]);
    expect(store.messages(session.id).filter(message => message.error)).toEqual([failed]);
  } finally {
    runner?.stopAll(); await runner?.whenIdle();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); await rm(directory, { recursive: true, force: true });
  }
});
