import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// Opt in after building: SPEEDRAIL_TEST_NODE=/absolute/path/to/node vitest run tests/runtime.test.ts
// No credential-bearing environment is inherited by the built app or CLI.
const runtime = process.env.SPEEDRAIL_TEST_NODE;
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
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-runtime-')));
    const installation = join(temporary, 'installation');
    const workspace = join(temporary, 'workspace');
    const data = join(temporary, 'data');
    await mkdir(installation);
    await mkdir(workspace);
    await cp(join(project, 'dist'), join(installation, 'dist'), { recursive: true });
    await cp(join(project, 'bin'), join(installation, 'bin'), { recursive: true });
    await cp(join(project, 'package.json'), join(installation, 'package.json'));
    await symlink(join(project, 'node_modules'), join(installation, 'node_modules'));
    const env = { ...environment(temporary), SPEEDRAIL_DATA_DIR: data, SPEEDRAIL_WORKSPACE: workspace };
    const version = await processResult(runtime!, ['--version'], temporary, env).finished;
    expect(version.code).toBe(0);
    expect(version.output.trim()).toMatch(/^v26\.4\.0$/);
    const providerCalls: { messages: { role: string; content: any }[]; tools?: { function: { name: string } }[] }[] = [];
    let catalogCalls = 0;
    let advertisedMcpName = '';
    const heldResearchers = new Set<import('node:http').ServerResponse>();
    let cancelledResearchers = 0;
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
      else if (prompt.includes('runtime delegation')) {
        const child = request.messages[0]?.content?.includes('foreground read-only researcher');
        if (child && prompt.includes('hold')) {
          heldResearchers.add(res); res.on('close', () => { heldResearchers.delete(res); cancelledResearchers++; });
          return;
        }
        if (request.messages.at(-1)?.role === 'tool') emit({ content: child ? 'Runtime delegation verified original file bytes without mutation.' : 'Runtime delegation parent complete.' });
        else {
          finishReason = 'tool_calls';
          const name = child ? 'read_file' : 'task';
          const args = child ? { path: 'runtime.txt' } : { description: 'Runtime read-only audit', prompt: `runtime delegation child ${prompt.includes('hold') ? 'hold' : 'read'} independently` };
          emit({ tool_calls: [{ index: 0, id: `runtime-delegation-${providerCalls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        }
      }
      else if (prompt.includes('runtime MCP')) {
        if (request.messages.at(-1)?.role === 'tool') emit({ content: 'Runtime MCP complete.' });
        else if (prompt.includes('probe')) emit({ content: 'Runtime MCP disconnected probe complete.' });
        else {
          const available = request.tools?.find((tool: { function: { name: string } }) => tool.function.name.startsWith('mcp_'))?.function.name;
          advertisedMcpName = available ?? advertisedMcpName;
          finishReason = 'tool_calls';
          emit({ tool_calls: [{ index: 0, id: `runtime-mcp-${providerCalls.length}`, type: 'function', function: { name: advertisedMcpName, arguments: JSON.stringify({ text: 'runtime MCP input' }) } }] });
        }
      }
      else if (prompt.includes('runtime context')) emit({ content: 'Runtime context complete.' });
      else if (request.messages.at(-1)?.role !== 'tool') {
        finishReason = 'tool_calls';
        if (prompt.includes('runtime question')) emit({ tool_calls: [{ index: 0, id: 'runtime-question', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which runtime approach?', options: [{ id: 'small', label: 'Small change' }, { id: 'broad', label: 'Broader change' }] }) } }] });
        else emit({ tool_calls: [{ index: 0, id: 'runtime-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: prompt.includes('runtime profile') ? 'profile-forbidden.txt' : 'runtime.txt', content: fixtureContent }) } }] });
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
      const args = cli ? [join(installation, 'bin/speedrail.mjs'), 'serve', '--port', String(port), '--workspace', workspace] : [join(installation, 'dist/server/index.js')];
      const app = processResult(runtime!, args, workspace, { ...env, SPEEDRAIL_PORT: String(port) });
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
    expect(await api('/health')).toEqual({ ok: true, name: 'speedrail', version: '0.1.0' });
    expect(await (await fetch(app.base + '/')).text()).toContain('<div id="root">');
    const initial = await api('/settings');
    expect(initial.providers).toEqual([]);
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
    // A mutation turn with no checks gets the host receipts notice appended.
    expect(completed.messages.at(-1).content).toBe('Runtime complete.\n\n[Receipts: 1 file(s) changed, no checks were run.]');
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
    const cli = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'sessions', '--url', app.base], workspace, env).finished;
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
    // System prompt, archived summary, then the session-context envelope
    // anchored immediately before the latest user turn (openai route).
    expect(completionRequest.messages.map(message => message.role)).toEqual(['system', 'system', 'system', 'user']);
    expect(completionRequest.messages[1].content).toContain('Earlier runtime context: preserve the existing file bytes');
    expect(completionRequest.messages[2].content).toContain('<session-context version="1">');
    expect(completionRequest.messages[3].content).toEqual([
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
    // Profile resolution crosses the installed CLI/API boundary once. Continued
    // turns and history must use the pinned private snapshot after files vanish.
    const profileInstructions = 'RUNTIME_PROFILE_PRIVATE_BODY — review, never alter the fixture.';
    const skillBody = 'RUNTIME_SKILL_PRIVATE_BODY — preserve exact UTF-8\r\nno final newline';
    await mkdir(join(workspace, '.speedrail', 'skills', 'testing'), { recursive: true });
    await writeFile(join(workspace, '.speedrail', 'skills', 'testing', 'SKILL.md'), skillBody);
    await writeFile(join(workspace, '.speedrail', 'profiles.json'), JSON.stringify({ version: 1,
      profiles: [{ id: 'review', name: 'Runtime Review', instructions: profileInstructions, tools: ['read_file', 'grep'], defaultModel: { providerId: 'runtime', model: 'runtime-model' }, defaultMode: 'plan', skills: ['testing'] }],
      skills: [{ id: 'testing', name: 'Runtime Testing', description: 'Verify the pinned fixture.' }],
    }));
    const catalogCli = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'profiles', '--json', '--url', app.base], workspace, env).finished;
    expect(catalogCli.code, catalogCli.output).toBe(0);
    const profileCatalog = JSON.parse(catalogCli.output);
    expect(profileCatalog).toMatchObject({ workspace, profiles: [{ id: 'review', skills: ['testing'] }], skills: [{ id: 'testing' }], diagnostics: [] });
    expect(catalogCli.output).not.toContain('PRIVATE_BODY');
    expect(providerCalls).toHaveLength(7); expect(catalogCalls).toBe(1);
    const profileCli = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'run', 'Inspect the runtime profile and attempt the forbidden write.', '--profile', 'review', '--skills', 'testing', '--auto', '--url', app.base], workspace, env).finished;
    expect(profileCli.code, profileCli.output).toBe(0);
    const profileId = profileCli.output.match(/Session: ([\w-]+)/)?.[1]; expect(profileId).toBeTruthy();
    const profilePath = `/sessions/${profileId}`;
    const profileCompleted = await api(profilePath), profilePinned = await api(`${profilePath}/profile`);
    expect(profileCompleted.session).toMatchObject({ mode: 'plan', permissionMode: 'auto', providerId: 'runtime', model: 'runtime-model', profile: { profileId: 'review', skillIds: ['testing'], revision: profileCatalog.revision, tools: ['read_file', 'grep'] } });
    expect(profilePinned.pinned).toMatchObject({ instructions: profileInstructions, skills: [{ id: 'testing', body: skillBody, path: '.speedrail/skills/testing/SKILL.md' }] });
    expect(profilePinned.source.status).toBe('current');
    expect(profileCompleted.messages.flatMap((message: { toolCalls?: unknown[] }) => message.toolCalls ?? [])).toMatchObject([{ name: 'write_file', status: 'denied' }]);
    expect(profileCompleted.permissions).toEqual([]); expect(profileCompleted.questions).toEqual([]);
    expect(providerCalls).toHaveLength(9);
    for (const request of providerCalls.slice(7)) {
      expect(request.messages[0].content).toContain(profileInstructions); expect(request.messages[0].content).toContain(skillBody);
      expect(request.tools?.map(tool => tool.function.name)).not.toContain('write_file');
      expect(request.tools?.map(tool => tool.function.name)).toContain('ask_user');
    }
    expect(JSON.stringify(profileCompleted)).not.toContain('PRIVATE_BODY'); expect(profileCli.output).not.toContain('PRIVATE_BODY');
    await expect(readFile(join(workspace, 'profile-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(workspace, '.speedrail'), { recursive: true });
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0);
    app = await start(true);
    const profileRestarted = await api(profilePath), missingProfile = await api(`${profilePath}/profile`);
    expect(profileRestarted.messages).toEqual(profileCompleted.messages); expect(profileRestarted.session.profile).toEqual(profileCompleted.session.profile);
    expect(missingProfile.pinned).toEqual(profilePinned.pinned); expect(missingProfile.source.status).toBe('missing');
    expect(providerCalls).toHaveLength(9); expect(catalogCalls).toBe(1);
    // Removing Plan does not expand the pinned profile allowlist, even in Auto.
    await api(profilePath, { mode: 'build', expectedConfigRevision: profileRestarted.session.configRevision }, 'PATCH');
    const continuedProfile = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'run', 'Continue the runtime profile from pinned instructions.', '--session', profileId!, '--url', app.base], workspace, env).finished;
    expect(continuedProfile.code, continuedProfile.output).toBe(0);
    expect(providerCalls).toHaveLength(11);
    for (const request of providerCalls.slice(9)) {
      expect(request.messages[0].content).toContain(profileInstructions); expect(request.messages[0].content).toContain(skillBody);
      expect(request.tools?.map(tool => tool.function.name)).not.toContain('write_file');
    }
    const profileContinued = await api(profilePath);
    expect(profileContinued.session).toMatchObject({ mode: 'build', permissionMode: 'auto' });
    expect(profileContinued.messages.flatMap((message: { toolCalls?: unknown[] }) => message.toolCalls ?? [])).toMatchObject([{ status: 'denied' }, { status: 'denied' }]);
    expect(profileContinued.permissions).toEqual([]); expect(profileContinued.questions).toEqual([]);
    expect(profileContinued.session.profile).toEqual(profileCompleted.session.profile);
    await expect(readFile(join(workspace, 'profile-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const profileFork = await api(`${profilePath}/fork`, {}), forkPath = `/sessions/${profileFork.id}`;
    expect(profileFork.profile).toEqual(profileCompleted.session.profile);
    expect((await api(`${forkPath}/profile`)).pinned).toEqual(profilePinned.pinned);
    expect((await api(forkPath)).messages.map((message: { content: string }) => message.content)).toEqual(profileContinued.messages.map((message: { content: string }) => message.content));
    expect(JSON.stringify(await api(forkPath))).not.toContain('PRIVATE_BODY');
    expect(providerCalls).toHaveLength(11);
    await api(`${forkPath}/queue/pause`, {});
    await api(`${forkPath}/queue`, { content: 'Do not execute this stale configuration queue.' });
    await api(forkPath, { mode: 'plan', expectedConfigRevision: profileFork.configRevision }, 'PATCH');
    const beforeStaleConfig = await api(forkPath);
    const staleConfig = await fetch(app.base + '/api' + forkPath + '/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedConfigRevision: profileFork.configRevision, choice: { profileId: null, skillIds: [] } }) });
    expect(staleConfig.status).toBe(409);
    expect(await api(forkPath)).toEqual(beforeStaleConfig);
    expect(beforeStaleConfig.queue).toMatchObject({ paused: true, items: [{ content: 'Do not execute this stale configuration queue.' }] });
    expect(beforeStaleConfig.session.profile).toEqual(profileCompleted.session.profile);
    expect(providerCalls).toHaveLength(11);
    const profileExport = await api(`${profilePath}/export`);
    expect(profileExport.session.profile).toEqual(profileCompleted.session.profile);
    expect(JSON.stringify(profileExport)).not.toContain('PRIVATE_BODY');
    const importedProfile = await api('/sessions/import', profileExport), importedProfilePath = `/sessions/${importedProfile.id}`;
    expect(importedProfile.profile).toBeUndefined(); expect(importedProfile.permissionMode).toBe('ask');
    expect((await api(`${importedProfilePath}/profile`)).pinned).toBeNull();
    expect((await api(importedProfilePath)).history).toMatchObject({ hasCheckpoints: false, canUndo: false, canRedo: false });
    expect(providerCalls).toHaveLength(11);
    await api(`${profilePath}/compact`, {});
    expect(providerCalls).toHaveLength(12); expect(providerCalls[11].tools).toBeUndefined();
    expect(JSON.stringify(providerCalls[11])).not.toContain('PRIVATE_BODY');
    const profileCompacted = await api(profilePath), profileCompactCheckpoint = profileCompacted.history.undoId;
    const profileArchives = (await api('/sessions?archived=true')).sessions.filter((value: { parentId?: string }) => value.parentId === profileId);
    expect(profileArchives).toHaveLength(1);
    const profileArchivePath = `/sessions/${profileArchives[0].id}`, profileArchive = await api(profileArchivePath);
    expect(profileArchive.session.profile).toEqual(profileCompleted.session.profile);
    expect(profileArchive.messages.map((message: { content: string }) => message.content)).toEqual(profileContinued.messages.map((message: { content: string }) => message.content));
    expect((await api(`${profileArchivePath}/profile`)).pinned).toEqual(profilePinned.pinned);
    expect(JSON.stringify(profileArchive)).not.toContain('PRIVATE_BODY');
    expect(profileCompacted.session.profile).toEqual(profileCompleted.session.profile);
    // Manual compaction refreshes the latest turn's after-snapshot rather than
    // inventing an extra turn: undo returns to the first completed turn.
    expect(profileCompactCheckpoint).toBe(profileContinued.history.undoId);
    const profileUndone = await api(`${profilePath}/history/undo`, { checkpointId: profileCompactCheckpoint });
    expect((await api(profilePath)).messages).toEqual(profileCompleted.messages);
    expect((await api(profilePath)).session.mode).toBe('build');
    expect((await api(`${profilePath}/profile`)).pinned).toEqual(profilePinned.pinned);
    expect(providerCalls).toHaveLength(12);
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0);
    app = await start(false);
    expect((await api(profilePath)).history).toEqual(profileUndone);
    expect((await api(`${forkPath}/profile`)).pinned).toEqual(profilePinned.pinned);
    expect((await api(`${profileArchivePath}/profile`)).pinned).toEqual(profilePinned.pinned);
    expect((await api(`${importedProfilePath}/profile`)).pinned).toBeNull();
    expect((await api(forkPath)).queue).toEqual({ ...beforeStaleConfig.queue, reason: 'Server restarted. Review and resume queued messages explicitly.' });
    expect(await api(`${profilePath}/history/redo`, { checkpointId: profileCompactCheckpoint })).toEqual(profileCompacted.history);
    const profileRestored = await api(profilePath);
    expect(profileRestored.messages).toEqual(profileCompacted.messages); expect(profileRestored.session.profile).toEqual(profileCompacted.session.profile);
    expect((await api(`${profilePath}/profile`)).pinned).toEqual(profilePinned.pinned);
    expect((await api(profileArchivePath)).messages).toEqual(profileArchive.messages);
    expect((await api(`${profilePath}/changes`)).changes).toEqual([]);
    expect(providerCalls).toHaveLength(12); expect(catalogCalls).toBe(1);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    await expect(readFile(join(workspace, 'profile-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, '.speedrail', 'profiles.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Exercise the built MCP manager with an isolated stdio process, not a
    // source import. Its protocol input is bounded and every external action
    // is logged outside the workspace so history cannot manufacture evidence.
    const mcpScript = join(installation, 'runtime-mcp.mjs');
    const mcpLog = join(temporary, 'runtime-mcp.jsonl');
    const mcpCatalog = join(temporary, 'runtime-mcp-catalog.json');
    const mcpNotify = join(temporary, 'runtime-mcp-notify.txt');
    const originalMcpTool = { name: 'echo', description: 'Runtime isolated echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
    await writeFile(mcpCatalog, JSON.stringify([originalMcpTool]));
    await writeFile(mcpNotify, '0');
    await writeFile(mcpScript, `import {appendFileSync,readFileSync,watchFile} from 'node:fs';
import {createInterface} from 'node:readline';
const [log,catalog,notification,endpoint]=process.argv.slice(2);
const record=event=>appendFileSync(log,JSON.stringify({event,endpoint})+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
if(process.version!==${JSON.stringify(version.output.trim())}||process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY||process.env.SPEEDRAIL_DATA_DIR)process.exit(3);
record('spawn');
watchFile(notification,{interval:10},(now,old)=>{if(now.mtimeMs!==old.mtimeMs){record('changed');send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});}});
createInterface({input:process.stdin}).on('line',line=>{
  if(line.length>1048576)process.exit(4);
  const message=JSON.parse(line);if(message.id===undefined)return;record(message.method);
  if(message.method==='initialize')reply(message.id,{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'runtime-isolated',version:'1'}});
  else if(message.method==='tools/list')reply(message.id,{tools:JSON.parse(readFileSync(catalog,'utf8'))});
  else if(message.method==='tools/call')reply(message.id,{content:[{type:'text',text:'Runtime MCP executed at '+endpoint}]});
  else reply(message.id,{});
});
process.stdin.on('end',()=>process.exit(0));
`);
    // advertise:true — this scenario asserts the DIRECT advertisement path,
    // which Phase 4.6 made per-server opt-in (default routes via the capability gateway).
    const mcpConfig = (endpoint: string) => ({ runtime: { command: runtime!, args: [mcpScript, mcpLog, mcpCatalog, mcpNotify, endpoint], env: { HOME: temporary, PATH: '/usr/bin:/bin' }, advertise: true } });
    const mcpRecords = async (): Promise<{ event: string; endpoint: string }[]> => {
      try { return (await readFile(mcpLog, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    };
    const countMcp = async (event: string) => (await mcpRecords()).filter(record => record.event === event).length;
    const mcpAction = async (action: 'refresh' | 'reconnect') => {
      const status = await api('/mcp');
      return api(`/mcp/runtime/${action}`, { expectedRevision: status.servers[0].revision, expectedConfigRevision: status.configRevision });
    };
    const awaitMcpIdle = async (path: string) => { await expect.poll(async () => (await api(path)).session.status, { timeout: 5000, interval: 10 }).toBe('idle'); };
    const awaitMcpPermission = async (path: string) => {
      await expect.poll(async () => (await api(path)).permissions.length, { timeout: 5000, interval: 10 }).toBe(1);
      return (await api(path)).permissions[0];
    };
    const settingsBeforeMcp = await api('/settings');
    await api('/settings', { mcpServers: mcpConfig('original'), expectedMcpConfigRevision: settingsBeforeMcp.mcpConfigRevision }, 'PATCH');
    const coldMcp = await api('/mcp');
    expect(coldMcp.servers).toMatchObject([{ name: 'runtime', status: 'disconnected', tools: [] }]);
    expect((await api('/settings')).mcpConfigRevision).toBe(coldMcp.configRevision);
    const coldRefresh = await fetch(`${app.base}/api/mcp/runtime/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: coldMcp.servers[0].revision, expectedConfigRevision: coldMcp.configRevision }) });
    expect(coldRefresh.status).toBe(409);
    await coldRefresh.json();
    const coldProbe = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'run', '--url', app.base, '--auto', '--json', 'runtime MCP cold probe'], workspace, env).finished;
    expect(coldProbe.code, coldProbe.output).toBe(0);
    expect(providerCalls).toHaveLength(13);
    expect(providerCalls.at(-1)?.tools?.some(tool => tool.function.name.startsWith('mcp_'))).toBe(false);
    expect(await mcpRecords()).toEqual([]);
    await mcpAction('reconnect');
    const connectedMcp = await api('/mcp');
    expect(connectedMcp.servers).toMatchObject([{ name: 'runtime', status: 'connected', tools: [{ remoteName: 'echo' }] }]);
    expect(await countMcp('spawn')).toBe(1); expect(await countMcp('tools/list')).toBe(1);
    const mcpSession = await api('/sessions', { title: 'Runtime MCP history', mode: 'build', permissionMode: 'ask' });
    const mcpPath = `/sessions/${mcpSession.id}`;
    const mcpBaseline = await api(mcpPath);
    await api(`${mcpPath}/messages`, { content: 'runtime MCP execute with explicit approval' });
    const permission = await awaitMcpPermission(mcpPath);
    expect(advertisedMcpName).toBe(connectedMcp.servers[0].tools[0].name);
    expect(providerCalls.at(-1)?.tools?.some(tool => tool.function.name === advertisedMcpName)).toBe(true);
    expect(await countMcp('tools/call')).toBe(0);
    await api(`${mcpPath}/permissions/${permission.id}`, { decision: 'allow' });
    await awaitMcpIdle(mcpPath);
    const mcpCompleted = await api(mcpPath);
    expect(mcpCompleted.messages.at(-1).content).toBe('Runtime MCP complete.');
    expect(mcpCompleted.messages.some((message: { role: string; content: string }) => message.role === 'tool' && message.content.includes('Runtime MCP executed at original'))).toBe(true);
    expect(providerCalls).toHaveLength(15); expect(await countMcp('tools/call')).toBe(1);
    const mcpCheckpoint = mcpCompleted.history.undoId;
    const mcpUndone = await api(`${mcpPath}/history/undo`, { checkpointId: mcpCheckpoint });
    expect((await api(mcpPath)).messages).toEqual(mcpBaseline.messages);
    const mcpActionsBeforeRestart = await mcpRecords();
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0);
    app = await start(false);
    expect((await api('/mcp')).servers).toMatchObject([{ name: 'runtime', status: 'disconnected', tools: [] }]);
    expect((await api(mcpPath)).history).toEqual(mcpUndone);
    await api('/settings'); await api('/mcp');
    expect(await mcpRecords()).toEqual(mcpActionsBeforeRestart);
    expect(await api(`${mcpPath}/history/redo`, { checkpointId: mcpCheckpoint })).toEqual(mcpCompleted.history);
    expect((await api(mcpPath)).messages).toEqual(mcpCompleted.messages);
    expect(await mcpRecords()).toEqual(mcpActionsBeforeRestart); expect(providerCalls).toHaveLength(15);
    const restartProbe = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'run', '--url', app.base, '--auto', '--json', 'runtime MCP restart probe'], workspace, env).finished;
    expect(restartProbe.code, restartProbe.output).toBe(0);
    expect(providerCalls).toHaveLength(16);
    expect(providerCalls.at(-1)?.tools?.some(tool => tool.function.name.startsWith('mcp_'))).toBe(false);
    expect(await mcpRecords()).toEqual(mcpActionsBeforeRestart);
    await mcpAction('reconnect');
    expect(await countMcp('spawn')).toBe(2); expect(await countMcp('tools/list')).toBe(2);
    // A pending approval refers to the originally advertised connection. Even
    // connecting a replacement cannot redirect that accepted turn's tool call.
    const replacedSession = await api('/sessions', { title: 'Runtime MCP config lease', mode: 'build', permissionMode: 'ask' });
    const replacedPath = `/sessions/${replacedSession.id}`;
    await api(`${replacedPath}/messages`, { content: 'runtime MCP await endpoint review' });
    const replacedPermission = await awaitMcpPermission(replacedPath);
    const beforeReplacement = await api('/settings');
    await api('/settings', { mcpServers: mcpConfig('replacement'), expectedMcpConfigRevision: beforeReplacement.mcpConfigRevision }, 'PATCH');
    expect((await api('/mcp')).servers[0]).toMatchObject({ status: 'disconnected', tools: [] });
    expect(await countMcp('spawn')).toBe(2);
    await mcpAction('reconnect');
    expect(await countMcp('spawn')).toBe(3); expect(await countMcp('tools/list')).toBe(3);
    await api(`${replacedPath}/permissions/${replacedPermission.id}`, { decision: 'allow' });
    await awaitMcpIdle(replacedPath);
    expect(providerCalls).toHaveLength(18); expect(await countMcp('tools/call')).toBe(1);
    expect((await api(replacedPath)).messages.some((message: { role: string; content: string }) => message.role === 'tool' && /stale|changed|no longer/i.test(message.content))).toBe(true);
    // An unsolicited catalog-change notification invalidates the lease but
    // cannot discover a new catalog or execute anything by itself.
    const changedSession = await api('/sessions', { title: 'Runtime MCP catalog lease', mode: 'build', permissionMode: 'ask' });
    const changedPath = `/sessions/${changedSession.id}`;
    await api(`${changedPath}/messages`, { content: 'runtime MCP await catalog review' });
    const changedPermission = await awaitMcpPermission(changedPath);
    await writeFile(mcpCatalog, JSON.stringify([{ ...originalMcpTool, description: 'Reviewed changed runtime catalog' }]));
    await writeFile(mcpNotify, '1');
    await expect.poll(async () => (await api('/mcp')).servers[0].status, { timeout: 5000, interval: 10 }).toBe('stale');
    expect((await api('/mcp')).servers[0].tools).toEqual([]);
    expect(await countMcp('tools/list')).toBe(3);
    await api(`${changedPath}/permissions/${changedPermission.id}`, { decision: 'allow' });
    await awaitMcpIdle(changedPath);
    expect(providerCalls).toHaveLength(20); expect(await countMcp('tools/call')).toBe(1);
    await mcpAction('refresh');
    expect(await countMcp('spawn')).toBe(3); expect(await countMcp('tools/list')).toBe(4);
    const freshSession = await api('/sessions', { title: 'Runtime MCP reviewed catalog', mode: 'build', permissionMode: 'ask' });
    const freshPath = `/sessions/${freshSession.id}`;
    await api(`${freshPath}/messages`, { content: 'runtime MCP explicitly use reviewed catalog' });
    const freshPermission = await awaitMcpPermission(freshPath);
    expect(await countMcp('tools/call')).toBe(1);
    await api(`${freshPath}/permissions/${freshPermission.id}`, { decision: 'allow' });
    await awaitMcpIdle(freshPath);
    expect((await mcpRecords()).filter(record => record.event === 'tools/call')).toEqual([{ event: 'tools/call', endpoint: 'original' }, { event: 'tools/call', endpoint: 'replacement' }]);
    expect(providerCalls).toHaveLength(22); expect(catalogCalls).toBe(1);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect((await api(`${profilePath}/profile`)).pinned).toEqual(profilePinned.pinned);
    // Installed CLI uses ordinary approval semantics for the foreground task:
    // noninteractive Ask denies without creating a child; explicit Plan+Auto
    // launches one bounded researcher whose only action is reading exact bytes.
    const mcpBeforeResearch = await mcpRecords();
    const deniedResearch = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'run', '--url', app.base, '--plan', '--json', 'runtime delegation denied noninteractive'], workspace, env).finished;
    expect(deniedResearch.code, deniedResearch.output).toBe(0);
    expect(deniedResearch.output).toContain('Denied task: interactive approval required');
    expect(providerCalls).toHaveLength(24);
    const afterDenied = (await api('/sessions')).sessions;
    const deniedSession = afterDenied.find((value: { title: string }) => value.title === 'runtime delegation denied noninteractive');
    expect(deniedSession).toBeTruthy(); expect((await api(`/sessions/${deniedSession.id}`)).delegations).toEqual([]);
    const research = await processResult(runtime!, [join(installation, 'bin/speedrail.mjs'), 'run', '--url', app.base, '--plan', '--auto', '--json', 'runtime delegation CLI read'], workspace, env).finished;
    expect(research.code, research.output).toBe(0); expect(research.output).toContain('Runtime delegation parent complete.');
    expect(providerCalls).toHaveLength(28);
    const researchSession = (await api('/sessions')).sessions.find((value: { title: string }) => value.title === 'runtime delegation CLI read');
    const researchPath = `/sessions/${researchSession.id}`;
    const researchCompleted = await api(researchPath);
    expect(researchCompleted.delegations).toHaveLength(1);
    const delegation = researchCompleted.delegations[0];
    expect(delegation.status).toBe('completed');
    const researcherPath = `${researchPath}/delegations/${delegation.id}`;
    const researcher = await api(researcherPath);
    expect(researcher).toMatchObject({ readOnly: true, delegation: { id: delegation.id, status: 'completed' } });
    expect(researcher.messages.flatMap((message: { toolCalls?: unknown[] }) => message.toolCalls ?? [])).toMatchObject([{ name: 'read_file', status: 'completed' }]);
    expect(researcher.messages.find((message: { role: string }) => message.role === 'user').content).toBe('runtime delegation child read independently');
    expect(providerCalls[25].tools?.map(tool => tool.function.name).sort()).toEqual(['glob', 'grep', 'history_search', 'read_file', 'todo_read', 'tool_output_page', 'view_image', 'web_fetch', 'web_search']);
    expect(JSON.stringify(providerCalls[26].messages)).toContain('persisted runtime output');
    expect((await api('/sessions')).sessions.some((value: { id: string }) => value.id === delegation.childSessionId)).toBe(false);
    const forbiddenChild = await fetch(`${app.base}/api/sessions/${delegation.childSessionId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Bypass readonly child' }) });
    expect(forbiddenChild.status).toBe(409); await forbiddenChild.json();
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes); expect(await mcpRecords()).toEqual(mcpBeforeResearch);
    const researchCheckpoint = researchCompleted.history.undoId;
    await api(`${researchPath}/history/undo`, { checkpointId: researchCheckpoint });
    expect((await api(researchPath)).delegations).toEqual([]);
    const hiddenResearch = await fetch(`${app.base}/api${researcherPath}`); expect(hiddenResearch.status).toBe(404); await hiddenResearch.json();
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0); app = await start(false);
    expect((await api(researchPath)).delegations).toEqual([]);
    await api(`${researchPath}/history/redo`, { checkpointId: researchCheckpoint });
    expect((await api(researchPath)).messages).toEqual(researchCompleted.messages);
    expect((await api(researcherPath)).messages).toEqual(researcher.messages);
    expect(providerCalls).toHaveLength(28); expect(await mcpRecords()).toEqual(mcpBeforeResearch);
    // Stop only a running child, then terminate another server process while a
    // child is in flight. Restart resolves its durable link without a new call.
    const cancelledParent = await api('/sessions', { mode: 'plan', permissionMode: 'auto', title: 'Runtime cancelled researcher' });
    const cancelledPath = `/sessions/${cancelledParent.id}`;
    await api(`${cancelledPath}/messages`, { content: 'runtime delegation hold cancel' });
    await expect.poll(() => heldResearchers.size, { timeout: 5000, interval: 10 }).toBe(1);
    const cancelling = (await api(cancelledPath)).delegations[0];
    await api(`${cancelledPath}/queue`, { content: 'Must remain queued after child cancellation.' });
    await api(`${cancelledPath}/delegations/${cancelling.id}/cancel`, {});
    await awaitMcpIdle(cancelledPath);
    expect((await api(cancelledPath)).delegations[0].status).toBe('cancelled');
    expect((await api(cancelledPath)).messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(1);
    expect((await api(cancelledPath)).queue).toMatchObject({ paused: true, items: [{ content: 'Must remain queued after child cancellation.' }] });
    await expect.poll(() => cancelledResearchers, { timeout: 5000, interval: 10 }).toBe(1);
    expect(providerCalls).toHaveLength(31);
    const interruptedParent = await api('/sessions', { mode: 'plan', permissionMode: 'auto', title: 'Runtime interrupted researcher' });
    const interruptedResearchPath = `/sessions/${interruptedParent.id}`;
    await api(`${interruptedResearchPath}/messages`, { content: 'runtime delegation hold crash' });
    await expect.poll(() => heldResearchers.size, { timeout: 5000, interval: 10 }).toBe(1);
    const interrupted = (await api(interruptedResearchPath)).delegations[0];
    expect(providerCalls).toHaveLength(33);
    app.child.kill('SIGKILL'); expect((await app.finished).signal).toBe('SIGKILL');
    app = await start(false);
    await expect.poll(() => cancelledResearchers, { timeout: 5000, interval: 10 }).toBe(2);
    const interruptedDetail = await api(interruptedResearchPath);
    expect(interruptedDetail.delegations[0].status).toBe('interrupted');
    expect(interruptedDetail.messages.filter((message: { role: string }) => message.role === 'tool')).toHaveLength(1);
    expect((await api(`${interruptedResearchPath}/delegations/${interrupted.id}`)).delegation.status).toBe('interrupted');
    expect(providerCalls).toHaveLength(33); expect(await mcpRecords()).toEqual(mcpBeforeResearch);
    app.child.kill('SIGTERM'); expect((await app.finished).code).toBe(0); app = await start(false);
    expect((await api(interruptedResearchPath)).messages).toEqual(interruptedDetail.messages);
    expect((await api(interruptedResearchPath)).delegations).toEqual(interruptedDetail.delegations);
    expect(providerCalls).toHaveLength(33); expect(catalogCalls).toBe(1);
    expect(await readFile(join(workspace, 'runtime.txt'))).toEqual(fixtureBytes);
    expect((await api(`${profilePath}/profile`)).pinned).toEqual(profilePinned.pinned);
    // Validate the installed native PTY on this exact ABI without starting a
    // login shell (which would read the real user's startup files).
    const pty = await processResult(runtime!, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(installation, 'package.json'))}); const {spawn}=require('node-pty'); const p=spawn('/bin/sh',['-c','printf "PTY_RUNTIME_OK\\n"'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',HOME:process.cwd(),TERM:'xterm'}}); p.onData(s=>process.stdout.write(s)); p.onExit(e=>process.exit(e.exitCode)); setTimeout(()=>process.exit(2),3000).unref();`], workspace, env).finished;
    expect(pty.code, pty.output).toBe(0);
    expect(pty.output).toContain('PTY_RUNTIME_OK');
    app.child.kill('SIGINT');
    expect((await app.finished).code).toBe(0);
  }, 30_000);
});
