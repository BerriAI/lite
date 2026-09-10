import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { PRUNE_MARKER } from '../server/context.js';
import { modelCatalog } from '../server/budget.js';
import type { Message, Provider } from '../shared/types.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const delta = (res: ServerResponse, value: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
const text = (res: ServerResponse, content: string) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { content }, 'stop'); res.end('data: [DONE]\n\n'); };
const toolCall = (res: ServerResponse, path: string) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] }, 'tool_calls'); res.end('data: [DONE]\n\n'); };
const overflow = (res: ServerResponse) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"context_length_exceeded"}}'); };
const summaryRequest = (body: any) => body.messages?.[0]?.content?.startsWith('Summarize the supplied conversation');
const MIDDLE = 'MIDDLE_SENTINEL_ONLY_IN_FULL_OUTPUT';

describe('prune-first compaction ladder in the Runner', () => {
  let directory: string, store: Store, runner: ReturnType<typeof createApp>['runner'], server: Server, providerServer: Server, provider: Provider;
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  beforeEach(async () => {
    modelCatalog.clear(); directory = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-prune-runner-'))); store = new Store(join(directory, 'state')); calls = [];
    // 400 lines x ~90 chars: read_file's numbered output hits its 32768-char cap,
    // far over the 8192 prune threshold; the sentinel sits mid-output so pruning
    // must remove it while head and tail survive.
    const lines = Array.from({ length: 400 }, (_, i) => i === 0 ? 'HEAD_SENTINEL ' + 'h'.repeat(75) : i === 180 ? MIDDLE + ' ' + 'm'.repeat(50) : `line ${i} ` + 'x'.repeat(80));
    await writeFile(join(directory, 'big.txt'), lines.join('\n'));
    respond = (_body, res) => text(res, 'Done');
    providerServer = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    provider = { id: 'prune', name: 'Prune', kind: 'openai', baseUrl: await listen(providerServer), contextWindows: { 'prune-model': 12288 } };
    store.saveSettings({ workspace: directory, providers: [provider], defaultProvider: provider.id, defaultModel: 'prune-model' });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); modelCatalog.clear(); await close(server); await close(providerServer); store.close(); await rm(directory, { recursive: true, force: true }); });
  const run = async (id: string, input: string) => { runner.start(id, input); await runner.whenIdle(); };
  const lastContext = (id: string) => store.messages(id).filter(message => message.role === 'assistant').at(-1)?.context;
  const bigToolTurn = (sessionId: string): Message[] => [
    { id: randomUUID(), sessionId, role: 'user', content: 'Old request', createdAt: 1 },
    { id: randomUUID(), sessionId, role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'big.txt' }, status: 'completed' }], createdAt: 2 },
    { id: randomUUID(), sessionId, role: 'tool', content: 'HEAD_SENTINEL ' + 'x'.repeat(16000) + MIDDLE + 'y'.repeat(16000) + ' TAIL_SENTINEL', toolCallId: 'c1', createdAt: 3 },
  ];

  it('proactive compact prunes old tool output in the outbound request only and skips the paid summary', async () => {
    const session = store.createSession();
    let completions = 0;
    respond = (_body, res) => ++completions === 1 ? toolCall(res, 'big.txt') : text(res, 'Done');
    await run(session.id, 'Read the big file');
    expect(calls).toHaveLength(2);
    const fullOutput = store.messages(session.id).find(message => message.role === 'tool')!.content;
    expect(fullOutput.length).toBeGreaterThan(30_000); expect(fullOutput).toContain(MIDDLE);
    expect(store.session(session.id).status).toBe('idle');

    await run(session.id, 'Now summarize what you read');
    expect(calls).toHaveLength(3);
    expect(calls.filter(summaryRequest)).toHaveLength(0); // The free rung replaced the paid one.
    const outbound = JSON.stringify(calls[2]);
    expect(outbound).toContain('pruned to save context'); expect(outbound).toContain('the full output was shown when the tool ran');
    expect(outbound).toContain('HEAD_SENTINEL'); expect(outbound).not.toContain(MIDDLE);
    // Persisted history, and therefore the transcript and exports, keep every byte.
    expect(store.messages(session.id).find(message => message.role === 'tool')!.content).toBe(fullOutput);
    expect(store.sessions('', true)).toHaveLength(0); // No archive: history was never rewritten.
    const context = lastContext(session.id)!;
    expect(context.action).toBe('continue');
    expect(context.reason).toContain('pruned');
    expect(context.reason).toContain('conversation history is unchanged');
    // Cache diagnostics must not claim a history rewrite for a projection-only change.
    expect(context.cache?.reasons ?? []).not.toContain('history_compacted');
    expect(store.session(session.id).status).toBe('idle');
  });

  it('falls through to the existing summarize path when pruning alone is insufficient', async () => {
    const session = store.createSession();
    const seeded = [...bigToolTurn(session.id), { id: randomUUID(), sessionId: session.id, role: 'assistant' as const, content: 'Old answer ' + 'y'.repeat(40_000), createdAt: 4 }];
    seeded.forEach(message => store.saveMessage(message));
    respond = (body, res) => text(res, summaryRequest(body) ? 'Earlier work summarized faithfully.' : 'Done');
    await run(session.id, 'Latest task');
    expect(calls).toHaveLength(2);
    expect(calls.filter(summaryRequest)).toHaveLength(1);
    expect(store.sessions('', true)).toHaveLength(1); // Summarization archives the original history.
    expect(store.messages(store.sessions('', true)[0].id).some(message => message.content.includes(MIDDLE))).toBe(true);
    expect(lastContext(session.id)?.reason).toContain('compacted');
    expect(store.session(session.id).status).toBe('idle');
  });

  it('explicit provider overflow retries with pruning before consuming the one automatic summary attempt', async () => {
    store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] }); // Unknown window: no proactive rung fires.
    const session = store.createSession();
    bigToolTurn(session.id).forEach(message => store.saveMessage(message));
    let completions = 0;
    respond = (_body, res) => ++completions === 1 ? overflow(res) : text(res, 'Done after pruned retry');
    await run(session.id, 'Latest task');
    expect(calls).toHaveLength(2);
    expect(calls.filter(summaryRequest)).toHaveLength(0);
    const retry = JSON.stringify(calls[1]);
    expect(retry).toContain('pruned to save context'); expect(retry).not.toContain(MIDDLE);
    expect(store.messages(session.id).find(message => message.role === 'tool')!.content).toContain(MIDDLE);
    expect(store.sessions('', true)).toHaveLength(0);
    expect(lastContext(session.id)?.reason).toMatch(/rejected context size.*pruned/s);
    expect(store.messages(session.id).at(-1)?.content).toBe('Done after pruned retry');
    expect(store.session(session.id).status).toBe('idle');
  });

  it('overflow with nothing prunable still uses the existing summary recovery', async () => {
    const session = store.createSession();
    store.saveMessage({ id: randomUUID(), sessionId: session.id, role: 'user', content: 'Old request ' + 'x'.repeat(30_000), createdAt: 1 });
    store.saveMessage({ id: randomUUID(), sessionId: session.id, role: 'assistant', content: 'Old answer ' + 'y'.repeat(30_000), createdAt: 2 });
    store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] });
    let completions = 0;
    respond = (body, res) => summaryRequest(body) ? text(res, 'Summary of the earlier exchange.') : ++completions === 1 ? overflow(res) : text(res, 'Done');
    await run(session.id, 'Latest task');
    expect(calls.filter(summaryRequest)).toHaveLength(1);
    expect(store.sessions('', true)).toHaveLength(1);
    expect(store.session(session.id).status).toBe('idle');
  });
});
