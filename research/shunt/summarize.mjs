import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./results/', import.meta.url);
const sets = ['', 'real-code/'];
const lines = ['# Shunt live experiment results', '', 'Two independent trials per variant, using Claude Haiku 4.5 as driver and Gemini 2.5 Flash as worker through the configured gateway. Temperature 0.2; eight-step research-loop bound; not production Litespeed UI E2E. Input/output are provider-reported totals across all calls, including repeated corpus sends. Costs are unknown. Warm worker caches may affect timings.', '', '| Case | Off/on factual passes | Mean driver input, off → on | Driver input reduction | Mean total input + output, off → on | Mean seconds, off → on |', '| --- | --- | --- | --- | --- | --- |'];
let count = 0, pass = 0, requests = 0;
const detailed = [];
for (const prefix of sets) {
  const url = new URL(`${prefix}live-eval.json`, root);
  const data = JSON.parse(readFileSync(url));
  const raw = readFileSync(new URL(`${prefix}live-requests.jsonl`, root), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  requests += raw.length;
  for (const record of data.records) {
    if (prefix) record.corpusReachedDriver = raw.filter(call => call.label === record.label && call.model === data.driver).some(call => call.messages.some(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('export interface CompletionOptions') && message.content.length > 20000));
    count++; if (record.quality) pass++;
    if (!record.quality) detailed.push(`- ${record.label}: failed (${record.error ?? 'factual/output check'}). No savings claim is made for this pair.`);
  }
  writeFileSync(url, JSON.stringify(data, null, 2) + '\n');
  for (const name of [...new Set(data.records.map(record => record.case))]) {
    const off = data.records.filter(record => record.case === name && !record.enabled);
    const on = data.records.filter(record => record.case === name && record.enabled);
    const mean = (records, get) => records.reduce((sum, record) => sum + get(record), 0) / records.length;
    const inputOff = mean(off, record => record.driver.inputTokens), inputOn = mean(on, record => record.driver.inputTokens);
    const allPass = [...off, ...on].every(record => record.quality);
    lines.push(`| ${name} | ${off.filter(record => record.quality).length}/${off.length} · ${on.filter(record => record.quality).length}/${on.length} | ${inputOff.toFixed(0)} → ${inputOn.toFixed(0)} | ${allPass ? (100 * (1 - inputOn / inputOff)).toFixed(1) + '%' : 'Not a valid quality-matched comparison'} | ${mean(off, record => record.total.inputTokens + record.total.outputTokens).toFixed(0)} → ${mean(on, record => record.total.inputTokens + record.total.outputTokens).toFixed(0)} | ${(mean(off, record => record.durationMs) / 1000).toFixed(2)} → ${(mean(on, record => record.durationMs) / 1000).toFixed(2)} |`);
  }
}
lines.push('', `${pass}/${count} final factual checks passed across ${requests} recorded requests (including the separate direct-writer request). These are not ${count} successful production E2E tests.`, '', ...detailed, '', 'The initial smoke run is excluded. Its JSON parser treated explanatory prose as a failed fact check, and identical prompts likely reused gateway responses. It also recorded the driver sometimes choosing ordinary write_file rather than code_write. The final nonce-bearing synthetic runs chose code_write; that does not establish reliable writer routing for all tasks.', '', 'The real-code multi-file reader resent both files for five separate questions in each on trial. The baseline attempted to write an answer to an unrequested path and was stopped by the harness. Thus that pair demonstrates failure modes, not a valid savings estimate. Reader input reduction can coexist with much higher total usage. One single-file on trial made a second reader request to verify a field that could have been checked with a targeted read.', '', 'Generated synthetic modules were loaded and checked against exact expected properties. The separate direct writer also passed. No claim is made about generated production tests, arbitrary edits, debugging, private Portal behavior, cold latency, or dollar savings.', '');
writeFileSync(new URL('summary.md', root), lines.join('\n'));
const suite = new URL('upstream-suite.txt', root);
writeFileSync(suite, readFileSync(suite, 'utf8').replace(/\x1b\[[0-9;]*m/g, ''));
console.log(lines.join('\n'));
