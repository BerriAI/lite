import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../../server/store.js';
import { createApp } from '../../server/app.js';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'shunt-runner-probe-')));
const upstream = resolve(process.argv[2]);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const results = [];
let requests: any[] = [];
let readArgs = { path: 'large.ts' } as Record<string, unknown>;
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  const delta = requests.length === 1
    ? { tool_calls: [{ index: 0, id: 'probe-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(readArgs) } }] }
    : { content: 'Analysis complete.' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
const store = new Store(join(directory, 'state'));
const { runner } = createApp({ store });
await writeFile(join(directory, 'large.ts'), '// corpus-sentinel\n'.repeat(351));
try {
  for (const variant of ['off', 'copied-hook-with-input-adapter', 'exit-2-adapter', 'targeted-read'] as const) {
    requests = [];
    readArgs = { path: 'large.ts', ...(variant === 'targeted-read' ? { offset: 1, limit: 5 } : {}) };
    const upstreamCommand = `jq '{tool_input:{file_path:.args.path,offset:.args.offset,limit:.args.limit}}' | bash ${quote(join(upstream, 'plugins/shunt/hooks/check-file-size'))}`;
    const command = variant === 'copied-hook-with-input-adapter' ? upstreamCommand
      : `${upstreamCommand} | jq -r 'if .decision == "block" then .reason else empty end' > ${quote(join(directory, 'gate.txt'))}; if [ -s ${quote(join(directory, 'gate.txt'))} ]; then cat ${quote(join(directory, 'gate.txt'))} >&2; exit 2; fi`;
    store.saveSettings({ workspace: directory, providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl }],
      defaultProvider: 'fixture', defaultModel: 'fixture', maxSteps: 4,
      hooks: variant === 'off' ? [] : [{ event: 'PreToolUse', matcher: 'read_file', command }] });
    const session = store.createSession({ permissionMode: 'auto' });
    store.saveQueue(session.id, { items: [], paused: false });
    runner.start(session.id, 'Analyze large.ts.'); await runner.whenIdle();
    const calls = store.messages(session.id).flatMap(message => message.toolCalls ?? []);
    results.push({ variant, providerRequests: requests.length, callStatus: calls[0]?.status,
      fullCorpusReachedModel: requests.slice(1).some(request => (JSON.stringify(request).match(/corpus-sentinel/g) ?? []).length >= 351),
      routingHintReachedModel: requests.slice(1).some(request => JSON.stringify(request).includes('/bulk-reader')),
      resultLines: calls[0]?.output?.split('\n').length, finalStatus: store.session(session.id).status,
      queue: store.queue(session.id) });
  }
  await writeFile(new URL('./results/runner-probe.json', import.meta.url), JSON.stringify({ litespeedCommit: 'be152dbac93e574d611c2312eb86b3e3927f30e7', results }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  runner.stopAll(); await runner.whenIdle(); store.close();
  provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
