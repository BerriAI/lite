import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { streamCompletion, type ProviderMessage } from '../../server/providers.js';
import type { Provider, ToolDefinition, Usage } from '../../shared/types.js';

const dbPath = process.env.LITESPEED_CACHE_PROBE_DB;
if (!dbPath) throw new Error('Set LITESPEED_CACHE_PROBE_DB to the settings database for the gateway to test.');
const db = new DatabaseSync(dbPath, { readOnly: true });
let gateway: Provider;
try { gateway = JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get()!.data as string).providers.find((item: Provider) => item.id === (process.env.LITESPEED_CACHE_PROBE_PROVIDER || 'litellm')); }
finally { db.close(); }
if (!gateway || gateway.kind !== 'openai') throw new Error('Choose a configured OpenAI-compatible gateway.');
const env = process.env.LITESPEED_CACHE_PROBE_ENV ? parseEnv(readFileSync(process.env.LITESPEED_CACHE_PROBE_ENV, 'utf8')) : {};
gateway.apiKey ||= env.LITELLM_API_KEY || process.env.LITELLM_API_KEY;
if (!gateway.apiKey) throw new Error('No configured gateway credential.');
const model = process.env.LITESPEED_CACHE_PROBE_MODEL || 'claude-haiku-4-5-20251001';
const transport = globalThis.fetch, rows: Record<string, unknown>[] = [];
let baseline = false;
globalThis.fetch = async (input, init) => {
  if (!init?.body || typeof init.body !== 'string') throw new Error('Probe expected a completion request.');
  const body = JSON.parse(init.body);
  // Reproduce the old adapter by removing only conversation markers, keeping system/tool caching.
  if (baseline) body.messages = body.messages.map((message: any) => message.role === 'system' ? message : JSON.parse(JSON.stringify(message, (key, value) => key === 'cache_control' ? undefined : value)));
  return transport(input, { ...init, body: JSON.stringify(body) });
};
const tool: ToolDefinition = { type: 'function', function: { name: 'read_fixture', description: 'Read the next synthetic fixture, returning supplied data.', parameters: { type: 'object', properties: { index: { type: 'integer' } }, required: ['index'] } } };
const fixture = (label: string) => `Synthetic cache experiment ${label}\n` + Array.from({ length: 700 }, (_, i) => `Record ${i}: the green train leaves platform seven at noon.\n`).join('');
try {
  for (const kind of ['openai', 'anthropic'] as const) for (const variant of ['baseline', 'fixed'] as const) {
    baseline = variant === 'baseline';
    const sessionId = `litespeed-cache-probe-${randomUUID()}`;
    const provider = { ...gateway, kind, anthropicCacheModels: [model] };
    const messages: ProviderMessage[] = [{ role: 'user', content: `${fixture(sessionId)}\nCall read_fixture with index 0. After each result, follow its next instruction.` }];
    for (let step = 0; step < 4; step++) {
      let text = '', tokens: Usage | undefined, metadata: Record<string, unknown> | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      const start = performance.now();
      for await (const chunk of streamCompletion({ provider, model, messages, tools: [tool], system: 'Follow the user instructions exactly. This is a synthetic tool-loop test. Use only read_fixture. Finish with OK when asked.', sessionId, signal: AbortSignal.timeout(600000) })) {
        if (chunk.type === 'text') text += chunk.text || '';
        if (chunk.usage) tokens = chunk.usage;
        if (chunk.metadata) metadata = chunk.metadata;
        if (chunk.tool) { const current = calls.get(chunk.tool.index) || { id: '', name: '', arguments: '' }; current.id ||= chunk.tool.id || ''; current.name ||= chunk.tool.name || ''; current.arguments += chunk.tool.arguments || ''; calls.set(chunk.tool.index, current); }
      }
      if (!tokens) throw new Error(`${kind}/${variant}: missing usage.`);
      const entries = [...calls.values()];
      if (step < 3 && (entries.length !== 1 || entries[0].name !== 'read_fixture' || JSON.parse(entries[0].arguments).index !== step)) throw new Error(`${kind}/${variant}: unexpected tool behavior at step ${step}.`);
      if (step === 3 && (entries.length || text.trim() !== 'OK')) throw new Error(`${kind}/${variant}: expected final OK.`);
      const row = { kind, variant, step, model, inputTokens: tokens.inputTokens, cachedTokens: tokens.cachedTokens || 0, outputTokens: tokens.outputTokens, durationMs: Math.round(performance.now() - start), correct: true };
      rows.push(row); console.log(JSON.stringify(row));
      messages.push({ role: 'assistant', content: text || null, ...(metadata ? { providerMetadata: metadata } : {}), ...(entries.length ? { tool_calls: entries.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) } : {}) });
      for (const call of entries) messages.push({ role: 'tool', tool_call_id: call.id, content: `Synthetic result ${step}: the train is on time. ${step < 2 ? `Now call read_fixture with index ${step + 1}.` : 'Now reply only OK. Do not call another tool.'}` });
    }
  }
  for (const kind of ['openai', 'anthropic']) {
    const fixed = rows.filter(row => row.kind === kind && row.variant === 'fixed' && Number(row.step) > 0);
    if (fixed.length !== 3 || fixed.some(row => Number(row.cachedTokens) < 4096)) throw new Error(`${kind}: growing history did not produce the expected cache hits.`);
  }
} finally {
  globalThis.fetch = transport;
  if (process.env.LITESPEED_CACHE_PROBE_OUTPUT) writeFileSync(process.env.LITESPEED_CACHE_PROBE_OUTPUT, JSON.stringify({ model, generatedAt: new Date().toISOString(), rows }, null, 2) + '\n');
}
