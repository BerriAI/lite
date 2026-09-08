import { describe, expect, it, vi } from 'vitest';
import { assessContext, BUDGET_LIMITS, compactionLimits, estimateRequest, hasMeaningfulSavings, ModelCatalogCache, resolveContextBudget, validContextWindow } from '../server/budget.js';
import { planCompaction } from '../server/context.js';
import type { BudgetRequest } from '../server/budget.js';
import type { ProviderMessage } from '../server/providers.js';
import type { Message, Provider, ToolDefinition } from '../shared/types.js';

const provider: Provider = { id: 'test', name: 'Test', kind: 'openai', baseUrl: 'https://gateway.example/v1' };
const withWindow = (size: number): Provider => ({ ...provider, contextWindows: { model: size } });
const text = (content: string): ProviderMessage => ({ role: 'user', content });
const request = (messages: ProviderMessage[], configured = withWindow(32_768)): BudgetRequest => ({ provider: configured, model: 'model', messages });
const tool: ToolDefinition = { type: 'function', function: { name: 'example', description: 'Use the tool.', parameters: { type: 'object', properties: { input: { type: 'string' } } } } };

describe('scoped context window limits', () => {
  it.each([1024, 8192, 10_000_000])('accepts bounded integer window %i', value => { expect(validContextWindow(value)).toBe(true); });
  it.each([undefined, null, '32768', 0, -1, 1023, 10_000_001, 2048.5, NaN, Infinity])('rejects invalid window %s', value => { expect(validContextWindow(value)).toBe(false); });
  it('resolves explicit exact-model overrides before scoped catalog and otherwise remains unknown', () => {
    const cache = new ModelCatalogCache();
    const configured = { ...provider, contextWindows: { model: 48_000 } };
    cache.remember(configured, [{ id: 'model', name: 'Model', providerId: provider.id, contextWindow: 32_000 }]);
    expect(resolveContextBudget(configured, 'model', cache)).toEqual({ contextWindow: 48_000, outputReserve: 4096, limitSource: 'override' });
    cache.remember(provider, [{ id: 'model', name: 'Model', providerId: provider.id, contextWindow: 32_000 }]);
    expect(resolveContextBudget(provider, 'model', cache)).toEqual({ contextWindow: 32_000, outputReserve: 4096, limitSource: 'catalog' });
    expect(resolveContextBudget(provider, 'model-alias', cache)).toEqual({ outputReserve: 4096, limitSource: 'unknown' });
    expect(resolveContextBudget({ ...provider, id: 'another' }, 'model', cache).limitSource).toBe('unknown');
    const inherited = Object.create({ model: 99_000 });
    expect(resolveContextBudget({ ...provider, contextWindows: inherited }, 'model', new ModelCatalogCache()).limitSource).toBe('unknown');
  });
  it.each([
    { name: 'Renamed' }, { kind: 'codex' as const }, { baseUrl: 'https://other.example/v1' }, { apiKey: 'synthetic-changed' }, { models: ['model'] }, { contextWindows: { other: 32_000 } },
  ])('invalidates catalog on exact provider configuration change %j', patch => {
    const cache = new ModelCatalogCache();
    cache.remember(provider, [{ id: 'model', name: 'Model', providerId: provider.id, contextWindow: 32_000 }]);
    expect(cache.get({ ...provider, ...patch }, 'model')).toBeUndefined();
    expect(cache.get(provider, 'model')).toBeUndefined();
  });
  it('expires at ten minutes without sliding renewal and rejects backward clocks', () => {
    let now = 1000; const cache = new ModelCatalogCache(() => now);
    const models = [{ id: 'model', name: 'Model', providerId: provider.id, contextWindow: 32_000 }];
    cache.remember(provider, models); now += BUDGET_LIMITS.catalogTtlMs - 1;
    expect(cache.get(provider, 'model')).toBe(32_000); now++;
    expect(cache.get(provider, 'model')).toBeUndefined();
    cache.remember(provider, models); now--;
    expect(cache.get(provider, 'model')).toBeUndefined();
  });
  it('discards invalid, duplicate and cross-provider catalog metadata and bounds retained entries', () => {
    const cache = new ModelCatalogCache();
    cache.remember(provider, [
      { id: 'model', name: 'One', providerId: provider.id, contextWindow: 32_000 },
      { id: 'model', name: 'Two', providerId: provider.id, contextWindow: 64_000 },
      { id: 'foreign', name: 'Foreign', providerId: 'other', contextWindow: 32_000 },
      { id: 'invalid', name: 'Invalid', providerId: provider.id, contextWindow: -1 },
    ]);
    for (const id of ['model', 'foreign', 'invalid']) expect(cache.get(provider, id)).toBeUndefined();
    for (let index = 0; index < BUDGET_LIMITS.catalogProviders + 1; index++) {
      const current = { ...provider, id: String(index) };
      cache.remember(current, [{ id: 'model', name: 'Model', providerId: current.id, contextWindow: 32_000 }]);
    }
    expect(cache.get({ ...provider, id: '0' }, 'model')).toBeUndefined();
    expect(cache.get({ ...provider, id: String(BUDGET_LIMITS.catalogProviders) }, 'model')).toBe(32_000);
    cache.clear(String(BUDGET_LIMITS.catalogProviders));
    expect(cache.get({ ...provider, id: String(BUDGET_LIMITS.catalogProviders) }, 'model')).toBeUndefined();
    cache.clear(); expect(cache.get({ ...provider, id: '1' }, 'model')).toBeUndefined();
  });
});

