import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// Opt in after building: LITE_TEST_NODE=/absolute/path/to/node vitest run tests/runtime.test.ts
// No credential-bearing environment is inherited by the built app or CLI.
const runtime = process.env.LITE_TEST_NODE;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const instances: ChildProcess[] = [];
const servers: Server[] = [];
let temporary = '';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const environment = (home: string): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8' });
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
function processResult(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  instances.push(child);
  let output = '';
  child.stdout?.on('data', data => { output += data; });
  child.stderr?.on('data', data => { output += data; });
  const finished = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, finished, output: () => output };
}
afterEach(async () => {
  for (const child of instances.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(servers.splice(0).map(close));
  if (temporary) { await delay(100); await rm(temporary, { recursive: true, force: true }); temporary = ''; }
});

describe.skipIf(!runtime)('built runtime compatibility (explicit opt-in)', () => {
  it('serves production and CLI and preserves exact turn undo/redo across restarts without provider replay', async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'lite-runtime-')));
    const installation = join(temporary, 'installation');
    const workspace = join(temporary, 'workspace');
    const data = join(temporary, 'data');
    await mkdir(installation);
    await mkdir(workspace);
    await cp(join(project, 'dist'), join(installation, 'dist'), { recursive: true });
    await cp(join(project, 'bin'), join(installation, 'bin'), { recursive: true });
    await cp(join(project, 'package.json'), join(installation, 'package.json'));
    await symlink(join(project, 'node_modules'), join(installation, 'node_modules'));
    const env = { ...environment(temporary), LITE_DATA_DIR: data, LITE_WORKSPACE: workspace };
    const version = await processResult(runtime!, ['--version'], temporary, env).finished;
    expect(version.code).toBe(0);
    expect(version.output.trim()).toMatch(/^v22\.13\.0$/);
    const providerCalls: { messages: { role: string; content: any }[]; tools?: unknown[] }[] = [];
    let catalogCalls = 0;
    const fixtureContent = String.fromCharCode(0xfeff) + 'persisted runtime output — exact UTF-8\r\nno final newline';
    const changedAttachment = 'External edit made after the accepted attachment snapshot.';
    const provider = createServer(async (req, res) => {
      if (req.url === '/v1/models') { catalogCalls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'runtime-model', context_window: 128000 }] })); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      providerCalls.push(request);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      const content = request.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content ?? '';
      const prompt = typeof content === 'string' ? content : content.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n');
      const summary = request.messages[0]?.content?.startsWith('Summarize the supplied conversation data');
      let finishReason = 'stop';
      if (summary) {
        await writeFile(join(workspace, 'do-not-reread.txt'), changedAttachment);
        emit({ content: 'Earlier runtime context: preserve the existing file bytes and inspect the latest attachment; no tools were rerun.' });
      }
      else if (prompt.includes('runtime context')) emit({ content: 'Runtime context complete.' });
      else if (request.messages.at(-1)?.role !== 'tool') {
        finishReason = 'tool_calls';
        if (prompt.includes('runtime question')) emit({ tool_calls: [{ index: 0, id: 'runtime-question', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which runtime approach?', options: [{ id: 'small', label: 'Small change' }, { id: 'broad', label: 'Broader change' }] }) } }] });
        else emit({ tool_calls: [{ index: 0, id: 'runtime-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'runtime.txt', content: fixtureContent }) } }] });
      } else { emit({ content: 'Runtime ' }); emit({ content: 'complete.' }); }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    servers.push(provider);
    const providerPort = await listen(provider);
    async function start(cli: boolean) {
      const reservation = createServer();
      const port = await listen(reservation);
      await close(reservation);
      const args = cli ? [join(installation, 'bin/lite.mjs'), 'serve', '--port', String(port), '--workspace', workspace] : [join(installation, 'dist/server/index.js')];
      const app = processResult(runtime!, args, workspace, { ...env, LITE_PORT: String(port) });
      const base = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (app.child.exitCode !== null || app.child.signalCode !== null) throw new Error(`Built app exited before health: ${app.output()}`);
        try { if ((await fetch(base + '/api/health')).ok) return { ...app, base }; } catch { /* Starting. */ }
        await delay(25);
      }
      throw new Error(`Built app did not become healthy: ${app.output()}`);
    }
    let app = await start(false);
    const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(app.base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    expect(await api('/health')).toEqual({ ok: true, version: '0.1.0' });
    expect(await (await fetch(app.base + '/')).text()).toContain('<div id="root">');
    const initial = await api('/settings');
    expect(initial.providers).toHaveLength(1);
    expect(initial.providers[0].baseUrl).toBe('http://localhost:4000');
    expect(initial.providers[0].apiKey).toBeUndefined();
    await api('/settings', { providers: [{ id: 'runtime', name: 'Runtime mock', kind: 'openai', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'synthetic-runtime-only' }], defaultProvider: 'runtime', defaultModel: 'runtime-model' }, 'PATCH');
    const session = await api('/sessions', { title: 'Node runtime fixture', permissionMode: 'auto' });
    const sessionPath = `/sessions/${session.id}`;
    const baseline = await api(sessionPath);
    expect(baseline.history).toMatchObject({ hasCheckpoints: false, canUndo: false, canRedo: false });
    const streamAbort = new AbortController();
    const response = await fetch(`${app.base}/api/sessions/${session.id}/events`, { signal: streamAbort.signal });
    const events: { type: string; data: unknown }[] = [];
    const streamed = (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) throw new Error('Stream ended without done.');
          buffer += decoder.decode(part.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const line = frame.split('\n').find(line => line.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)); events.push(event);
            if (event.type === 'done') return;
          }
        }
      } finally { await reader.cancel(); }
    })();
    await api(`/sessions/${session.id}/messages`, { content: 'Create the runtime fixture.' });
    await streamed;
    streamAbort.abort();
    expect(events.some(event => event.type === 'delta'), JSON.stringify(events)).toBe(true);
    const fixtureBytes = Buffer.from(fixtureContent, 'utf8');
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect(providerCalls).toHaveLength(2);
    const completed = await api(sessionPath);
    expect(completed.messages.at(-1).content).toBe('Runtime complete.');
    expect(completed.history).toMatchObject({ hasCheckpoints: true, canUndo: true, canRedo: false });
    expect(completed.history.undoId).toEqual(expect.any(String));
    expect(completed.history.pendingRecovery).toBeUndefined();
    const checkpointId = completed.history.undoId;
    const recorded = await api(`${sessionPath}/changes`);
    expect(recorded.changes).toEqual([{ path: 'runtime.txt', before: null, after: fixtureContent }]);
    app.child.kill('SIGTERM');
    expect((await app.finished).code).toBe(0);
    app = await start(true);
    const persisted = await api(sessionPath);
    expect(persisted.messages).toEqual(completed.messages);
    expect(persisted.todos).toEqual(completed.todos);
    expect(persisted.history).toEqual(completed.history);
    expect(persisted.session.status).toBe('idle');
    expect(await api(`${sessionPath}/changes`)).toEqual(recorded);
    expect(providerCalls).toHaveLength(2);
    const undone = await api(`${sessionPath}/history/undo`, { checkpointId });
    expect(undone).toMatchObject({ hasCheckpoints: true, canUndo: false, canRedo: true, redoId: checkpointId });
    expect(undone.pendingRecovery).toBeUndefined();
    const undoneDetail = await api(sessionPath);
    expect(undoneDetail.messages).toEqual(baseline.messages);
    expect(undoneDetail.todos).toEqual(baseline.todos);
    expect(undoneDetail.queue.paused).toBe(true);
    expect(await api(`${sessionPath}/changes`)).toEqual({ changes: [] });
    await expect(readFile(join(workspace, 'runtime.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(providerCalls).toHaveLength(2);
    // Restart while undone: the redo branch must be persisted, not reconstructed
    // by calling the provider or executing the original write tool a second time.
    app.child.kill('SIGTERM');
    expect((await app.finished).code).toBe(0);
    app = await start(false);
    const restartedUndone = await api(sessionPath);
    expect(restartedUndone.history).toEqual(undone);
    expect(restartedUndone.messages).toEqual(baseline.messages);
    expect(restartedUndone.todos).toEqual(baseline.todos);
    expect(restartedUndone.queue.paused).toBe(true);
    await expect(readFile(join(workspace, 'runtime.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(providerCalls).toHaveLength(2);
    const redone = await api(`${sessionPath}/history/redo`, { checkpointId: restartedUndone.history.redoId });
    expect(redone).toEqual(completed.history);
    const restored = await api(sessionPath);
    expect(restored.messages).toEqual(completed.messages);
    expect(restored.todos).toEqual(completed.todos);
    expect(await api(`${sessionPath}/changes`)).toEqual(recorded);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect(providerCalls).toHaveLength(2);
    const cli = await processResult(runtime!, [join(installation, 'bin/lite.mjs'), 'sessions', '--url', app.base], workspace, env).finished;
    expect(cli.code).toBe(0);
    expect(cli.output).toContain(session.id);
    // Exercise ask_user through the bundled production server, not source imports.
    const questionSession = await api('/sessions', { title: 'Runtime structured question', mode: 'plan', permissionMode: 'auto' });
    const questionPath = `/sessions/${questionSession.id}`;
    const questionAbort = new AbortController();
    const questionResponse = await fetch(`${app.base}/api${questionPath}/events`, { signal: questionAbort.signal });
    const questionEvents: { type: string; data: any }[] = [];
    const questionStream = (async () => {
      const reader = questionResponse.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const part = await reader.read(); if (part.done) throw new Error('Question stream ended without done.');
          buffer += decoder.decode(part.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const line = frame.split('\n').find(value => value.startsWith('data: ')); if (!line) continue;
            const event = JSON.parse(line.slice(6)); questionEvents.push(event);
            if (event.type === 'done') return;
          }
        }
      } finally { await reader.cancel(); }
    })();
    const acceptance = await api(`${questionPath}/messages`, { content: 'Ask a runtime question before proceeding.' });
    await expect.poll(async () => (await api(questionPath)).questions.length).toBe(1);
    const pendingQuestion = (await api(questionPath)).questions[0];
    expect(pendingQuestion).toMatchObject({ sessionId: questionSession.id, turnId: acceptance.messageId, toolCallId: 'runtime-question', question: 'Which runtime approach?' });
    expect((await api(questionPath)).permissions).toEqual([]);
    expect((await api(questionPath)).session.status).toBe('waiting');
    expect(providerCalls).toHaveLength(3);
    const answerPath = `${questionPath}/questions/${pendingQuestion.id}/answer`;
    const answer = { kind: 'option', optionId: 'small' };
    const receipt = await api(answerPath, answer);
    expect(receipt).toEqual({ id: pendingQuestion.id, status: 'answered', answer });
    await questionStream; questionAbort.abort();
    expect(questionEvents.find(event => event.type === 'question')?.data).toEqual(pendingQuestion);
    expect(questionEvents.filter(event => event.type === 'question_resolved').map(event => event.data)).toEqual([{ id: pendingQuestion.id, status: 'answered' }]);
    expect(questionEvents.at(-1)).toMatchObject({ type: 'done', data: { status: 'idle' } });
    const answered = await api(questionPath);
    expect(answered.questions).toEqual([]);
    expect(answered.messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(1);
    expect(answered.history.canUndo).toBe(true);
    expect(await api(answerPath, answer)).toEqual(receipt);
    expect(providerCalls).toHaveLength(4);
    const questionCheckpoint = answered.history.undoId;
    await api(`${questionPath}/history/undo`, { checkpointId: questionCheckpoint });
    expect((await api(questionPath)).messages).toEqual([]);
    expect((await api(questionPath)).questions).toEqual([]);
    expect((await api(`${questionPath}/questions`)).questions).toEqual([]);
    const stale = await fetch(app.base + '/api' + answerPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
    expect(stale.status).toBe(409);
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0);
    app = await start(false);
    expect((await api(questionPath)).questions).toEqual([]);
    expect((await api(questionPath)).history.redoId).toBe(questionCheckpoint);
    await api(`${questionPath}/history/redo`, { checkpointId: questionCheckpoint });
    const restoredQuestion = await api(questionPath);
    expect(restoredQuestion.messages).toEqual(answered.messages);
    expect(restoredQuestion.history).toEqual(answered.history);
    expect(restoredQuestion.questions).toEqual([]);
    expect((await api(`${questionPath}/questions`)).questions).toEqual([]);
    expect(providerCalls).toHaveLength(4);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);

    // A killed server cannot turn a persisted unanswered question into a fresh live request.
    const interruptedSession = await api('/sessions', { title: 'Interrupted production question', permissionMode: 'auto' });
    const interruptedPath = `/sessions/${interruptedSession.id}`;
    await api(`${interruptedPath}/messages`, { content: 'Ask an unanswered runtime question.' });
    await expect.poll(async () => (await api(interruptedPath)).questions.length).toBe(1);
    const beforeCrash = await api(interruptedPath), interruptedQuestion = beforeCrash.questions[0];
    await api(`${interruptedPath}/queue`, { content: 'Do not execute this queued continuation after restart.' });
    expect(providerCalls).toHaveLength(5);
    app.child.kill('SIGKILL'); expect((await app.finished).signal).toBe('SIGKILL');
    app = await start(false);
    const afterCrash = await api(interruptedPath);
    expect(afterCrash.questions).toEqual([]);
    expect(afterCrash.messages).toEqual(beforeCrash.messages);
    expect(afterCrash.history.pendingRecovery).toBeTruthy();
    expect(afterCrash.queue).toMatchObject({ paused: true, items: [{ content: 'Do not execute this queued continuation after restart.' }] });
    expect((await api(`${interruptedPath}/questions`)).questions).toEqual([]);
    const late = await fetch(`${app.base}/api${interruptedPath}/questions/${interruptedQuestion.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'text', text: 'Too late' }) });
    expect(late.status).toBe(409);
    await api(`${interruptedPath}/history/recover`, {});
    const recovered = await api(interruptedPath);
    expect(recovered.history.pendingRecovery).toBeUndefined();
    expect(recovered.questions).toEqual([]); expect(recovered.history.canUndo).toBe(true);
    await api(`${interruptedPath}/history/undo`, { checkpointId: recovered.history.undoId });
    const recoveryRedo = (await api(interruptedPath)).history.redoId;
    await api(`${interruptedPath}/history/redo`, { checkpointId: recoveryRedo });
    expect((await api(interruptedPath)).messages).toEqual(recovered.messages);
    expect((await api(interruptedPath)).questions).toEqual([]);
    expect((await api(interruptedPath)).queue.paused).toBe(true);
    expect(providerCalls).toHaveLength(5);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    // Exercise budgeting through the bundled API, including its persistent
    // override and a smaller total window than the explicitly discovered catalog.
    expect(catalogCalls).toBe(0);
    const settings = await api('/settings');
    const overridden = await api('/settings', { providers: settings.providers.map((value: { id: string }) => value.id === 'runtime' ? { ...value, contextWindows: { 'runtime-model': 16384 } } : value) }, 'PATCH');
    expect(overridden.providers[0].contextWindows).toEqual({ 'runtime-model': 16384 });
    expect(overridden.providers[0].apiKey).toBeUndefined();
    expect(await api('/models?providerId=runtime')).toMatchObject({ models: [{ id: 'runtime-model', providerId: 'runtime', contextWindow: 128000 }] });
    expect(catalogCalls).toBe(1);
    const contextSession = await api('/sessions/import', {
      session: { title: 'Production context budget', providerId: 'runtime', model: 'runtime-model' },
      messages: [
        { id: 'old-user', role: 'user', content: 'Prior runtime goal: preserve the existing file bytes. ' + 'x'.repeat(30000), createdAt: 1 },
        { id: 'old-assistant', role: 'assistant', content: 'Prior runtime outcome: verification completed. ' + 'y'.repeat(30000), createdAt: 2 },
      ],
    });
    const contextPath = `/sessions/${contextSession.id}`;
    const contextBefore = await api(contextPath), contextChanges = await api(`${contextPath}/changes`);
    expect(contextBefore.history).toMatchObject({ hasCheckpoints: false, canUndo: false, canRedo: false });
    const latestAttachment = { name: 'latest.txt', content: 'Keep these exact latest bytes — UTF-8\r\nno final newline', path: 'do-not-reread.txt' };
    await writeFile(join(workspace, latestAttachment.path), latestAttachment.content);
    const latestPrompt = 'Continue the runtime context using this attachment.';
    const contextAbort = new AbortController();
    const contextResponse = await fetch(`${app.base}/api${contextPath}/events`, { signal: contextAbort.signal });
    const contextEvents: { type: string; data: any }[] = [];
    const contextStream = (async () => {
      const reader = contextResponse.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const part = await reader.read(); if (part.done) throw new Error('Context stream ended without done.');
          buffer += decoder.decode(part.value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const line = frame.split('\n').find(value => value.startsWith('data: ')); if (!line) continue;
            const event = JSON.parse(line.slice(6)); contextEvents.push(event);
            if (event.type === 'done') return;
          }
        }
      } finally { await reader.cancel(); }
    })();
    void contextStream.catch(() => {}); // Keep a failed submission from leaving an unhandled stream rejection.
    let contextAcceptance;
    try {
      contextAcceptance = await api(`${contextPath}/messages`, { content: latestPrompt, attachments: [latestAttachment] });
      await contextStream;
    } finally { contextAbort.abort(); await contextStream.catch(() => {}); }
    expect(contextEvents.at(-1)).toMatchObject({ type: 'done', data: { status: 'idle' } });
    expect(contextEvents.some(event => event.type === 'message' && event.data.id === contextAcceptance.messageId)).toBe(true);
    expect(contextEvents.filter(event => event.type === 'reset')).toHaveLength(1);
    const proactiveSnapshot = contextEvents.find(event => event.type === 'message' && event.data.context?.action === 'compact')?.data.context;
    expect(proactiveSnapshot).toMatchObject({ providerId: 'runtime', model: 'runtime-model', contextWindow: 16384, outputReserve: 4096, limitSource: 'override', uncertain: false, action: 'compact' });
    expect(proactiveSnapshot.estimatedInputTokens).toBeGreaterThan(15000);
    expect(providerCalls).toHaveLength(7); expect(catalogCalls).toBe(1);
    const [summaryRequest, completionRequest] = providerCalls.slice(5);
    expect(summaryRequest.messages[0].content).toContain('Summarize the supplied conversation data');
    expect(summaryRequest.tools).toBeUndefined();
    expect(summaryRequest.messages[1].content).toContain('Prior runtime goal');
    expect(summaryRequest.messages[1].content.length).toBeLessThanOrEqual(48000);
    expect(summaryRequest.messages[1].content).not.toContain(latestPrompt);
    expect(completionRequest.messages.map(message => message.role)).toEqual(['system', 'system', 'user']);
    expect(completionRequest.messages[1].content).toContain('Earlier runtime context: preserve the existing file bytes');
    expect(completionRequest.messages[2].content).toEqual([
      { type: 'text', text: latestPrompt },
      { type: 'text', text: `\n<attached_file name="latest.txt">\n${latestAttachment.content}\n</attached_file>` },
    ]);
    const compacted = await api(contextPath), contextCheckpoint = compacted.history.undoId;
    expect(compacted.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(compacted.messages[1]).toMatchObject({ id: contextAcceptance.messageId, content: latestPrompt, attachments: [latestAttachment] });
    const finalSnapshot = compacted.messages[2].context;
    expect(compacted.messages[2].content).toBe('Runtime context complete.');
    expect(finalSnapshot).toMatchObject({ providerId: 'runtime', model: 'runtime-model', contextWindow: 16384, outputReserve: 4096, limitSource: 'override', uncertain: false, action: 'continue' });
    expect(Number.isInteger(finalSnapshot.estimatedInputTokens)).toBe(true);
    expect(finalSnapshot.estimatedInputTokens).toBeGreaterThan(0);
    expect(finalSnapshot.estimatedInputTokens + finalSnapshot.outputReserve).toBeLessThan(16384);
    expect(compacted.questions).toEqual([]); expect(compacted.permissions).toEqual([]);
    expect(compacted.history).toMatchObject({ hasCheckpoints: true, canUndo: true, canRedo: false });
    expect(compacted.history.pendingRecovery).toBeUndefined();
    expect(compacted.todos).toEqual(contextBefore.todos);
    expect(await api(`${contextPath}/changes`)).toEqual(contextChanges);
    const contextArchives = (await api('/sessions?archived=true')).sessions.filter((value: { parentId?: string }) => value.parentId === contextSession.id);
    expect(contextArchives).toHaveLength(1);
    const contextArchivePath = `/sessions/${contextArchives[0].id}`;
    const archiveDetail = await api(contextArchivePath);
    expect(archiveDetail.messages.map((message: { content: string }) => message.content)).toEqual([...contextBefore.messages.map((message: { content: string }) => message.content), latestPrompt]);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    const contextUndone = await api(`${contextPath}/history/undo`, { checkpointId: contextCheckpoint });
    expect(contextUndone).toMatchObject({ canUndo: false, canRedo: true, redoId: contextCheckpoint });
    expect((await api(contextPath)).messages).toEqual(contextBefore.messages);
    expect((await api(contextPath)).todos).toEqual(contextBefore.todos);
    expect((await api(contextPath)).queue.paused).toBe(true);
    expect(await api(`${contextPath}/changes`)).toEqual(contextChanges);
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0);
    app = await start(true);
    const contextRestarted = await api(contextPath);
    expect(contextRestarted.messages).toEqual(contextBefore.messages);
    expect(contextRestarted.history).toEqual(contextUndone);
    expect(contextRestarted.queue.paused).toBe(true);
    expect((await api('/settings')).providers[0].contextWindows).toEqual({ 'runtime-model': 16384 });
    expect(providerCalls).toHaveLength(7); expect(catalogCalls).toBe(1);
    expect(await api(`${contextPath}/history/redo`, { checkpointId: contextCheckpoint })).toEqual(compacted.history);
    const contextRestored = await api(contextPath);
    expect(contextRestored.messages).toEqual(compacted.messages);
    expect(contextRestored.todos).toEqual(compacted.todos);
    expect(contextRestored.questions).toEqual([]); expect(contextRestored.permissions).toEqual([]);
    expect(contextRestored.queue.paused).toBe(true);
    expect(await api(`${contextPath}/changes`)).toEqual(contextChanges);
    expect((await api(contextArchivePath)).messages).toEqual(archiveDetail.messages);
    expect((await api('/sessions?archived=true')).sessions.filter((value: { parentId?: string }) => value.parentId === contextSession.id)).toHaveLength(1);
    expect((await api(interruptedPath)).queue).toMatchObject({ paused: true, items: [{ content: 'Do not execute this queued continuation after restart.' }] });
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect(providerCalls).toHaveLength(7); expect(catalogCalls).toBe(1);
    expect(await readFile(join(workspace, latestAttachment.path), 'utf8')).toBe(changedAttachment);
    // Validate the installed native PTY on this exact ABI without starting a
    // login shell (which would read the real user's startup files).
    const pty = await processResult(runtime!, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(installation, 'package.json'))}); const {spawn}=require('node-pty'); const p=spawn('/bin/sh',['-c','printf "PTY_RUNTIME_OK\\n"'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:process.cwd(),TERM:'xterm'}}); p.onData(s=>process.stdout.write(s)); p.onExit(e=>process.exit(e.exitCode)); setTimeout(()=>process.exit(2),3000).unref();`], workspace, env).finished;
    expect(pty.code, pty.output).toBe(0);
    expect(pty.output).toContain('PTY_RUNTIME_OK');
    app.child.kill('SIGINT');
    expect((await app.finished).code).toBe(0);
  }, 30_000);
});
