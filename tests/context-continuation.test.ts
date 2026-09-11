import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { completeToolBoundary } from '../server/context.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, inputTokens?: number) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: (delta as any).tool_calls ? 'tool_calls' : 'stop' }], ...(inputTokens ? { usage: { prompt_tokens: inputTokens, completion_tokens: 20 } } : {}) })}\n\ndata: [DONE]\n\n`);
};
const isSummary = (body: any) => String(body.messages[0].content).startsWith('Summarize the supplied conversation');

describe('long-running context and gateway session continuity', () => {
  let directory: string, store: Store, server: Server, runner: ReturnType<typeof createApp>['runner'];
  let calls: { sessionId: string | undefined; body: any }[], respond: (body: any, res: ServerResponse) => void;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-continuation-')));
    store = new Store(join(directory, 'state')); calls = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ sessionId: req.headers['x-litellm-session-id'] as string | undefined, body }); respond(body, res);
    });
    store.saveSettings({ workspace: directory, maxSteps: 1, providers: [{ id: 'gateway', name: 'Gateway', kind: 'openai', baseUrl: await listen(server), contextWindows: { model: 16384 } }], defaultProvider: 'gateway', defaultModel: 'model' });
    runner = createApp({ store }).runner;
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('runs 70 steps through repeated compaction, preserves steering and tool groups, and resumes the same session', async () => {
    await writeFile(join(directory, 'fixture.txt'), Array.from({ length: 80 }, (_, i) => `fact ${i}`).join('\n'));
    const session = store.createSession(); let steps = 0, summaries = 0;
    respond = (body, res) => {
      if (isSummary(body)) { summaries++; stream(res, { content: 'Read-only fixture exploration remains in progress. Continue the user request and latest steering.' }); return; }
      if (++steps <= 70) {
        if (steps === 10) runner.steer(session.id, 'Keep the fixture unchanged and report the final fact.');
        stream(res, { content: `Progress ${steps}. ` + 'observed '.repeat(500), tool_calls: [{ index: 0, id: `read-${steps}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt', offset: steps, limit: 1 }) } }] });
      } else stream(res, { content: 'Finished the full task.' });
    };
    runner.start(session.id, 'Inspect all requested facts. Keep this exact user request.'); await runner.whenIdle();
    expect(steps).toBe(71); expect(summaries).toBeGreaterThanOrEqual(2);
    expect(store.session(session.id).status).toBe('idle');
    expect(store.messages(session.id).at(-1)?.content).toBe('Finished the full task.');
    expect(store.messages(session.id).filter(m => m.role === 'user')).toHaveLength(1);
    expect(store.messages(session.id).some(m => m.content.includes('[Steering]') && m.content.includes('Keep the fixture unchanged'))).toBe(true);
    expect(completeToolBoundary(store.messages(session.id))).toBe(store.messages(session.id).length);
    for (const { body } of calls.filter(call => !isSummary(call.body))) {
      const pending = new Set<string>();
      for (const message of body.messages) {
        for (const call of message.tool_calls ?? []) pending.add(call.id);
        if (message.role === 'tool') expect(pending.delete(message.tool_call_id)).toBe(true);
      }
      expect(pending.size).toBe(0);
      expect(body.messages.filter((m: any) => m.content === 'Inspect all requested facts. Keep this exact user request.')).toHaveLength(1);
    }
    expect(new Set(calls.map(call => call.sessionId))).toEqual(new Set([session.id]));
    respond = (_body, res) => stream(res, { content: 'Follow-up complete.' });
    runner.start(session.id, 'Now summarize.'); await runner.whenIdle();
    expect(calls.at(-1)?.sessionId).toBe(session.id);
    const next = store.createSession(); runner.start(next.id, 'New session.'); await runner.whenIdle();
    expect(calls.at(-1)?.sessionId).toBe(next.id);
    expect(runner.history.state(session.id).canUndo).toBe(true);
  }, 20_000);

  it('uses measured input when a gateway token count exceeds the text estimate', async () => {
    const session = store.createSession(); let normal = 0;
    await writeFile(join(directory, 'fixture.txt'), 'First fact\nSecond fact\n');
    respond = (body, res) => {
      if (isSummary(body)) return stream(res, { content: 'First fact was inspected; continue.' });
      if (++normal <= 3) return stream(res, { content: 'Observed context. '.repeat(250), tool_calls: [{ index: 0, id: `read-${normal}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt', offset: normal, limit: 1 }) } }] }, normal === 3 ? 15000 : 1000);
      stream(res, { content: 'Done.' });
    };
    runner.start(session.id, 'Inspect the fixture.'); await runner.whenIdle();
    expect(calls.filter(call => isSummary(call.body))).toHaveLength(1);
    expect(store.messages(session.id).at(-1)?.error).toBeUndefined();
    expect(store.messages(session.id).at(-1)?.content).toBe('Done.');
  });

  it('defaults memory on, honors an explicit opt-out, and ignores legacy step settings', () => {
    expect(store.publicSettings()).toMatchObject({ memoryEnabled: true });
    expect(store.publicSettings().maxSteps).toBeUndefined();
    store.saveSettings({ memoryEnabled: false });
    expect(store.settings().memoryEnabled).toBe(false);
    store.close(); store = new Store(join(directory, 'state'));
    expect(store.settings().memoryEnabled).toBe(false);
  });
});