describe('honest outbound request estimates', () => {
  it('counts UTF-8 text, instructions and tool schemas deterministically', () => {
    expect(estimateRequest({ messages: [text('1234')] })).toEqual({ estimatedInputTokens: 25, uncertain: false });
    expect(estimateRequest({ messages: [text('😀')] })).toEqual({ estimatedInputTokens: 25, uncertain: false });
    const first = estimateRequest({ messages: [text('1234')], system: '1234', tools: [tool] });
    expect(first.estimatedInputTokens).toBeGreaterThan(26);
    expect(first).toEqual(estimateRequest({ messages: [text('1234')], system: '1234', tools: [tool] }));
    expect(first.uncertain).toBe(false);
  });
  it('counts tool argument/result fields but ignores duplicate display output and historic usage', () => {
    const messages: ProviderMessage[] = [{ role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, { role: 'tool', content: 'actual output', tool_call_id: 'call' }];
    const baseline = estimateRequest({ messages });
    const decorated = messages.map(message => ({ ...message, usage: { inputTokens: 10_000_000 }, toolCalls: [{ output: 'x'.repeat(100_000) }], reasoning: 'y'.repeat(10_000) }));
    expect(estimateRequest({ messages: decorated })).toEqual(baseline);
    expect(baseline.estimatedInputTokens).toBeGreaterThan(estimateRequest({ messages: [] }).estimatedInputTokens);
  });
  it('never counts image base64 length or opaque replay metadata as text tokens', () => {
    const image = (length: number): ProviderMessage => ({ role: 'user', content: [{ type: 'text', text: 'Explain' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(length) } }] });
    expect(estimateRequest({ messages: [image(8)] })).toEqual(estimateRequest({ messages: [image(500_000)] }));
    const plain = estimateRequest({ messages: [text('Explain')] });
    const opaque = estimateRequest({ messages: [{ ...text('Explain'), providerMetadata: { encrypted: 'x'.repeat(500_000) } }] });
    expect(opaque.estimatedInputTokens).toBe(plain.estimatedInputTokens); expect(opaque.uncertain).toBe(true);
    const inline = estimateRequest({ messages: [text('data:image/png;base64,' + 'A'.repeat(100_000))] });
    expect(inline).toEqual({ estimatedInputTokens: 24, uncertain: true });
  });
  it('counts repeated schema references like their serialized copies without claiming a cycle', () => {
    const shared = { type: 'string' };
    const tools = [{ ...tool, function: { ...tool.function, parameters: { type: 'object', properties: { a: shared, b: shared } } } }];
    expect(estimateRequest({ messages: [], tools }).uncertain).toBe(false);
    expect(estimateRequest({ messages: [], tools })).toEqual(estimateRequest({ messages: [], tools: JSON.parse(JSON.stringify(tools)) }));
  });
  it('ignores stale or irrelevant metadata and projects scoped replayed plaintext once', () => {
    const base: ProviderMessage = { role: 'assistant', content: 'fallback' };
    const old = { ...base, providerMetadata: { providerId: provider.id, model: 'old-model', thinking_blocks: [{ type: 'redacted_thinking', data: 'opaque' }] } };
    expect(estimateRequest(request([old]))).toEqual(estimateRequest(request([base])));
    const irrelevant = { ...base, providerMetadata: { providerId: provider.id, model: 'model', unrelated: 'opaque' } };
    expect(estimateRequest(request([irrelevant]))).toEqual(estimateRequest(request([base])));
    const scoped = { ...base, providerMetadata: { providerId: provider.id, model: 'model', reasoning_content: 'reasoning text' } };
    expect(estimateRequest(request([scoped])).estimatedInputTokens).toBeGreaterThan(estimateRequest(request([base])).estimatedInputTokens);
    const codex = { ...provider, kind: 'codex' as const };
    const replayed = { ...base, content: 'ignored fallback'.repeat(10_000), providerMetadata: { providerId: provider.id, model: 'model', responseItems: [{ type: 'message', content: [{ type: 'output_text', text: 'actual replay' }] }] } };
    const actual = estimateRequest(request([replayed], codex));
    expect(actual).toEqual(estimateRequest(request([{ ...base, content: 'actual replay' }], codex)));
    expect(actual.uncertain).toBe(false);
    const opaque = (length: number) => ({ ...base, providerMetadata: { providerId: provider.id, model: 'model', responseItems: [{ type: 'reasoning', encrypted_content: 'x'.repeat(length), summary: [{ type: 'summary_text', text: 'known summary' }] }] } });
    expect(estimateRequest(request([opaque(10)], codex))).toEqual(estimateRequest(request([opaque(100_000)], codex)));
    expect(estimateRequest(request([opaque(10)], codex)).uncertain).toBe(true);
    const native = { ...provider, kind: 'anthropic' as const };
    const signed = { ...base, providerMetadata: { providerId: provider.id, model: 'model', anthropicThinking: [{ type: 'thinking', thinking: 'known text', signature: 'opaque' }] } };
    expect(estimateRequest(request([signed], native)).uncertain).toBe(true);
  });
  it('bounds enormous or cyclic schema/input work and flags incomplete estimates', () => {
    const parameters: any = { type: 'object' }; parameters.circular = parameters;
    expect(estimateRequest({ messages: [], tools: [{ ...tool, function: { ...tool.function, parameters } }] }).uncertain).toBe(true);
    const huge = estimateRequest({ messages: [text('x'.repeat(BUDGET_LIMITS.maxEstimateChars + 1))] });
    expect(huge.uncertain).toBe(true);
    expect(huge.estimatedInputTokens).toBe(BUDGET_LIMITS.maxEstimateChars / 4 + 24);
    expect(estimateRequest({ messages: [{ role: 'user', content: [{ type: 'unknown', payload: 'ignored' }] }] }).uncertain).toBe(true);
  });
});

