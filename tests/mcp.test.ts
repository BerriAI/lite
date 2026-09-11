import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager, MCP_LIMITS } from '../server/mcp.js';
import type { Settings } from '../shared/types.js';
import type { ExternalToolLease } from '../server/external.js';

let directory: string | undefined;
const managers: McpManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
const signal = () => new AbortController().signal;
const until = async (check: () => boolean | Promise<boolean>) => { await expect.poll(check, { timeout: 5000, interval: 10 }).toBe(true); };
function managerFor(config: Settings['mcpServers']) { const manager = new McpManager(() => config); managers.push(manager); return manager; }
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'litespeed-mcp-'));
  const script = join(directory, 'fixture.mjs'), log = join(directory, 'requests.jsonl'), state = join(directory, 'state.json');
  await writeFile(state, '{}');
  await writeFile(script, `import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
const [label,log,state]=process.argv.slice(2);
const settings=()=>JSON.parse(readFileSync(state,'utf8'));
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const changed=()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n');
const tools=()=>['echo','fail','slow','change','crash','output','resource'].map(name=>({name,description:'Tool '+name,inputSchema:{type:'object',properties:{text:{type:'string'}}}}));
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify({label,pid:process.pid,method:m.method,name:m.params?.name})+'\\n');
 if(m.id===undefined)return;
 if(m.method==='initialize')reply(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}});
 else if(m.method==='tools/list'){
  const s=settings();if(s.hang)return;
  if(s.frame){process.stdout.write('x'.repeat(s.frame));return;}
  if(s.invalid){process.stdout.write('not-json\\n');return;}
  if(s.stderr)process.stderr.write('SECRET STDERR '.repeat(100000));
  const result={tools:s.tools??tools(),...(s.cursor?{nextCursor:s.cursor}:{})};
  if(s.delay)setTimeout(()=>reply(m.id,result),s.delay);else reply(m.id,result);
  if(s.change)changed();
 }else if(m.method==='tools/call'){
  if(m.params.name==='slow')return;
  if(m.params.name==='crash'){process.exit(0);return;}
  if(m.params.name==='change'){reply(m.id,{content:[{type:'text',text:'changed'}]});changed();return;}
  if(m.params.name==='fail'){reply(m.id,{isError:true,content:[{type:'text',text:'fixture-secret failure'}]});return;}
  if(m.params.name==='output'){reply(m.id,{content:[{type:'text',text:'界'.repeat(70000)+'fixture-secret'}]});return;}
  if(m.params.name==='resource'){reply(m.id,{content:[{type:'resource',resource:{uri:'https://example.invalid/private',text:'RESOURCE_BODY'}}]});return;}
  reply(m.id,{content:[{type:'text',text:label+':'+m.params.arguments.text}]});
 }else reply(m.id,{});
});`);
  return {
    config: (label = 'ORIGINAL') => ({ command: process.execPath, args: [script, label, log, state], env: { TOKEN: 'fixture-secret' } }),
    set: async (value: object) => writeFile(state, JSON.stringify(value)),
    events: async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { label: string; pid: number; method: string; name?: string }); } catch { return []; } },
  };
}
async function connect(manager: McpManager, name = 'test') { await manager.reconnect(name, manager.status().find(server => server.name === name)!.revision, signal()); return manager.capture(signal()); }
function named(lease: ExternalToolLease, name = 'echo') { const tool = lease.definitions.find(tool => tool.function.name.includes(`_${name}_`)); expect(tool).toBeDefined(); return tool!.function.name; }

