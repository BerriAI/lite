import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Runner } from '../server/runner.js';
import { EventBus } from '../server/events.js';
import type { FileChange, Message } from '../shared/types.js';

type RequestBody = { messages: { role: string; content: unknown }[] };
type Reply = (body: RequestBody, response: ServerResponse, index: number) => void;
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for runner'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const noUnhandled = async (work: () => Promise<void>) => {
  const errors: unknown[] = [], capture = (error: unknown) => { errors.push(error); };
  process.on('unhandledRejection', capture);
  try { await work(); await new Promise<void>(resolve => setImmediate(resolve)); expect(errors).toEqual([]); }
  finally { process.off('unhandledRejection', capture); }
};
const delta = (res: ServerResponse, value: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value }] })}\n\n`);
const finish = (res: ServerResponse, reason = 'stop') => {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const text = (res: ServerResponse, value = 'Done') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { content: value }); finish(res); };
const tools = (res: ServerResponse, calls: { name: string; args: unknown; id?: string }[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  delta(res, { tool_calls: calls.map((call, index) => ({ index, id: call.id ?? `call-${index}`, type: 'function', function: { name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args) } })) });
  finish(res, 'tool_calls');
};

describe('runner and turn history integration', () => {
  let directory: string, store: Store, bus: EventBus, runner: Runner, provider: Server, reply: Reply, calls: RequestBody[];
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-history-runner-')));
    store = new Store(join(directory, 'state')); calls = []; reply = (_body, response) => text(response);
    provider = createServer(async (req, res) => {
      const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(chunk);
      const body = JSON.parse(Buffer.concat(buffers).toString()) as RequestBody;
      calls.push(body); reply(body, res, calls.length);
    });
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl: await listen(provider) }], defaultProvider: 'test', defaultModel: 'test-model' });
    bus = new EventBus(store); runner = new Runner(store, bus);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); runner.stopAll();
    await until(() => store.sessions().every(session => !runner.active(session.id)), 100).catch(() => {});
    await close(provider); store.close(); await rm(directory, { recursive: true, force: true });
  });
  const idle = (id: string) => until(() => !runner.active(id));
  const turn = async (id: string, content: string) => { runner.start(id, content); await idle(id); };
  const rowStatus = (id: string) => (store.db.prepare('SELECT status FROM history_checkpoints WHERE session_id=? ORDER BY sequence DESC LIMIT 1').get(id) as { status: string } | undefined)?.status;
  const intentCount = (id: string) => (store.db.prepare('SELECT COUNT(*) AS count FROM history_intents WHERE session_id=?').get(id) as { count: number }).count;
  const recover = (id: string) => runner.exclusive(id, () => runner.history.recover(id));
  const undo = (id: string) => runner.exclusive(id, () => runner.history.undo(id, runner.history.state(id).undoId!));
  const redo = (id: string) => runner.exclusive(id, () => runner.history.redo(id, runner.history.state(id).redoId!));

  it('seals cancellation while awaiting a parallel tool group without inventing edits or replaying work', async () => {
    const s = store.createSession();
    reply = (_body, res) => tools(res, [
      { name: 'write_file', args: { path: 'one.txt', content: 'one' }, id: 'one' },
      { name: 'write_file', args: { path: 'two.txt', content: 'two' }, id: 'two' },
    ]);
    runner.start(s.id, 'Write two files'); await until(() => runner.permissions(s.id).length === 1);
    runner.enqueue(s.id, 'Wait for explicit resume'); runner.cancel(s.id); await idle(s.id);
    const original = store.messages(s.id), callsBefore = calls.length;
    expect(original.flatMap(message => message.toolCalls ?? []).map(call => call.status)).toEqual(['denied', 'denied']);
    expect(original.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['one', 'two']);
    expect(intentCount(s.id)).toBe(0); expect(store.changes(s.id)).toEqual([]);
    expect(runner.history.state(s.id)).toMatchObject({ canUndo: true });
    expect(runner.history.state(s.id).pendingRecovery).toBeUndefined();
    expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Wait for explicit resume' }] });
    await undo(s.id); expect(store.messages(s.id)).toEqual([]); await redo(s.id); expect(store.messages(s.id)).toEqual(original);
    expect(calls).toHaveLength(callsBefore); await expect(readFile(join(directory, 'one.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a mutation even when the next provider request fails, and undo/redo never call the provider', async () => {
    const s = store.createSession({ permissionMode: 'auto' }); await writeFile(join(directory, 'result.txt'), 'before');
    reply = (_body, res, index) => {
      if (index === 1) tools(res, [{ name: 'write_file', args: { path: 'result.txt', content: 'after' } }]);
      else { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"invalid_api_key"}}'); }
    };
    await turn(s.id, 'Write then encounter provider failure');
    expect(store.session(s.id).status).toBe('error'); expect(rowStatus(s.id)).toBe('applied'); expect(intentCount(s.id)).toBe(0);
    expect(store.changes(s.id)).toEqual([{ path: 'result.txt', before: 'before', after: 'after' }]);
    const messages = store.messages(s.id); await undo(s.id); expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('before');
    await redo(s.id); expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('after'); expect(store.messages(s.id)).toEqual(messages); expect(calls).toHaveLength(2);
  });

  it('seals malformed tool arguments as a matched failed tool with no file intent and holds the queue', async () => {
    const s = store.createSession({ permissionMode: 'auto' });
    reply = (_body, res, index) => { if (index === 1) { runner.enqueue(s.id, 'Held follow-up'); tools(res, [{ name: 'write_file', args: '{not json' }]); } else text(res); };
    await turn(s.id, 'Malformed tool request');
    expect(store.messages(s.id).flatMap(message => message.toolCalls ?? []).map(call => call.status)).toEqual(['error']);
    expect(store.messages(s.id).filter(message => message.role === 'tool')).toHaveLength(1);
    expect(intentCount(s.id)).toBe(0); expect(runner.history.state(s.id).canUndo).toBe(true);
    expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Held follow-up' }] }); expect(calls).toHaveLength(2);
  });

  it('recovers a mutation whose durable commit callback failed without re-executing its tool', async () => {
    const s = store.createSession({ permissionMode: 'auto' }); await writeFile(join(directory, 'result.txt'), 'before');
    store.db.exec("CREATE TRIGGER reject_intent_commit BEFORE DELETE ON history_intents BEGIN SELECT RAISE(ABORT, 'intent commit failed'); END;");
    reply = (_body, res, index) => { if (index === 1) { runner.enqueue(s.id, 'Next queued task'); tools(res, [{ name: 'write_file', args: { path: 'result.txt', content: 'after' } }]); } else text(res); };
    await turn(s.id, 'Write with interrupted bookkeeping');
    expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('after'); expect(store.changes(s.id)).toEqual([]); expect(intentCount(s.id)).toBe(1);
    expect(rowStatus(s.id)).toBe('interrupted'); expect(runner.history.state(s.id).pendingRecovery?.paths).toEqual(['result.txt']);
    expect(() => runner.resumeQueue(s.id)).toThrow(); expect(() => runner.start(s.id, 'Do not bypass recovery')).toThrow();
    store.db.exec('DROP TRIGGER reject_intent_commit'); const count = calls.length;
    await recover(s.id); expect(intentCount(s.id)).toBe(0); expect(runner.history.state(s.id)).toMatchObject({ canUndo: true });
    expect(store.changes(s.id)).toEqual([{ path: 'result.txt', before: 'before', after: 'after' }]); expect(store.queue(s.id).paused).toBe(true);
    await undo(s.id); expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('before'); await redo(s.id); expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('after'); expect(calls).toHaveLength(count);
  });

  it('cancellation after intent preparation leaves recovery explicit and does not mutate the file', async () => {
    const s = store.createSession({ permissionMode: 'auto' }); await writeFile(join(directory, 'result.txt'), 'before');
    const prepare = runner.history.prepareChange.bind(runner.history);
    vi.spyOn(runner.history, 'prepareChange').mockImplementation((id: string, change: FileChange) => { prepare(id, change); runner.cancel(id); });
    reply = (_body, res) => tools(res, [{ name: 'write_file', args: { path: 'result.txt', content: 'after' } }]);
    await turn(s.id, 'Cancel immediately after recording intent');
    expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('before'); expect(intentCount(s.id)).toBe(1);
    expect(runner.history.state(s.id).pendingRecovery?.paths).toEqual(['result.txt']);
    await recover(s.id); expect(intentCount(s.id)).toBe(0); expect(store.changes(s.id)).toEqual([]); expect(runner.history.state(s.id).canUndo).toBe(true); expect(calls).toHaveLength(1);
  });

  it('blocks an incomplete imported group before queue acceptance, then recovers without provider replay', async () => {
    const s = store.createSession(); const imported: Message[] = [
      { id: randomUUID(), sessionId: s.id, role: 'user', content: 'Imported intent', createdAt: 1 },
      { id: randomUUID(), sessionId: s.id, role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'unknown-result', name: 'bash', args: { command: 'not replayable' }, status: 'running' }] },
    ]; imported.forEach(message => store.saveMessage(message)); runner.enqueue(s.id, 'New queued work');
    const queued = store.queue(s.id); expect(runner.history.state(s.id).pendingRecovery).toBeTruthy();
    expect(() => runner.resumeQueue(s.id)).toThrow(); expect(store.queue(s.id)).toEqual(queued); expect(calls).toHaveLength(0); expect(runner.history.hasCheckpoints(s.id)).toBe(false);
    await recover(s.id); expect(calls).toHaveLength(0); expect(store.sessions('', true)).toHaveLength(1); expect(store.queue(s.id).items).toEqual(queued.items);
    runner.resumeQueue(s.id); await idle(s.id); expect(calls).toHaveLength(1); expect(store.queue(s.id).items).toEqual([]); expect(runner.history.state(s.id).canUndo).toBe(true);
  });

  it('stopAll seals active cancelled work and aborts preparations without accepting queued snapshots', async () => {
    const s = store.createSession(), preparing = store.createSession();
    reply = (_body, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { content: 'Partial' }); };
    runner.start(s.id, 'Active at shutdown'); await until(() => calls.length === 1);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const submission = runner.submit(preparing.id, async () => { await gate; return { content: 'Never accepted' }; }).catch(error => error);
    const queueSubmission = runner.submitQueued(s.id, async () => { await gate; return { content: 'Never queued' }; }).catch(error => error);
    runner.stopAll(); release(); expect(await submission).toMatchObject({ status: 409 }); expect(await queueSubmission).toMatchObject({ status: 409 }); await idle(s.id);
    expect(store.messages(preparing.id)).toEqual([]); expect(runner.history.hasCheckpoints(preparing.id)).toBe(false);
    expect(store.queue(s.id).items).toEqual([]); expect(runner.history.state(s.id).canUndo).toBe(true); expect(rowStatus(s.id)).toBe('applied'); expect(calls).toHaveLength(1);
  });

  it('captures automatic compaction inside a turn and restores the original transcript on undo', async () => {
    const s = store.createSession(); await turn(s.id, 'Old turn one'); await turn(s.id, 'Old turn two');
    const before = store.messages(s.id); let recoveryCalls = 0;
    reply = (_body, res) => {
      if (++recoveryCalls === 1) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"context_length_exceeded"}}'); }
      else text(res, recoveryCalls === 2 ? 'Summary of earlier turns' : 'Continued after compaction');
    };
    await turn(s.id, 'Keep latest task'); const after = store.messages(s.id), count = calls.length;
    expect(after.map(message => message.role)).toEqual(['system', 'user', 'assistant']); expect(after[1].content).toBe('Keep latest task'); expect(store.sessions('', true)).toHaveLength(1);
    await undo(s.id); expect(store.messages(s.id)).toEqual(before); await redo(s.id); expect(store.messages(s.id)).toEqual(after); expect(calls).toHaveLength(count);
  });

  it.each(['manual', 'automatic'] as const)('cancelling %s summarization keeps history undoable and never commits a partial summary', async mode => {
    const s = store.createSession(); await turn(s.id, 'Old turn one'); await turn(s.id, 'Old turn two');
    const before = store.messages(s.id), checkpoint = runner.history.state(s.id).undoId;
    let requests = 0, summaryStarted = false;
    reply = (_body, res) => {
      if (mode === 'automatic' && ++requests === 1) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"context_length_exceeded"}}'); }
      else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); delta(res, { content: 'Incomplete summary must not replace history' }); summaryStarted = true; }
    };
    let compaction: Promise<unknown> | undefined;
    if (mode === 'manual') compaction = runner.compact(s.id).catch(error => error);
    else runner.start(s.id, 'Latest accepted task');
    await until(() => summaryStarted); runner.enqueue(s.id, 'Held after cancelled compaction'); runner.cancel(s.id);
    if (compaction) expect(await compaction).toBeInstanceOf(Error);
    await idle(s.id);
    expect(store.sessions('', true)).toHaveLength(0);
    expect(store.messages(s.id).slice(0, before.length)).toEqual(before);
    expect(runner.history.state(s.id).pendingRecovery).toBeUndefined(); expect(runner.history.state(s.id).canUndo).toBe(true);
    expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Held after cancelled compaction' }] });
    const count = calls.length, after = store.messages(s.id);
    if (mode === 'manual') { expect(after).toEqual(before); expect(runner.history.state(s.id).undoId).toBe(checkpoint); }
    await undo(s.id);
    expect(store.messages(s.id)).toEqual(mode === 'automatic' ? before : before.slice(0, 2));
    await redo(s.id); expect(store.messages(s.id)).toEqual(after); expect(calls).toHaveLength(count);
  });

  it('releases the run and exposes recoverable history if checkpoint sealing fails', async () => {
    const s = store.createSession();
    store.db.exec("CREATE TRIGGER reject_seal BEFORE UPDATE OF status ON history_checkpoints WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT, 'seal failed'); END;");
    await turn(s.id, 'Completed provider output but failed seal');
    expect(store.session(s.id).status).toBe('error'); expect(runner.active(s.id)).toBe(false); expect(calls).toHaveLength(1);
    store.db.exec('DROP TRIGGER reject_seal');
    expect(runner.history.state(s.id).pendingRecovery).toBeTruthy();
    await recover(s.id); expect(runner.history.state(s.id)).toMatchObject({ canUndo: true });
    await undo(s.id); expect(store.messages(s.id)).toEqual([]); expect(calls).toHaveLength(1);
  });

  it('does not strand an accepted queued turn when the first live event cannot be recorded', async () => {
    const s = store.createSession(); const queue = runner.enqueue(s.id, 'Accepted before event failure');
    store.saveQueue(s.id, { ...queue, paused: false });
    store.db.exec("CREATE TRIGGER reject_message_event BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.type')='message' BEGIN SELECT RAISE(ABORT, 'message event failed'); END;");
    expect(() => runner.start(s.id, queue.items[0].content, queue.items[0].attachments, queue.items[0].id)).toThrow('message event failed');
    store.db.exec('DROP TRIGGER reject_message_event');
    expect(store.messages(s.id).map(message => message.content)).toEqual(['Accepted before event failure']); expect(store.queue(s.id).items).toEqual([]);
    expect(runner.active(s.id)).toBe(false);
    expect(runner.history.state(s.id).pendingRecovery || runner.history.state(s.id).canUndo).toBeTruthy();
    if (runner.history.state(s.id).pendingRecovery) await recover(s.id);
    await undo(s.id); expect(store.messages(s.id)).toEqual([]); expect(calls).toHaveLength(0);
  });

  it.each(['startup', 'response', 'finalization'] as const)('persistent event failure during %s releases the run and holds remaining queued work', async phase => noUnhandled(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store.createSession(); runner.enqueue(s.id, 'Accepted once'); const queue = runner.enqueue(s.id, 'Must stay queued');
    store.saveQueue(s.id, { ...queue, paused: false });
    const failEvents = () => store.db.exec("CREATE TRIGGER reject_all_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'persistent event failure'); END;");
    if (phase === 'startup') failEvents();
    else if (phase === 'response') reply = (_body, res) => { failEvents(); text(res, 'Output before event failure'); };
    else {
      const seal = runner.history.seal.bind(runner.history);
      vi.spyOn(runner.history, 'seal').mockImplementation(id => { seal(id); failEvents(); });
    }
    try {
      const start = () => runner.start(s.id, queue.items[0].content, queue.items[0].attachments, queue.items[0].id);
      if (phase === 'startup') expect(start).toThrow('persistent event failure'); else start();
      await runner.whenIdle(); expect(runner.active(s.id)).toBe(false);
      expect(store.session(s.id).status).toBe('error'); expect(rowStatus(s.id)).toBe('applied');
      expect(store.messages(s.id).filter(message => message.role === 'user').map(message => message.content)).toEqual(['Accepted once']);
      expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ id: queue.items[1].id, content: 'Must stay queued' }] });
      expect(calls).toHaveLength(phase === 'startup' ? 0 : 1);
    } finally { store.db.exec('DROP TRIGGER IF EXISTS reject_all_events'); }
    const messages = store.messages(s.id), count = calls.length;
    expect(runner.history.state(s.id).pendingRecovery).toBeUndefined(); expect(runner.history.state(s.id).canUndo).toBe(true);
    await undo(s.id); expect(store.messages(s.id)).toEqual([]); await redo(s.id); expect(store.messages(s.id)).toEqual(messages); expect(calls).toHaveLength(count);
  }));

  it('combined seal and persistent event failures release live state for explicit recovery without replay', async () => noUnhandled(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store.createSession();
    const seal = runner.history.seal.bind(runner.history);
    vi.spyOn(runner.history, 'seal').mockImplementation(id => {
      store.db.exec("CREATE TRIGGER reject_all_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'persistent event failure'); END;");
      return seal(id);
    });
    store.db.exec("CREATE TRIGGER reject_seal BEFORE UPDATE OF status ON history_checkpoints WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT, 'seal failed'); END;");
    reply = (_body, res) => { runner.enqueue(s.id, 'Held after failed seal'); text(res, 'Finished response'); };
    try {
      runner.start(s.id, 'Accepted with both persistence failures'); await runner.whenIdle();
      expect(runner.active(s.id)).toBe(false); expect(store.session(s.id).status).toBe('error'); expect(rowStatus(s.id)).toBe('open');
      expect(runner.history.state(s.id)).toMatchObject({ canUndo: false }); expect(runner.history.state(s.id).pendingRecovery).toBeTruthy();
      expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Held after failed seal' }] }); expect(calls).toHaveLength(1);
    } finally { store.db.exec('DROP TRIGGER IF EXISTS reject_all_events; DROP TRIGGER reject_seal;'); vi.restoreAllMocks(); }
    await recover(s.id); expect(runner.history.state(s.id).canUndo).toBe(true);
    const messages = store.messages(s.id); await undo(s.id); await redo(s.id); expect(store.messages(s.id)).toEqual(messages); expect(calls).toHaveLength(1);
  }));

  it('cancel aborts a pending permission and preparations even when its queue event fails', async () => noUnhandled(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store.createSession(), preparing = store.createSession();
    reply = (_body, res) => tools(res, [{ name: 'write_file', args: { path: 'cancelled.txt', content: 'Never written' } }]);
    runner.start(s.id, 'Wait for permission'); await until(() => runner.permissions(s.id).length === 1);
    runner.enqueue(s.id, 'Must stay queued'); const gate = deferred();
    const direct = runner.submit(preparing.id, async () => { await gate.promise; return { content: 'Never accepted' }; }).catch(error => error);
    const queued = runner.submitQueued(s.id, async () => { await gate.promise; return { content: 'Never queued' }; }).catch(error => error);
    store.db.exec("CREATE TRIGGER reject_queue_event BEFORE INSERT ON events WHEN json_extract(NEW.data, '$.type')='queue' BEGIN SELECT RAISE(ABORT, 'queue event failed'); END;");
    try {
      expect(() => runner.cancel(s.id)).toThrow('queue event failed'); expect(() => runner.cancel(preparing.id)).toThrow('queue event failed');
      gate.release(); expect(await direct).toMatchObject({ status: 409 }); expect(await queued).toMatchObject({ status: 409 }); await runner.whenIdle();
      expect(runner.permissions(s.id)).toEqual([]); expect(runner.active(s.id)).toBe(false);
      expect(store.messages(s.id).flatMap(message => message.toolCalls ?? []).map(call => call.status)).toEqual(['denied']);
      expect(store.messages(s.id).filter(message => message.role === 'tool')).toHaveLength(1);
      expect(store.messages(preparing.id)).toEqual([]); expect(intentCount(s.id)).toBe(0); expect(runner.history.state(s.id).canUndo).toBe(true);
      expect(store.queue(s.id)).toMatchObject({ paused: true, items: [{ content: 'Must stay queued' }] }); expect(calls).toHaveLength(1);
      await expect(readFile(join(directory, 'cancelled.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { gate.release(); store.db.exec('DROP TRIGGER reject_queue_event'); await Promise.all([direct, queued]); }
  }));

  it('whenIdle waits for every cancelled preparation and stopAll rejects new work without invoking it', async () => {
    const directSession = store.createSession(), queuedSession = store.createSession();
    const directGate = deferred(), firstQueueGate = deferred(), secondQueueGate = deferred();
    const direct = runner.submit(directSession.id, async () => { await directGate.promise; return { content: 'Never accepted' }; }).catch(error => error);
    const first = runner.submitQueued(queuedSession.id, async () => { await firstQueueGate.promise; return { content: 'Never queued one' }; }).catch(error => error);
    const second = runner.submitQueued(queuedSession.id, async () => { await secondQueueGate.promise; return { content: 'Never queued two' }; }).catch(error => error);
    let settled = false; const wait = runner.whenIdle().then(() => { settled = true; }); const otherWait = runner.whenIdle();
    try {
      runner.stopAll(); await Promise.resolve(); expect(settled).toBe(false);
      const snapshot = vi.fn(async () => ({ content: 'Blocked' })), operation = vi.fn(async () => undefined);
      expect(() => runner.start(directSession.id, 'Blocked')).toThrow('stopping'); expect(() => runner.enqueue(queuedSession.id, 'Blocked')).toThrow('stopping'); expect(() => runner.resumeQueue(queuedSession.id)).toThrow('stopping');
      await expect(runner.submit(directSession.id, snapshot)).rejects.toThrow('stopping'); await expect(runner.submitQueued(queuedSession.id, snapshot)).rejects.toThrow('stopping'); await expect(runner.exclusive(directSession.id, operation)).rejects.toThrow('stopping');
      expect(snapshot).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
      directGate.release(); expect(await direct).toMatchObject({ status: 409 }); expect(settled).toBe(false);
      firstQueueGate.release(); expect(await first).toMatchObject({ status: 409 }); expect(settled).toBe(false);
      secondQueueGate.release(); expect(await second).toMatchObject({ status: 409 }); await Promise.all([wait, otherWait]); expect(settled).toBe(true);
      expect(store.messages(directSession.id)).toEqual([]); expect(store.queue(queuedSession.id).items).toEqual([]); expect(calls).toHaveLength(0);
    } finally { directGate.release(); firstQueueGate.release(); secondQueueGate.release(); await Promise.all([direct, first, second]); }
  });

  it.each([false, true])('whenIdle waits for an exclusive operation to settle after stopAll (reject=%s)', async reject => {
    const s = store.createSession(), gate = deferred();
    const operation = runner.exclusive(s.id, async () => { await gate.promise; if (reject) throw new Error('operation failed'); return 'finished'; }).catch(error => error);
    let settled = false; const wait = runner.whenIdle().then(() => { settled = true; });
    try {
      runner.stopAll(); await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
      gate.release(); const result = await operation; if (reject) expect(result).toMatchObject({ message: 'operation failed' }); else expect(result).toBe('finished');
      await wait; expect(settled).toBe(true); await runner.whenIdle(); expect(calls).toHaveLength(0);
    } finally { gate.release(); await operation; }
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('%s during a mutation preserves recoverable history without replay; graceful shutdown seals before exit', async signal => {
    const s = store.createSession({ permissionMode: 'auto' });
    reply = (_body, res) => tools(res, [{ name: 'write_file', args: { path: 'shutdown-result.txt', content: 'Completed shutdown bytes' } }]);
    const portServer = createNetServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = (portServer.address() as { port: number }).port; await new Promise<void>(resolve => portServer.close(() => resolve()));
    const index = new URL('../server/index.ts', import.meta.url).href;
    const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
    // Stretch an ordinary async write completion window without editing the fixture or app.
    const source = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; import {constants} from 'node:fs';
      const original=fs.open; fs.open=async(...args)=>{const handle=await original(...args);
        if(String(args[0]).endsWith('/shutdown-result.txt')&&(Number(args[1])&constants.O_WRONLY)){
          const write=handle.writeFile.bind(handle); handle.writeFile=async(...values)=>{await write(...values);console.log('TEST_HISTORY_MUTATION_WRITTEN');await new Promise(r=>setTimeout(r,400));};
        } return handle;}; syncBuiltinESMExports(); await import(${JSON.stringify(index)});`;
    const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', source], {
      cwd: directory,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: directory, LITE_DATA_DIR: store.directory, LITE_PORT: String(port), NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      await until(() => {
        if (child.exitCode !== null) throw new Error(`Fixture exited before startup: ${stderr}`);
        return stdout.includes(`http://localhost:${port}`);
      }, 8000);
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Write before stopping' }) });
      expect(response.status).toBe(202); await response.json();
      await until(() => stdout.includes('TEST_HISTORY_MUTATION_WRITTEN'));
      child.kill(signal); const result = await exited;
      expect(result).toEqual(signal === 'SIGTERM' ? { code: 0, signal: null } : { code: null, signal: 'SIGKILL' });
      expect(await readFile(join(directory, 'shutdown-result.txt'), 'utf8')).toBe('Completed shutdown bytes');
      if (signal === 'SIGTERM') {
        expect(intentCount(s.id)).toBe(0); expect(rowStatus(s.id)).toBe('applied');
        expect(store.changes(s.id)).toEqual([{ path: 'shutdown-result.txt', before: null, after: 'Completed shutdown bytes' }]);
      } else {
        expect(intentCount(s.id)).toBe(1); expect(rowStatus(s.id)).toBe('open'); expect(store.changes(s.id)).toEqual([]);
      }
      // A fresh process must not write or replay anything merely by opening the database.
      const restarted = new Store(store.directory);
      try {
        const resumed = new Runner(restarted, new EventBus(restarted));
        expect(await readFile(join(directory, 'shutdown-result.txt'), 'utf8')).toBe('Completed shutdown bytes'); expect(calls).toHaveLength(1);
        if (signal === 'SIGKILL') {
          expect(resumed.history.state(s.id).pendingRecovery?.paths).toEqual(['shutdown-result.txt']);
          await resumed.exclusive(s.id, () => resumed.history.recover(s.id));
          expect(restarted.sessions('', true)).toHaveLength(1);
        } else expect(resumed.history.state(s.id).pendingRecovery).toBeUndefined();
        expect(resumed.history.state(s.id).canUndo).toBe(true);
        const messages = restarted.messages(s.id);
        await resumed.exclusive(s.id, () => resumed.history.undo(s.id, resumed.history.state(s.id).undoId!));
        await expect(readFile(join(directory, 'shutdown-result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(restarted.messages(s.id)).toEqual([]);
        await resumed.exclusive(s.id, () => resumed.history.redo(s.id, resumed.history.state(s.id).redoId!));
        expect(await readFile(join(directory, 'shutdown-result.txt'), 'utf8')).toBe('Completed shutdown bytes');
        expect(restarted.messages(s.id)).toEqual(messages); expect(calls).toHaveLength(1);
      } finally { restarted.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => {});
    }
  }, 15000);

  it('does not leave a stale advertised undo checkpoint when manual compaction checkpoint refresh fails', async () => {
    const s = store.createSession(); await turn(s.id, 'First'); await turn(s.id, 'Second'); const before = store.messages(s.id);
    store.db.exec("CREATE TRIGGER reject_compaction_checkpoint BEFORE UPDATE OF data ON history_checkpoints WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT, 'compaction checkpoint failed'); END;");
    try { await expect(runner.compact(s.id)).rejects.toThrow('compaction checkpoint failed'); }
    finally { store.db.exec('DROP TRIGGER reject_compaction_checkpoint'); }
    expect(runner.active(s.id)).toBe(false);
    // Failure may roll the transcript back or declare recovery, but must not advertise a broken Undo.
    const unchanged = JSON.stringify(store.messages(s.id)) === JSON.stringify(before);
    expect(unchanged || Boolean(runner.history.state(s.id).pendingRecovery)).toBe(true);
    if (runner.history.state(s.id).pendingRecovery) await recover(s.id);
    await undo(s.id); expect(store.messages(s.id).filter(message => message.role === 'user').map(message => message.content)).toEqual(['First']);
  });
});