describe('advisory proactive compaction decisions', () => {
  it('uses actual native output reserve and bounded advisory reserve for other adapters', () => {
    expect(resolveContextBudget({ ...withWindow(1024), kind: 'anthropic' }, 'model').outputReserve).toBe(8192);
    expect(resolveContextBudget(withWindow(1024), 'model').outputReserve).toBe(256);
    expect(compactionLimits({ ...withWindow(1024), kind: 'anthropic' }, 'model')).toBeUndefined();
    expect(compactionLimits(provider, 'unknown')).toEqual({ maxSourceChars: 48_000, maxSummaryChars: 24_000 });
    expect(compactionLimits(withWindow(32_768), 'model')).toEqual({ maxSourceChars: 48_000, maxSummaryChars: 16_384 });
  });
  it.each([[10_240, 9216, true], [10_240, 9217, false], [20_000, 18_001, false], [20_000, 18_000, true], [1000, 0, false], [Infinity, 0, false], [10_000, -1, false]])('requires absolute AND proportional savings (%i→%i)', (before, after, expected) => {
    expect(hasMeaningfulSavings(before as number, after as number)).toBe(expected);
  });
  it('triggers at the exact eighty-percent threshold with a meaningful safe older prefix', () => {
    const configured = withWindow(32_768), threshold = Math.floor((32_768 - 4096) * 0.8);
    const retained = [text('latest')];
    const input = request([text('x'.repeat((threshold - 24) * 4))], configured);
    expect(estimateRequest(input).estimatedInputTokens).toBe(threshold);
    expect(assessContext(input, { retainedMessages: retained }).action).toBe('compact');
    expect(assessContext(request([text('x'.repeat((threshold - 25) * 4))]), { retainedMessages: retained }).action).toBe('continue');
    expect(assessContext(input, { retainedMessages: retained, autoCompactionAttempted: true }).action).toBe('continue');
  });
  it('unknown limits, huge latest turns, system/tool overhead and uncertain inputs never block or loop', () => {
    const huge = text('x'.repeat(150_000));
    expect(assessContext(request([huge], provider)).limitSource).toBe('unknown');
    expect(assessContext(request([huge])).action).toBe('continue');
    expect(assessContext(request([huge]), { retainedMessages: [huge] }).reason).toContain('latest turn');
    expect(assessContext({ ...request([huge]), system: 's'.repeat(150_000) }, { retainedMessages: [text('latest')] }).action).toBe('continue');
    const opaque = { ...huge, role: 'assistant' as const, providerMetadata: { providerId: provider.id, model: 'model', thinking_blocks: [{ type: 'redacted_thinking', data: 'unknown' }] } };
    expect(assessContext(request([opaque]), { retainedMessages: [text('latest')] })).toMatchObject({ uncertain: true, action: 'continue' });
    expect(assessContext(request([huge], { ...withWindow(1024), kind: 'anthropic' })).reason).toContain('not blocked');
  });
  it('preserves deterministic latest-turn tool groups and performs no network or mutation', () => {
    const messages: Message[] = [
      { id: 'old', sessionId: 's', role: 'user', content: 'x'.repeat(150_000), createdAt: 1 },
      { id: 'new', sessionId: 's', role: 'user', content: 'latest', createdAt: 2 },
      { id: 'call', sessionId: 's', role: 'assistant', content: '', createdAt: 3, toolCalls: [{ id: 't', name: 'read_file', args: {}, status: 'completed' }] },
      { id: 'result', sessionId: 's', role: 'tool', content: 'result', toolCallId: 't', createdAt: 4 },
    ];
    const before = JSON.stringify(messages), plan = planCompaction(messages);
    expect(plan.retained.map(message => message.id)).toEqual(['new', 'call', 'result']);
    const map = (input: Message[]): ProviderMessage[] => input.map(message => ({ role: message.role, content: message.content, tool_call_id: message.toolCallId,
      tool_calls: message.toolCalls?.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Budgeting must never fetch'));
    try {
      const snapshot = assessContext(request(map(messages)), { retainedMessages: map(plan.retained) });
      expect(snapshot.action).toBe('compact'); expect(snapshot.providerId).toBe(provider.id); expect(snapshot.model).toBe('model');
      expect(assessContext(request(map(messages)), { retainedMessages: map(plan.retained) })).toEqual(snapshot);
      expect(network).not.toHaveBeenCalled(); expect(JSON.stringify(messages)).toBe(before);
    } finally { network.mockRestore(); }
  });
});
