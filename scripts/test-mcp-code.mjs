// Built-runtime smoke: real stdio MCP, HTTP provider stub, approvals, and the
// packaged TypeScript worker. No provider credentials or external services.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'litespeed-mcp-code-smoke-'));
const transcript = 'INTERMEDIATE_MCP_DOCUMENT '.repeat(20_000);
const requests = [], approved = [];
let child, serverLog = '', requestFailure;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const provider = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
    const body = JSON.parse(raw); requests.push(body);
    assert(body.tools.some(tool => tool.function.name === 'capability'));
    assert(!body.tools.some(tool => tool.function.name.startsWith('mcp_')));
    const results = body.messages.filter(message => message.role === 'tool');
    let args;
    if (!results.length) args = { operation: 'search', query: 'transcript' };
    else if (results.length === 1) {
      const { tools } = JSON.parse(results[0].content);
      const read = tools.find(tool => tool.name.includes('_read_transcript_')).name;
      const save = tools.find(tool => tool.name.includes('_save_transcript_')).name;
      args = { operation: 'execute', code: `const doc = await tools[${JSON.stringify(read)}]({}); const transcript: string = doc.structuredContent.transcript; const saved = await tools[${JSON.stringify(save)}]({transcript}); return saved.structuredContent;` };
    }
    const delta = args ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'capability', arguments: JSON.stringify(args) } }] } : { content: 'Transcript transferred.' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: args ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { requestFailure = error; res.writeHead(500); res.end('Fixture assertion failed'); }
});
try {
  await writeFile(join(directory, 'transcript.txt'), transcript);
  const fixture = join(directory, 'mcp.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.argv[2];
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); if(m.id === undefined) return;
  if(m.method === 'initialize') reply(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
  else if(m.method === 'tools/list') reply(m.id,{tools:[
    {name:'read_transcript',description:'Read a meeting transcript',inputSchema:{type:'object',properties:{}}},
    {name:'save_transcript',description:'Save a meeting transcript',inputSchema:{type:'object',properties:{transcript:{type:'string'}},required:['transcript']}}
  ]});
  else if(m.method === 'tools/call' && m.params.name === 'read_transcript') reply(m.id,{content:[],structuredContent:{transcript:readFileSync(root+'/transcript.txt','utf8')}});
  else if(m.method === 'tools/call' && m.params.name === 'save_transcript') { writeFileSync(root+'/saved.txt',m.params.arguments.transcript);reply(m.id,{content:[],structuredContent:{saved:true,bytes:Buffer.byteLength(m.params.arguments.transcript)}}); }
  else reply(m.id,{});
});`);
  const providerPort = await listen(provider);
  const reservation = createServer(); const port = await listen(reservation); await close(reservation);
  child = spawn(process.execPath, [join(root, 'dist/server/index.js')], { cwd: root, env: { ...process.env, LITESPEED_PORT: String(port), LITESPEED_DATA_DIR: join(directory, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { serverLog += chunk; }); child.stderr.on('data', chunk => { serverLog += chunk; });
  const api = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await res.json(); assert(res.ok, JSON.stringify(value)); return value;
  };
  let ready = false;
  for (let i = 0; i < 100; i++) { try { await api('/settings'); ready = true; break; } catch { if (child.exitCode !== null) break; await delay(50); } }
  assert(ready, `Built server failed to start: ${serverLog.slice(-2000)}`);
  await api('/settings', { workspace: directory, providers: [{ id: 'fixture', name: 'Fixture', kind: 'openai', baseUrl: `http://127.0.0.1:${providerPort}`, models: ['fixture'] }], defaultProvider: 'fixture', defaultModel: 'fixture', mcpServers: { documents: { command: process.execPath, args: [fixture, directory] } } }, 'PATCH');
  const snapshot = await api('/mcp'); assert.equal(snapshot.servers[0].status, 'disconnected');
  await api('/mcp/documents/reconnect', { expectedRevision: snapshot.servers[0].revision, expectedConfigRevision: snapshot.configRevision });
  const session = await api('/sessions', { workspace: directory, providerId: 'fixture', model: 'fixture', mode: 'build', permissionMode: 'ask' });
  await api(`/sessions/${session.id}/messages`, { content: 'Transfer the full meeting transcript with MCP code execution.' });
  let detail;
  for (let i = 0; i < 300; i++) {
    detail = await api(`/sessions/${session.id}`);
    for (const permission of detail.permissions) {
      approved.push(permission.tool); assert(permission.tool.startsWith('mcp_')); // Never approve the entire script.
      await api(`/sessions/${session.id}/permissions/${permission.id}`, { decision: 'allow' });
    }
    if (!['running', 'waiting'].includes(detail.session.status)) break;
    await delay(50);
  }
  if (requestFailure) throw requestFailure;
  assert.equal(detail.session.status, 'idle');
  assert.equal(await readFile(join(directory, 'saved.txt'), 'utf8'), transcript);
  assert.equal(requests.length, 3); assert.equal(approved.length, 2);
  assert(!JSON.stringify(requests).includes('INTERMEDIATE_MCP_DOCUMENT'));
  const call = detail.messages.flatMap(message => message.toolCalls ?? []).find(call => call.args.operation === 'execute');
  assert.equal(call.status, 'completed'); assert.deepEqual(call.mcpCalls.map(inner => inner.status), ['completed', 'completed']);
  assert(call.mcpCalls[0].resultBytes > 100_000);
  assert.deepEqual(JSON.parse(call.output), { saved: true, bytes: Buffer.byteLength(transcript) });
  console.log(`Built MCP workflow passed: search → TypeScript → 2 individually approved stdio calls; ${Buffer.byteLength(transcript)} intermediate bytes kept out of 3 model requests.`);
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await close(provider); await rm(directory, { recursive: true, force: true });
}
