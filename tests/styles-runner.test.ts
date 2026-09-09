import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { OUTPUT_STYLES } from '../shared/styles.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const stream = (res: ServerResponse, delta: unknown, finish = 'stop') => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`); };
const text = (res: ServerResponse, content = 'Done') => stream(res, { content });
const tools = (res: ServerResponse, calls: { name: string; args?: Record<string, unknown> }[]) => stream(res, { tool_calls: calls.map((call, index) => ({ index, id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }, 'tool_calls');
const isChild = (body: any) => body.messages.find((m: any) => m.role === 'user')?.content?.startsWith('CHILD');

describe('output styles (5.7): system prompt tail, acceptance capture, config semantics', () => {
  let directory: string, store: Store, server: Server, provider: Server, url: string, runner: ReturnType<typeof createApp>['runner'];
  let calls: any[], respond: (body: any, res: ServerResponse) => void;
  const api = async (path: string, data?: unknown, method?: string) => { const response = await fetch(url + '/api' + path, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  const create = async (extra: Record<string, unknown> = {}) => { const result = await api('/sessions', { permissionMode: 'auto', ...extra }); expect(result.status).toBe(201); return result.body; };
  const run = async (id: string, content = 'Do the task') => { runner.start(id, content); await runner.whenIdle(); };
  const system = (body: any) => body.messages[0].content as string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-styles-'))); store = new Store(join(directory, 'state')); calls = [];
    respond = (_body, res) => text(res);
    provider = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(part); const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); respond(body, res); });
    const baseUrl = await listen(provider);
    store.saveSettings({ workspace: directory, providers: [{ id: 'test', name: 'Test', kind: 'openai', baseUrl, apiKey: 'fake-key' }], defaultProvider: 'test', defaultModel: 'model', maxSteps: 12 });
    const app = createApp({ store }); runner = app.runner; server = createServer(app.app); url = await listen(server);
  });
  afterEach(async () => { runner.stopAll(); await runner.whenIdle(); await close(server); await close(provider); store.close(); await rm(directory, { recursive: true, force: true }); });

  it('appends the builtin style text to the outbound system prompt tail, subordinated, and keeps it byte-stable across turns', async () => {
    const session = await create({ outputStyle: 'concise' });
    await run(session.id, 'First turn'); await run(session.id, 'Second turn');
    for (const body of calls) {
      expect(system(body)).toContain(OUTPUT_STYLES.concise);
      expect(system(body)).toContain('never overrides the instructions, mode, or permissions');
      // The style is a TAIL: it comes after workspace/instructions.
      expect(system(body).indexOf('Workspace:')).toBeLessThan(system(body).indexOf(OUTPUT_STYLES.concise));
      // Never in the envelope or conversation content.
      expect(JSON.stringify(body.messages.slice(1))).not.toContain(OUTPUT_STYLES.concise.slice(0, 40));
    }
    // Cache contract: identical system prompt bytes across turns WITH a style set.
    expect(system(calls[1])).toBe(system(calls[0]));
    // Styles never persist into stored history.
    expect(store.messages(session.id).some(m => m.content.includes(OUTPUT_STYLES.concise))).toBe(false);
  });

  it('each builtin resolves to its own distinct text', async () => {
    for (const name of ['explanatory', 'learning'] as const) {
      calls = [];
      const session = await create({ outputStyle: name });
      await run(session.id);
      expect(system(calls[0])).toContain(OUTPUT_STYLES[name]);
    }
  });

  it('reads a workspace .lite/styles/<name>.md when the name is not a builtin', async () => {
    await mkdir(join(directory, '.lite', 'styles'), { recursive: true });
    await writeFile(join(directory, '.lite', 'styles', 'pirate.md'), 'Answer briefly, in the voice of a careful pirate.');
    expect((await api(`/styles?workspace=${encodeURIComponent(directory)}`)).body).toEqual({ styles: ['pirate'] });
    const session = await create({ outputStyle: 'pirate' });
    await run(session.id);
    expect(system(calls[0])).toContain('careful pirate');
    expect(store.messages(session.id).filter(m => m.role === 'system')).toEqual([]); // No advisory.
  });

  it('a missing style yields a visible advisory and no style text; the turn still runs', async () => {
    const session = await create({ outputStyle: 'nonexistent' });
    await run(session.id);
    expect(system(calls[0])).not.toContain('Output style (user-selected');
    const advisory = store.messages(session.id).find(m => m.role === 'system');
    expect(advisory?.content).toContain('"nonexistent"');
    expect(advisory?.content).toContain('ignored for this turn');
    expect(store.session(session.id).status).toBe('idle'); // Ran to completion.
  });

  it('is captured at acceptance: a mid-turn style PATCH is rejected idle-only, and a file edit mid-session never changes the accepted turn', async () => {
    await mkdir(join(directory, '.lite', 'styles'), { recursive: true });
    await writeFile(join(directory, '.lite', 'styles', 'house.md'), 'HOUSE-STYLE-V1 applies.');
    const session = await create({ outputStyle: 'house' });
    let released!: () => void; const gate = new Promise<void>(resolve => { released = resolve; });
    respond = (_body, res) => { void gate.then(() => text(res)); };
    const running = (async () => { runner.start(session.id, 'Busy turn'); await runner.whenIdle(); })();
    while ((await api(`/sessions/${session.id}`)).body.session.status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    // Idle-only, exactly like a model change: 409 while running.
    expect((await api(`/sessions/${session.id}`, { outputStyle: 'concise' }, 'PATCH')).status).toBe(409);
    released!(); await running;
    expect(system(calls[0])).toContain('HOUSE-STYLE-V1');
    // Editing the file between turns changes the NEXT accepted turn only.
    await writeFile(join(directory, '.lite', 'styles', 'house.md'), 'HOUSE-STYLE-V2 applies.');
    respond = (_body, res) => text(res);
    await run(session.id, 'Next turn');
    expect(system(calls.at(-1))).toContain('HOUSE-STYLE-V2');
  });

  it('changing or clearing the style bumps configRevision and holds the queue, mirroring planner semantics', async () => {
    const session = await create();
    const before = (await api(`/sessions/${session.id}`)).body.session.configRevision ?? 0;
    const patched = await api(`/sessions/${session.id}`, { outputStyle: 'learning' }, 'PATCH');
    expect(patched.status).toBe(200);
    expect(patched.body.outputStyle).toBe('learning');
    expect(patched.body.configRevision).toBe(before + 1);
    // Same-value PATCH does not bump.
    expect((await api(`/sessions/${session.id}`, { outputStyle: 'learning' }, 'PATCH')).body.configRevision).toBe(before + 1);
    // Queue hold: queued work must be reviewed after a config change.
    await api(`/sessions/${session.id}/queue`, { content: 'queued work' });
    const held = await api(`/sessions/${session.id}`, { outputStyle: 'concise' }, 'PATCH');
    expect(held.body.configRevision).toBe(before + 2);
    expect((await api(`/sessions/${session.id}/queue`)).body.paused).toBe(true);
    // null clears the field entirely.
    const cleared = await api(`/sessions/${session.id}`, { outputStyle: null }, 'PATCH');
    expect(cleared.body.outputStyle).toBeUndefined();
    expect(cleared.body.configRevision).toBe(before + 3);
    // Invalid names are schema-rejected.
    expect((await api(`/sessions/${session.id}`, { outputStyle: '../evil' }, 'PATCH')).status).toBe(400);
  });

  it('caps a workspace style file at 4KiB and treats an empty file as missing', async () => {
    await mkdir(join(directory, '.lite', 'styles'), { recursive: true });
    await writeFile(join(directory, '.lite', 'styles', 'huge.md'), `LEAD-TEXT ${'x'.repeat(8000)}TAIL-MARKER`);
    await writeFile(join(directory, '.lite', 'styles', 'empty.md'), '   \n');
    const session = await create({ outputStyle: 'huge' });
    await run(session.id);
    expect(system(calls[0])).toContain('LEAD-TEXT');
    expect(system(calls[0])).not.toContain('TAIL-MARKER'); // Beyond the 4KiB cap.
    calls = [];
    const emptySession = await create({ outputStyle: 'empty' });
    await run(emptySession.id);
    expect(system(calls[0])).not.toContain('Output style (user-selected');
    expect(store.messages(emptySession.id).find(m => m.role === 'system')?.content).toContain('ignored for this turn');
  });

  it('a child researcher inherits the parent turn\'s captured style through its system prompt', async () => {
    const session = await create({ outputStyle: 'explanatory' });
    respond = (body, res) => { if (isChild(body)) text(res, 'Child report'); else if (body.messages.at(-1)?.role === 'tool') text(res); else tools(res, [{ name: 'task', args: { description: 'Inspect', prompt: 'CHILD inspect something' } }]); };
    await run(session.id);
    const childCall = calls.find(isChild)!;
    expect(childCall).toBeDefined();
    // Children get the captured system prompt (policy.style rides the policy),
    // so the style text appears in the child request too.
    expect(system(childCall)).toContain(OUTPUT_STYLES.explanatory);
  });

  it('GET /api/styles lists only well-formed .md names and returns [] with no styles directory', async () => {
    expect((await api(`/styles?workspace=${encodeURIComponent(directory)}`)).body).toEqual({ styles: [] });
    await mkdir(join(directory, '.lite', 'styles'), { recursive: true });
    await writeFile(join(directory, '.lite', 'styles', 'beta.md'), 'B');
    await writeFile(join(directory, '.lite', 'styles', 'alpha.md'), 'A');
    await writeFile(join(directory, '.lite', 'styles', 'not-a-style.txt'), 'nope');
    await writeFile(join(directory, '.lite', 'styles', 'bad name.md'), 'nope');
    expect((await api(`/styles?workspace=${encodeURIComponent(directory)}`)).body).toEqual({ styles: ['alpha', 'beta'] });
  });
});
