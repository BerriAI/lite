import { DatabaseSync } from 'node:sqlite';
import { readFileSync, appendFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

// Research transport only. Credentials stay in memory; only synthetic payloads are logged.
export async function complete(model, messages, tools) {
  const db = new DatabaseSync(process.env.SHUNT_RESEARCH_SETTINGS_DB, { readOnly: true });
  let provider;
  try {
    const settings = JSON.parse(db.prepare('SELECT data FROM settings WHERE id=1').get().data);
    provider = settings.providers.find(item => item.id === (process.env.SHUNT_RESEARCH_PROVIDER ?? 'litellm'));
  } finally { db.close(); }
  if (!provider || provider.kind !== 'openai') throw new Error('Research needs an explicitly configured OpenAI-compatible gateway.');
  const env = process.env.SHUNT_RESEARCH_ENV_FILE ? parseEnv(readFileSync(process.env.SHUNT_RESEARCH_ENV_FILE, 'utf8')) : {};
  const key = provider.apiKey || env.LITELLM_API_KEY || process.env.LITELLM_API_KEY;
  if (!key) throw new Error('No configured gateway credential found.');
  const url = provider.baseUrl.replace(/\/$/, '') + (/\/v1\/?$/.test(provider.baseUrl) ? '' : '/v1') + '/chat/completions';
  const started = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 4096, ...(tools ? { tools, tool_choice: 'auto' } : {}) }),
    signal: AbortSignal.timeout(180_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Gateway returned HTTP ${response.status}; provider details omitted.`); }
  const body = await response.json();
  const choice = body.choices?.[0];
  if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error(`Incomplete model response (${choice?.finish_reason ?? 'missing choice'}).`);
  const record = { label: process.env.SHUNT_RESEARCH_LABEL, model, durationMs: Math.round(performance.now() - started),
    usage: body.usage ?? null, finishReason: choice.finish_reason, messages, output: choice.message };
  appendFileSync(process.env.SHUNT_RESEARCH_LOG, JSON.stringify(record) + '\n');
  return choice.message;
}

// Apache-2.0 mode prompts from Spotify's pinned Shunt README, not hidden Portal configuration.
export const READER = 'You are a precise code analyst. Read the provided files and answer the question concisely. Output structured bullets only. No greetings, no prose, no preambles, no summaries. Lead every bullet with the exact name, type, or line number. Use nested bullets for details. Skip anything the caller did not ask for.';
export const WRITER = "You generate code files based on a spec and reference files. Match the existing patterns, conventions, naming, and style exactly. Output only the code — no explanations, no markdown fences unless asked. If the spec is ambiguous, make reasonable choices that match the patterns in the reference code.";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const index = process.argv.indexOf('--input');
    if (index < 0) throw new Error('Missing action payload.');
    const input = JSON.parse(process.argv[index + 1]);
    if (!['bulk-reader', 'code-writer'].includes(input.mode_name)) throw new Error('Unsupported research mode.');
    const message = await complete(process.env.SHUNT_RESEARCH_WORKER, [
      { role: 'system', content: input.mode_name === 'bulk-reader' ? READER : WRITER },
      { role: 'user', content: input.message },
    ]);
    if (!message.content?.trim()) throw new Error('Worker returned no text.');
    console.log(JSON.stringify({ mode: { name: input.mode_name }, text: message.content }));
  } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
