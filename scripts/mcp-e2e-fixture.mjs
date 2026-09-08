import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Local test protocol peer. Control and journal paths belong to each isolated test.
const [controlPath, journalPath, identity = 'original'] = process.argv.slice(2);
if (!controlPath || !journalPath) throw new Error('Control and journal paths are required.');
const record = value => appendFileSync(journalPath, JSON.stringify({ ...value, identity, pid: process.pid }) + '\n');
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const read = () => { try { return JSON.parse(readFileSync(controlPath, 'utf8')); } catch { return null; } };
let state = read() ?? { version: 1 }, initialized = false;
const pending = new Map();
record({ type: 'started' });
function answer(message, resumed = false) {
  const current = state;
  if (message.method === 'tools/list') {
    if (!resumed) record({ type: 'list', version: current.version });
    if (current.holdList) { pending.set(message.id, message); return; }
    if (current.failList) { send({ id: message.id, error: { code: -32603, message: 'Controlled catalog failure' } }); return; }
    send({ id: message.id, result: { tools: [{ name: current.toolName ?? 'echo', description: `Local ${identity} fixture, catalog ${current.version}.`, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (message.method === 'tools/call') {
    if (!resumed) record({ type: 'call', name: message.params?.name, text: message.params?.arguments?.text, version: current.version });
    if (current.holdCall) { pending.set(message.id, message); return; }
    send({ id: message.id, result: { content: [{ type: 'text', text: `${identity}: ${message.params?.arguments?.text ?? ''}` }] } });
  }
}
const interval = setInterval(() => {
  const next = read(); if (!next) return;
  const previous = state; state = next;
  if (next.exit && !previous.exit) { record({ type: 'exit' }); process.exit(0); }
  if (initialized && next.version !== previous.version) send({ method: 'notifications/tools/list_changed' });
  for (const [id, message] of pending) {
    if (message.method === 'tools/list' ? !next.holdList : !next.holdCall) { pending.delete(id); answer(message, true); }
  }
}, 100);
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'local-lifecycle-fixture', version: '1.0.0' } } });
  else if (message.method === 'notifications/initialized') initialized = true;
  else if (message.method === 'notifications/cancelled') { pending.delete(message.params?.requestId); record({ type: 'cancelled' }); }
  else if (message.method === 'ping') send({ id: message.id, result: {} });
  else if (message.method === 'tools/list' || message.method === 'tools/call') answer(message);
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
input.on('close', () => { clearInterval(interval); process.exit(0); });
