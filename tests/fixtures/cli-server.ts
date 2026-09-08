import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';

// This process deliberately does not import server/index.ts: fixture startup never loads .env,
// attaches a terminal, or contacts a provider other than its own loopback mock.
const workspace = process.env.CLI_TEST_WORKSPACE!;
if (!workspace) throw new Error('CLI_TEST_WORKSPACE is required.');
const store = new Store(join(workspace, 'state'));
const secret = 'CLI_FIXTURE_KEY_DO_NOT_PRINT';
const requests: unknown[] = [];
const heldResponses = new Map<string, () => void>();
const races = new Map<string, { prompt: string; phases: string[] }>();
const missingMessageIds = new Set<string>();
const mock = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/broken/')) { res.writeHead(401); res.end(JSON.stringify({ error: { message: `Rejected ${secret}` } })); return; }
    res.end(JSON.stringify({ data: [{ id: 'cli-default' }, { id: 'cli-alternate' }] })); return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const latest = body.messages.filter((m: { role: string }) => m.role === 'user').at(-1)?.content;
    const prompt = typeof latest === 'string' ? latest : JSON.stringify(latest);
    if (prompt.startsWith('race-prior-')) {
      // The continuation POST releases this real provider response only after its SSE is open.
      heldResponses.set(prompt, () => {
        if (prompt === 'race-prior-error') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Previous run failed deliberately.' } }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Previous run finished.' }, finish_reason: 'stop' }] })}\n\n`);
          res.end('data: [DONE]\n\n');
        }
      });
      res.on('close', () => heldResponses.delete(prompt)); return;
    }
    if (prompt.includes('provider-error')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Rejected ${secret}` } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: unknown, finish_reason?: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (prompt.includes('write-fixture') && body.messages.at(-1)?.role !== 'tool') {
      emit({ tool_calls: [{ index: 0, id: 'cli-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'cli-output.txt', content: 'Written by the CLI fixture.\n' }) } }] });
      emit({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return;
    }
    if (prompt.includes('slow-stream')) {
      emit({ content: 'Stream started' });
      const timer = setTimeout(() => { emit({ content: ' and finished.' }); emit({}, 'stop'); res.end('data: [DONE]\n\n'); }, 10000);
      res.on('close', () => clearTimeout(timer)); return;
    }
    emit({ reasoning_content: 'Checking the CLI request.' });
    const text = prompt.includes('write-fixture') ? 'Tool request finished.' : `Reply: ${prompt} — café ready.\n`;
    for (const part of text.match(/.{1,7}|\n/g) ?? []) {
      if (res.destroyed) return;
      emit({ content: part });
      await new Promise(resolve => setTimeout(resolve, 6));
    }
    emit({}, 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 13 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch { if (!res.writableEnded) { res.writeHead(500); res.end(); } }
});
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const mockUrl = await listen(mock);
store.saveSettings({ workspace, providers: [
  { id: 'fixture', name: 'CLI fixture', kind: 'openai', baseUrl: `${mockUrl}/v1`, apiKey: secret },
  { id: 'alternate', name: 'Alternate fixture', kind: 'openai', baseUrl: `${mockUrl}/v1`, apiKey: secret },
  { id: 'broken', name: 'Unavailable fixture', kind: 'openai', baseUrl: `${mockUrl}/broken/v1`, apiKey: secret },
], defaultProvider: 'fixture', defaultModel: 'cli-default', permissionMode: 'ask', maxSteps: 8, mcpServers: {} });
const { app, runner, bus } = createApp({ store });
app.get('/fixture/requests', (_req, res) => res.json({ requests }));
app.post('/fixture/race/:id', express.json(), (req, res) => {
  races.set(req.params.id, { prompt: req.body.prompt, phases: [] }); res.json({ ok: true });
});
app.post('/fixture/missing-message-id/:id', (req, res) => {
  missingMessageIds.add(req.params.id); res.json({ ok: true });
});
app.get('/fixture/race/:id', (req, res) => {
  const race = races.get(req.params.id);
  res.json({ ...race, ready: Boolean(race && heldResponses.has(race.prompt)) });
});
const server = createServer(async (req, res) => {
  const match = req.url?.match(/^\/api\/sessions\/([^/]+)\/(events|messages)$/);
  const race = match && races.get(match[1]);
  if (match && match[2] === 'messages' && req.method === 'POST' && missingMessageIds.delete(match[1])) {
    const response = res as express.Response;
    response.json = data => express.response.json.call(response, { ...data, messageId: undefined });
  }
  if (race && match[2] === 'events' && req.method === 'GET') {
    // app's future-only subscription is installed before its connected comment is written.
    const write = res.write.bind(res);
    res.write = ((...args: Parameters<typeof res.write>) => {
      if (String(args[0]) === ': connected\n\n') race.phases.push('subscribed');
      return write(...args);
    }) as typeof res.write;
  }
  if (race && race.phases.includes('subscribed') && match[2] === 'messages' && req.method === 'POST') {
    try {
      if (!race.phases.includes('subscribed')) throw new Error('Race continuation has no SSE subscription.');
      const release = heldResponses.get(race.prompt);
      if (!release) throw new Error('Race prior response is not ready.');
      race.phases.push('post-received');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Prior run did not finish.')); }, 3000);
        const unsubscribe = bus.subscribe(match[1], event => {
          if (event.type === 'done') {
            race.phases.push('prior-done'); clearTimeout(timeout); unsubscribe(); resolve();
          }
        });
        release();
      });
      // The old done is already on the CLI stream before the real API accepts its next turn.
      race.phases.push('post-dispatched');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message })); return;
    }
  }
  app(req, res);
});
const base = await listen(server);
process.stdout.write(`${JSON.stringify({ base })}\n`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true; runner.stopAll();
  const start = Date.now();
  while (store.sessions().some(s => runner.active(s.id)) && Date.now() - start < 2500) await new Promise(resolve => setTimeout(resolve, 10));
  for (const socketServer of [server, mock]) { socketServer.closeAllConnections(); await new Promise<void>(resolve => socketServer.close(() => resolve())); }
  store.close(); process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