describe('explicit stdio MCP lifecycle', () => {
  it('status, revision and capture are synchronous cache-only with no process startup', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() });
    for (let i = 0; i < 3; i++) { expect(manager.status()[0]).toMatchObject({ status: 'disconnected', tools: [] }); expect(manager.configRevision()).toHaveLength(64); const lease = manager.capture(signal()); expect(lease.definitions).toEqual([]); lease.release(); }
    expect(await f.events()).toEqual([]);
  });
  it('discovers two explicit servers with collision-safe immutable definitions', async () => {
    const f = await fixture(), manager = managerFor({ one: f.config(), two: f.config() });
    await connect(manager, 'one'); const lease = await connect(manager, 'two');
    expect(lease.definitions).toHaveLength(14); expect(new Set(lease.definitions.map(tool => tool.function.name)).size).toBe(14);
    expect(lease.definitions.every(tool => tool.function.name.length <= 64)).toBe(true);
    expect(Object.isFrozen(lease)).toBe(true); expect(Object.isFrozen(lease.definitions)).toBe(true);
    expect(Object.isFrozen(lease.definitions[0].function.parameters.properties)).toBe(true);
    expect(() => { lease.definitions[0].function.parameters.type = 'array'; }).toThrow();
    expect(await lease.execute(named(lease), { text: 'hello' }, signal())).toBe('ORIGINAL:hello');
    expect(manager.status().every(server => server.status === 'connected')).toBe(true);
    lease.release();
  });
  it('never starts disabled servers or discovers on removal', async () => {
    const config: Settings['mcpServers'] = { off: { command: '/does/not/exist', enabled: false } }, manager = managerFor(config);
    expect(manager.status()[0].status).toBe('disabled'); expect(manager.capture(signal()).definitions).toEqual([]);
    await expect(manager.refresh('off', manager.status()[0].revision, signal())).rejects.toThrow();
    delete config.off; expect(manager.status()).toEqual([]);
  });
  it('startup failures reveal neither command contents nor configured secrets', async () => {
    const manager = managerFor({ test: { command: '/missing/fixture-secret', env: { TOKEN: 'fixture-secret' } } });
    await expect(connect(manager)).rejects.toThrow(); expect(manager.status()[0]).toMatchObject({ status: 'error', tools: [] });
    expect(JSON.stringify(manager.status())).not.toContain('fixture-secret'); expect(JSON.stringify(manager.status())).not.toContain('/missing');
  });
  it('redacts tool errors, bounds UTF-8 output and omits resource bodies', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), lease = await connect(manager);
    await expect(lease.execute(named(lease, 'fail'), {}, signal())).rejects.toThrow('[redacted] failure');
    const output = await lease.execute(named(lease, 'output'), {}, signal()); expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MCP_LIMITS.outputBytes); expect(output).not.toContain('�');
    const resource = await lease.execute(named(lease, 'resource'), {}, signal()); expect(resource).toBe('[resource content omitted]'); expect(resource).not.toContain('RESOURCE_BODY');
  });
  it('cancels a slow tool without replay and keeps the connection usable', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), lease = await connect(manager), controller = new AbortController();
    const pending = lease.execute(named(lease, 'slow'), {}, controller.signal), rejected = expect(pending).rejects.toThrow();
    await until(async () => (await f.events()).some(event => event.name === 'slow')); controller.abort(); await rejected;
    expect(await lease.execute(named(lease), { text: 'still connected' }, signal())).toBe('ORIGINAL:still connected');
    expect((await f.events()).filter(event => event.name === 'slow')).toHaveLength(1);
  });
  it('replacing executable arguments cannot route an old advertised name to a replacement process', async () => {
    const f = await fixture(), config = { test: f.config() }, manager = managerFor(config), old = await connect(manager), name = named(old), scope = old.scope(name);
    config.test = f.config('REPLACEMENT');
    await expect(old.execute(name, { text: 'forbidden' }, signal())).rejects.toThrow(); expect(manager.status()[0].status).toBe('disconnected');
    const fresh = await connect(manager); expect(named(fresh)).toBe(name); expect(fresh.scope(name)).not.toBe(scope);
    await expect(old.execute(name, {}, signal())).rejects.toThrow(); expect(await fresh.execute(name, { text: 'new turn' }, signal())).toBe('REPLACEMENT:new turn');
    expect((await f.events()).filter(event => event.method === 'tools/call')).toEqual([expect.objectContaining({ label: 'REPLACEMENT', name: 'echo' })]);
  });
  it('same-content reconnect invalidates generations but preserves approval scope', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), old = await connect(manager), name = named(old), scope = old.scope(name), revision = manager.status()[0].revision;
    await manager.reconnect('test', revision, signal()); const fresh = manager.capture(signal());
    expect(manager.status()[0].revision).not.toBe(revision); expect(fresh.scope(name)).toBe(scope); expect(() => old.assertCurrent(name)).toThrow();
    expect(new Set((await f.events()).map(event => event.pid)).size).toBe(2);
  });
  it('tool-list change invalidates without rediscovery and refresh changes content scope', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), old = await connect(manager), name = named(old), scope = old.scope(name);
    await old.execute(named(old, 'change'), {}, signal()).catch(() => {}); await until(() => manager.status()[0].status === 'stale');
    expect(() => old.assertCurrent(name)).toThrow(); expect(manager.capture(signal()).definitions).toEqual([]);
    expect((await f.events()).filter(event => event.method === 'tools/list')).toHaveLength(1);
    await f.set({ tools: [{ name: 'echo', description: 'changed catalog', inputSchema: { type: 'object' } }] });
    await manager.refresh('test', manager.status()[0].revision, signal()); const fresh = manager.capture(signal()); expect(fresh.scope(name)).not.toBe(scope); expect(new Set((await f.events()).map(event => event.pid)).size).toBe(1);
  });
  it('disconnect invalidates every lease without starting a replacement', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), lease = await connect(manager);
    await expect(lease.execute(named(lease, 'crash'), {}, signal())).rejects.toThrow(); await until(() => manager.status()[0].status === 'disconnected');
    expect(() => lease.assertCurrent(named(lease))).toThrow(); expect(manager.capture(signal()).definitions).toEqual([]);
    expect((await f.events()).filter(event => event.method === 'initialize')).toHaveLength(1);
  });
  it('refresh invalidates before awaiting discovery and a failed refresh exposes no partial catalog', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), lease = await connect(manager);
    await f.set({ delay: 100, cursor: 'repeated' });
    const pending = manager.refresh('test', manager.status()[0].revision, signal());
    expect(() => lease.assertCurrent(named(lease))).toThrow(); expect(manager.capture(signal()).definitions).toEqual([]);
    await expect(pending).rejects.toThrow(); expect(manager.status()[0]).toMatchObject({ status: 'error', tools: [] });
  });
  it('rejects stale revisions and overlapping operations without starting a second request', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await f.set({ delay: 100 }); const revision = manager.status()[0].revision;
    await expect(manager.refresh('test', 'stale', signal())).rejects.toThrow(); expect(await f.events()).toEqual([]);
    const pending = manager.reconnect('test', revision, signal()); await expect(manager.reconnect('test', manager.status()[0].revision, signal())).rejects.toThrow(); await pending;
    expect((await f.events()).filter(event => event.method === 'tools/list')).toHaveLength(1);
  });
  it('release and accepted-turn cancellation invalidate only that lease', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await connect(manager); const turn = new AbortController();
    const a = manager.capture(turn.signal), b = manager.capture(signal()); a.release(); await expect(a.execute(named(a), {}, signal())).rejects.toThrow();
    const c = manager.capture(turn.signal); turn.abort(); await expect(c.execute(named(c), {}, signal())).rejects.toThrow();
    expect(await b.execute(named(b), { text: 'other' }, signal())).toBe('ORIGINAL:other'); expect(manager.status()[0].status).toBe('connected');
  });
  it('close cancels discovery, waits for child exit and prevents late catalog publication', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await f.set({ hang: true });
    const pending = manager.reconnect('test', manager.status()[0].revision, signal()), rejected = expect(pending).rejects.toThrow();
    await until(async () => (await f.events()).some(event => event.method === 'tools/list')); const pid = (await f.events())[0].pid;
    await manager.close(); await rejected; expect(() => process.kill(pid, 0)).toThrow(); expect(manager.status()[0].tools).toEqual([]);
    expect(() => manager.capture(signal())).toThrow(); await expect(manager.reconnect('test', manager.status()[0].revision, signal())).rejects.toThrow();
    await manager.close();
  });
  it('close cancels and waits for active calls', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }), lease = await connect(manager);
    const pending = lease.execute(named(lease, 'slow'), {}, signal()), rejected = expect(pending).rejects.toThrow();
    await until(async () => (await f.events()).some(event => event.name === 'slow')); const pid = (await f.events())[0].pid;
    await manager.close(); await rejected; expect(() => process.kill(pid, 0)).toThrow(); expect(() => lease.assertCurrent(named(lease))).toThrow();
  });
  it.each([{ invalid: true }, { frame: MCP_LIMITS.frameBytes + 1 }])('bounds and rejects invalid stdio frames without raw stderr/errors (%j)', async state => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await f.set(state);
    await expect(connect(manager)).rejects.toThrow(); expect(manager.status()[0].tools).toEqual([]); expect(JSON.stringify(manager.status())).not.toContain('not-json');
  });
  it('drains large stderr without exposing it or stalling tools/list', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await f.set({ stderr: true }); const lease = await connect(manager);
    expect(lease.definitions).toHaveLength(7); expect(JSON.stringify(manager.status())).not.toContain('SECRET STDERR');
  });
  it('refresh is connected-only and cold or failed refresh never starts a process', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() });
    await expect(manager.refresh('test', manager.status()[0].revision, signal())).rejects.toThrow('Explicit reconnect required'); expect(await f.events()).toEqual([]);
    await f.set({ invalid: true }); await expect(connect(manager)).rejects.toThrow();
    // Failed discovery may still flush its cancellation notification while
    // the child closes. Compare executable requests, including process identity,
    // rather than requiring the best-effort notification journal to be quiescent.
    const executableRequests = async () => (await f.events()).filter(event => ['initialize', 'tools/list', 'tools/call'].includes(event.method));
    const before = await executableRequests();
    expect(before.filter(event => event.method === 'initialize')).toHaveLength(1);
    expect(before.filter(event => event.method === 'tools/list')).toHaveLength(1);
    expect(before.filter(event => event.method === 'tools/call')).toEqual([]);
    await expect(manager.refresh('test', manager.status()[0].revision, signal())).rejects.toThrow('Explicit reconnect required');
    expect(await executableRequests()).toEqual(before);
  });
  it('limits concurrent lifecycle work globally without launching the rejected ninth server', async () => {
    const f = await fixture(), config = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`server${i}`, f.config(String(i))])), manager = managerFor(config);
    await f.set({ hang: true }); const before = manager.status();
    const pending = before.slice(0, 8).map(server => manager.reconnect(server.name, server.revision, signal()).catch(error => error));
    await expect(manager.reconnect(before[8].name, before[8].revision, signal())).rejects.toMatchObject({ status: 429 });
    await until(async () => (await f.events()).filter(event => event.method === 'tools/list').length === 8);
    expect((await f.events()).some(event => event.label === '8')).toBe(false); await manager.close(); await Promise.all(pending);
  });
  it.each([
    { type: 'object', properties: { bad: 'string' } },
    { type: 'object', required: ['same', 'same'] },
    { type: 'object', properties: { bad: { type: 'unsupported' } } },
    { type: 'object', additionalProperties: 42 },
    { type: 'object', allOf: [] },
    { type: 'object', minProperties: -1 },
  ])('rejects malformed nested schema atomically (%j)', async inputSchema => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await f.set({ tools: [{ name: 'valid', inputSchema: { type: 'object' } }, { name: 'invalid', inputSchema }] });
    await expect(connect(manager)).rejects.toThrow(); expect(manager.status()[0]).toMatchObject({ status: 'error', tools: [] });
  });
  it('a list-change notification during discovery prevents any late catalog publication', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await f.set({ change: true, delay: 100 });
    await expect(connect(manager)).rejects.toThrow(); expect(manager.status()[0].status).not.toBe('connected'); expect(manager.capture(signal()).definitions).toEqual([]);
  });
  it('a list change during refresh leaves a disconnected state requiring reconnect, not a stale state with no client', async () => {
    const f = await fixture(), manager = managerFor({ test: f.config() }); await connect(manager); await f.set({ change: true, delay: 100 });
    await expect(manager.refresh('test', manager.status()[0].revision, signal())).rejects.toThrow();
    expect(manager.status()[0]).toMatchObject({ status: 'disconnected', tools: [] });
    await expect(manager.refresh('test', manager.status()[0].revision, signal())).rejects.toThrow('Explicit reconnect required');
    await f.set({}); const lease = await connect(manager); expect(lease.definitions).toHaveLength(7);
  });
  it('configuration replacement during discovery cannot publish either stale tools or a replacement connection', async () => {
    const f = await fixture(), config = { test: f.config() }, manager = managerFor(config); await f.set({ delay: 200 });
    const pending = manager.reconnect('test', manager.status()[0].revision, signal()), rejected = expect(pending).rejects.toThrow();
    await until(async () => (await f.events()).some(event => event.method === 'tools/list')); config.test = f.config('REPLACEMENT');
    expect(manager.status()[0]).toMatchObject({ status: 'disconnected', tools: [] }); await rejected;
    expect((await f.events()).some(event => event.label === 'REPLACEMENT')).toBe(false); expect(manager.capture(signal()).definitions).toEqual([]);
  });
  it('config key ordering does not invalidate scopes or state', async () => {
    const f = await fixture(); let config: Settings['mcpServers'] = { test: f.config() }; const manager = new McpManager(() => config); managers.push(manager); const lease = await connect(manager), revision = manager.configRevision();
    config = { test: { env: { TOKEN: 'fixture-secret' }, args: config.test.args, command: config.test.command } };
    expect(manager.configRevision()).toBe(revision); expect(() => lease.assertCurrent(named(lease))).not.toThrow();
  });
});
