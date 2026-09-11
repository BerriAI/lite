import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { Runner } from '../server/runner.js';
import { EventBus } from '../server/events.js';
import { modelCatalog } from '../server/budget.js';
import { applyEvent } from '../client/src/api.js';
import type { Message, Provider, SessionDetail } from '../shared/types.js';

const until = async (check: () => boolean) => { const deadline = Date.now() + 4000; while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for context audit'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`); res.end('data: [DONE]\n\n'); };
const text = (res: ServerResponse, content: string) => stream(res, { content });
const overflow = (res: ServerResponse) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"context_length_exceeded"}}'); };
const isSummary = (body: any) => body.messages?.[0]?.content?.startsWith('Summarize the supplied conversation');

describe('independent context durability audit', () => {
  let directory: string, store: Store, runner: Runner, appServer: Server, firstServer: Server, secondServer: Server, url: string, secondUrl: string, provider: Provider;
  let calls: { destination: string; body: any }[], respond: (destination: string, body: any, res: ServerResponse) => void;
  beforeEach(async () => {
    modelCatalog.clear(); directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-context-audit-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_destination, body, res) => text(res, isSummary(body) ? 'Earlier context summarized.' : 'Finished');
    const server = (destination: string) => createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ destination, body }); respond(destination, body, res); });
    firstServer = server('original'); secondServer = server('replacement'); secondUrl = await listen(secondServer);
    provider = { id: 'audit', name: 'Audit', kind: 'openai', baseUrl: await listen(firstServer), contextWindows: { 'audit-model': 16384 } };
    store.saveSettings({ workspace: directory, providers: [provider], defaultProvider: provider.id, defaultModel: 'audit-model' });
    const app = createApp({ store, external: { capture: () => ({definitions:[],scope:()=> 'context-audit',assertCurrent:()=>{},execute:async()=> 'unused',release:()=>{}}) } }); runner = app.runner; appServer = createServer(app.app); url = await listen(appServer);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); vi.restoreAllMocks(); modelCatalog.clear(); await close(appServer); await close(firstServer); await close(secondServer); store.close(); await rm(directory, { recursive: true, force: true }); });
  const api = async (path: string, method = 'GET', data?: unknown) => { const response = await fetch(url + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); expect(response.ok).toBe(true); return response.json(); };
  const seed = () => { const session = store.createSession(), before: Message[] = [
    { id: randomUUID(), sessionId: session.id, role: 'user', content: 'Old request ' + 'x'.repeat(30000), createdAt: 1 },
    { id: randomUUID(), sessionId: session.id, role: 'assistant', content: 'Old answer ' + 'y'.repeat(30000), createdAt: 2 },
  ]; before.forEach(message => store.saveMessage(message)); return { session, before }; };
  const exactUndoRedo = async (id: string, before: Message[]) => { const after = store.messages(id), count = calls.length; await runner.exclusive(id, () => runner.history.undo(id, runner.history.state(id).undoId!)); expect(store.messages(id)).toEqual(before); await runner.exclusive(id, () => runner.history.redo(id, runner.history.state(id).redoId!)); expect(store.messages(id)).toEqual(after); expect(calls).toHaveLength(count); };

  it.each(['proactive', 'reactive'])('%s summary retains the accepted provider configuration across settings changes', async mode => {
    if (mode === 'reactive') store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] });
    const { session } = seed(); let release!: () => void, waiting = false;
    if (mode === 'proactive') {
      // MCP capture is synchronous now; hold the existing asynchronous system read instead.
      const prompt=(runner as any).systemPrompt.bind(runner);
      vi.spyOn(runner as any,'systemPrompt').mockImplementation(async(...args:unknown[])=>{const text=await prompt(...args);await new Promise<void>(resolve=>{waiting=true;release=resolve;});return text;});
    }
    else respond = (_destination, body, res) => { if (calls.length === 1) { waiting = true; release = () => overflow(res); } else text(res, isSummary(body) ? 'Summary' : 'Finished'); };
    runner.start(session.id, 'Latest'); await until(() => waiting);
    await api('/settings', 'PATCH', { providers: [{ ...provider, baseUrl: secondUrl }] });
    release(); await runner.whenIdle();
    expect(calls.filter(call => isSummary(call.body))).toHaveLength(1);
    expect(calls.map(call => call.destination)).toEqual(Array(mode === 'proactive' ? 2 : 3).fill('original'));
    expect(store.session(session.id).status).toBe('idle');
  });

  it('durable reset replay converges after a synchronous subscriber failure without repeating the provider', async () => {
    const { session, before } = seed(); const baseline = await api(`/sessions/${session.id}`) as SessionDetail;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsubscribe = runner.bus.subscribe(session.id, event => { if (event.type === 'reset') throw new Error('Subscriber disconnected after durable insert'); });
    try { runner.start(session.id, 'Latest'); await runner.whenIdle(); } finally { unsubscribe(); }
    expect(calls).toHaveLength(2); expect(calls.filter(call => isSummary(call.body))).toHaveLength(1);
    const replayed = store.events(session.id, baseline.lastEventId ?? 0).reduce(applyEvent, baseline);
    expect(replayed.messages).toEqual(store.messages(session.id));
    expect(replayed.messages[0].role).toBe('system');
    expect(store.messages(store.sessions('', true)[0].id).some(message => message.context || message.activity)).toBe(false);
    await exactUndoRedo(session.id, before);
  });

  it.each(['proactive', 'reactive'])('cancel from the committed %s reset preserves the summary and never submits a follow-up request', async mode => {
    if (mode === 'reactive') store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] });
    const { session, before } = seed();
    respond = (_destination, body, res) => { if (isSummary(body)) text(res, 'Committed summary'); else overflow(res); };
    const unsubscribe = runner.bus.subscribe(session.id, event => { if (event.type === 'reset') runner.cancel(session.id); });
    try { runner.start(session.id, 'Latest'); await runner.whenIdle(); } finally { unsubscribe(); }
    expect(calls).toHaveLength(mode === 'proactive' ? 1 : 2); expect(store.sessions('', true)).toHaveLength(1);
    expect(store.messages(session.id)[0].content).toContain('Committed summary');
    expect(store.messages(session.id).some(message => message.error?.includes('unchanged'))).toBe(false);
    expect(runner.history.state(session.id).pendingRecovery).toBeUndefined();
    await exactUndoRedo(session.id, before);
  });

  it('reactive compaction retains the complete latest tool group, attachment bytes and scoped metadata exactly', async () => {
    store.saveSettings({ providers: [{ ...provider, contextWindows: {} }] });
    const { session, before } = seed(); let completions = 0; let retained: Message[] = [];
    const attachment = { name: 'latest.txt', path: 'not-read-after-accept.txt', content: '﻿exact — UTF-8\r\nno final newline' };
    respond = (_destination, body, res) => {
      if (isSummary(body)) return text(res, 'Older history summarized');
      if (++completions === 1) return stream(res, { content: 'Inspect current todos', reasoning_content: 'Keep scoped plaintext reasoning', tool_calls: [{ index: 0, id: 'audit-tool-id', type: 'function', function: { name: 'todo_read', arguments: '{}' } }] }, 'tool_calls');
      if (completions === 2) { retained = store.messages(session.id).slice(before.length).filter(message => message.role !== 'assistant' || Boolean(message.content || message.toolCalls?.length)); return overflow(res); }
      text(res, 'Done with retained tool result');
    };
    runner.start(session.id, 'Latest task', [attachment]); await runner.whenIdle();
    expect(calls).toHaveLength(4); expect(calls.filter(call => isSummary(call.body))).toHaveLength(1);
    expect(retained.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(retained[1].providerMetadata).toMatchObject({ providerId: provider.id, model: session.model, reasoning_content: 'Keep scoped plaintext reasoning' });
    expect(store.messages(session.id).slice(1, 4)).toEqual(retained);
    const outbound = calls.at(-1)!.body.messages;
    expect(outbound.find((message: any) => message.role === 'user').content[1].text).toContain(attachment.content);
    expect(outbound.find((message: any) => message.tool_calls)?.tool_calls[0].id).toBe('audit-tool-id');
    expect(outbound.find((message: any) => message.role === 'tool').tool_call_id).toBe('audit-tool-id');
    await exactUndoRedo(session.id, before);
  });

  it('a real compaction COMMIT failure rolls back archive and transcript, then restarts without replay', async () => {
    const { session, before } = seed();
    store.db.exec(`CREATE TABLE audit_context_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE audit_context_commit(parent_id INTEGER REFERENCES audit_context_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_context_commit AFTER INSERT ON messages
      WHEN json_extract(NEW.data,'$.role')='system' AND json_extract(NEW.data,'$.content') LIKE 'Session context summary%'
      BEGIN INSERT INTO audit_context_commit(parent_id) VALUES(1); END;`);
    try { runner.start(session.id, 'Latest'); await runner.whenIdle(); } finally { store.db.exec('DROP TRIGGER fail_context_commit'); }
    expect(calls).toHaveLength(2); expect(calls.filter(call => isSummary(call.body))).toHaveLength(1);
    expect(store.sessions('', true)).toHaveLength(0); expect(store.messages(session.id).slice(0, before.length)).toEqual(before);
    expect(store.messages(session.id).at(-1)?.context?.reason).toContain('failed');
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM audit_context_commit').get()).toMatchObject({ count: 0 });
    const saved = store.messages(session.id), state = runner.history.state(session.id);
    await close(appServer); store.close(); store = new Store(join(directory, 'state'));
    const restarted = createApp({ store }); runner = restarted.runner; appServer = createServer(restarted.app); url = await listen(appServer);
    expect(store.messages(session.id)).toEqual(saved); expect(runner.history.state(session.id)).toEqual(state);
    expect(calls).toHaveLength(2); await exactUndoRedo(session.id, before);
  });

  it('restart from durable post-summary state clears transient progress and recovers exact history without replay', async () => {
    const { session, before } = seed(); let snapshot = false;
    const crashDirectory = join(directory, 'crash-state'); await mkdir(crashDirectory);
    const unsubscribe = runner.bus.subscribe(session.id, event => {
      if (event.type !== 'reset') return;
      // Copy the durable SQLite state at the precise commit/event boundary,
      // before the in-process run resumes or seals its checkpoint.
      store.db.exec(`VACUUM INTO '${join(crashDirectory, 'litespeed.db').replaceAll("'", "''")}'`);
      snapshot = true; runner.cancel(session.id);
    });
    try { runner.start(session.id, 'Latest'); await runner.whenIdle(); } finally { unsubscribe(); }
    expect(snapshot).toBe(true); expect(calls).toHaveLength(1);
    const recoveredStore = new Store(crashDirectory), recovered = new Runner(recoveredStore, new EventBus(recoveredStore));
    try {
      expect(recovered.active(session.id)).toBe(false); expect(recoveredStore.session(session.id).status).toBe('idle');
      const saved = recoveredStore.messages(session.id);
      expect(saved.map(message => message.role)).toEqual(['system', 'user']);
      expect(recovered.messages(session.id)).toEqual(saved);
      expect(recovered.history.state(session.id).pendingRecovery).toBeTruthy();
      await recovered.history.recover(session.id); expect(recoveredStore.messages(session.id)).toEqual(saved);
      await recovered.history.undo(session.id, recovered.history.state(session.id).undoId!); expect(recoveredStore.messages(session.id)).toEqual(before);
      await recovered.history.redo(session.id, recovered.history.state(session.id).redoId!); expect(recoveredStore.messages(session.id)).toEqual(saved);
      expect(calls).toHaveLength(1);
    } finally { recovered.stopAll(); await recovered.whenIdle(); recoveredStore.close(); }
  });

  it('a fresh accepted turn gets one new summary attempt after the prior turn used its attempt', async () => {
    const { session } = seed(); let summaries = 0;
    respond = (_destination, body, res) => {
      if (isSummary(body) && ++summaries === 1) { res.writeHead(401); res.end('{}'); }
      else text(res, isSummary(body) ? 'Successful second-turn summary' : 'Completed');
    };
    runner.start(session.id, 'First latest task'); await runner.whenIdle();
    const afterFirst = store.messages(session.id); expect(calls).toHaveLength(2); expect(store.sessions('', true)).toHaveLength(0);
    runner.start(session.id, 'Second latest task'); await runner.whenIdle();
    expect(calls).toHaveLength(4); expect(summaries).toBe(2); expect(store.sessions('', true)).toHaveLength(1);
    await exactUndoRedo(session.id, afterFirst);
  });

  it('a progress-event SQL failure leaves no live detail overlay, archive, or provider request', async () => {
    const { session, before } = seed();
    store.db.exec("CREATE TRIGGER fail_audit_progress BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.type')='message' AND json_extract(NEW.data,'$.data.activity') LIKE 'Making room%' BEGIN SELECT RAISE(ABORT,'progress event failed'); END;");
    try { runner.start(session.id, 'Latest'); await runner.whenIdle(); } finally { store.db.exec('DROP TRIGGER fail_audit_progress'); }
    expect(calls).toHaveLength(0); expect(store.sessions('', true)).toHaveLength(0);
    const detail = await api(`/sessions/${session.id}`) as SessionDetail;
    expect(detail.messages).toEqual(store.messages(session.id)); expect(detail.messages.some(message => message.activity?.includes('Making room'))).toBe(false);
    expect(detail.session.status).toBe('error'); await exactUndoRedo(session.id, before);
  });
});
