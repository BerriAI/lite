import { createHash } from 'node:crypto';
import type { ContextSnapshot, Model, Provider, ToolDefinition } from '../shared/types.js';
import type { ProviderMessage } from './providers.js';

export const BUDGET_LIMITS = {
  minContextWindow: 1024, maxContextWindow: 10_000_000,
  catalogTtlMs: 10 * 60_000, catalogProviders: 30, catalogModels: 2000,
  maxEstimateChars: 4 * 1024 * 1024, maxEstimateNodes: 100_000,
  proactiveRatio: 0.8, minSavingsTokens: 1024, minSavingsRatio: 0.1,
} as const;
export function validContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= BUDGET_LIMITS.minContextWindow && value <= BUDGET_LIMITS.maxContextWindow;
}
export interface BudgetRequest {
  provider: Provider;
  model: string;
  messages: readonly ProviderMessage[];
  system?: string;
  tools?: readonly ToolDefinition[];
}
export interface RequestEstimate { estimatedInputTokens: number; uncertain: boolean; }
export interface ContextBudget {
  contextWindow?: number;
  outputReserve: number;
  limitSource: ContextSnapshot['limitSource'];
}

/** The key is a digest only: never retain credentials in cache keys or snapshots. */
function providerIdentity(provider: Provider): string {
  return createHash('sha256').update(JSON.stringify({
    id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl,
    apiKey: provider.apiKey, models: provider.models,
    contextWindows: provider.contextWindows ? Object.entries(provider.contextWindows).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : undefined,
  })).digest('hex');
}
/** A bounded in-memory observation cache. Only successful explicit model discovery
 * populates it; get never fetches, falls back by model name, or refreshes its TTL. */
export class ModelCatalogCache {
  private entries = new Map<string, { identity: string; createdAt: number; windows: Map<string, number> }>();
  constructor(private now: () => number = () => Date.now()) {}
  remember(provider: Provider, models: readonly Model[]): void {
    const windows = new Map<string, number>();
    const seen = new Set<string>();
    for (const model of models.slice(0, BUDGET_LIMITS.catalogModels)) {
      if (model.providerId !== provider.id || typeof model.id !== 'string' || !model.id || model.id.length > 250) continue;
      // Conflicting duplicate catalog rows are not an authoritative limit.
      if (seen.has(model.id)) { windows.delete(model.id); continue; }
      seen.add(model.id);
      if (validContextWindow(model.contextWindow)) windows.set(model.id, model.contextWindow);
    }
    this.entries.delete(provider.id);
    this.entries.set(provider.id, { identity: providerIdentity(provider), createdAt: this.now(), windows });
    while (this.entries.size > BUDGET_LIMITS.catalogProviders) this.entries.delete(this.entries.keys().next().value!);
  }
  get(provider: Provider, model: string): number | undefined {
    const entry = this.entries.get(provider.id);
    if (!entry) return undefined;
    const age = this.now() - entry.createdAt;
    if (entry.identity !== providerIdentity(provider) || age < 0 || age >= BUDGET_LIMITS.catalogTtlMs) {
      this.entries.delete(provider.id); return undefined;
    }
    return entry.windows.get(model);
  }
  clear(providerId?: string): void { if (providerId === undefined) this.entries.clear(); else this.entries.delete(providerId); }
}
export const modelCatalog = new ModelCatalogCache();

export function resolveContextBudget(provider: Provider, model: string, cache = modelCatalog): ContextBudget {
  const override = provider.contextWindows && Object.hasOwn(provider.contextWindows, model) ? provider.contextWindows[model] : undefined;
  const catalog = validContextWindow(override) ? undefined : cache.get(provider, model);
  const contextWindow = validContextWindow(override) ? override : catalog;
  const limitSource = validContextWindow(override) ? 'override' : catalog !== undefined ? 'catalog' : 'unknown';
  // Anthropic currently sends max_tokens:8192. Other adapters have no enforced
  // output cap; this is only a bounded advisory reserve, never a request rejection.
  const outputReserve = provider.kind === 'anthropic' ? 8192 : contextWindow === undefined ? 4096 : Math.min(4096, Math.floor(contextWindow / 4));
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), outputReserve, limitSource };
}

/** Heuristic UTF-8 text bytes / 4 plus structural overhead. Reads only the actual
 * outbound message fields, not stored usage, duplicated UI tool output, or files.
 * Images and opaque provider state are unknown, NOT base64-length token charges. */
export function estimateRequest(request: Pick<BudgetRequest, 'messages' | 'system' | 'tools'> & Partial<Pick<BudgetRequest, 'provider' | 'model'>>): RequestEstimate {
  let bytes = 0, overhead = 16, chars = 0, nodes = 0, uncertain = false;
  const seen = new WeakSet<object>();
  const visit = () => {
    if (++nodes > BUDGET_LIMITS.maxEstimateNodes) { uncertain = true; return false; }
    return true;
  };
  const text = (value: unknown) => {
    if (typeof value !== 'string') { if (value !== undefined && value !== null) uncertain = true; return; }
    const remaining = BUDGET_LIMITS.maxEstimateChars - chars;
    if (value.length > remaining) uncertain = true;
    const bounded = value.slice(0, Math.max(0, remaining)); chars += bounded.length;
    // Also redact inline data URLs in ordinary text/tool arguments. The omission
    // is deliberate uncertainty; don't inspect or decode the payload.
    bytes += Buffer.byteLength(bounded.replace(/data:[^\s,"'<>]*,[^\s"'<>)]*/gi, () => { uncertain = true; return ''; }), 'utf8');
  };
  const structured = (value: unknown, depth = 0): void => {
    if (!visit()) return;
    if (typeof value === 'string') { text(value); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') { bytes += String(value).length; return; }
    if (typeof value !== 'object' || depth > 32 || seen.has(value)) { uncertain = true; return; }
    seen.add(value); bytes += 2;
    if (Array.isArray(value)) {
      for (const item of value) { if (nodes >= BUDGET_LIMITS.maxEstimateNodes) { uncertain = true; break; } structured(item, depth + 1); bytes++; }
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (nodes >= BUDGET_LIMITS.maxEstimateNodes) { uncertain = true; break; }
        text(key); bytes += 4; structured((value as Record<string, unknown>)[key], depth + 1);
      }
    }
    seen.delete(value); // Repeated schema references serialize again; only ancestor cycles are unknown.
  };
  const thinking = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!visit()) break;
      if (block?.type === 'thinking') text(block.thinking);
      // Signatures, redacted blocks, encrypted reasoning and unfamiliar shapes
      // do not have a reliable text-token interpretation.
      uncertain = true;
    }
  };
  const responseItems = (items: any[]) => {
    for (const item of items) {
      if (!visit()) break;
      if (item?.type === 'message') {
        if (!Array.isArray(item.content)) { uncertain = true; continue; }
        for (const part of item.content) {
          if (!visit()) break;
          if (part?.type === 'output_text' || part?.type === 'input_text') text(part.text);
          else if (part?.type === 'refusal') text(part.refusal);
          else uncertain = true;
        }
      } else if (item?.type === 'function_call') {
        overhead += 8; text(item.call_id); text(item.name); text(item.arguments);
      } else if (item?.type === 'reasoning') {
        uncertain = true; // Never charge encrypted payload length as plaintext.
        if (Array.isArray(item.summary)) for (const part of item.summary) {
          if (!visit()) break;
          if (part?.type === 'summary_text') text(part.text);
        }
      }
      // Other item types are discarded by the adapter too.
    }
  };
  text(request.system);
  for (const message of request.messages) {
    if (!visit()) break;
    overhead += 8;
    const metadata = message.providerMetadata;
    if (metadata && Object.keys(metadata).length) {
      if (!request.provider || request.model === undefined) uncertain = true;
      else if (message.role === 'assistant' && metadata.providerId === request.provider.id && metadata.model === request.model) {
        if (request.provider.kind === 'codex' && Array.isArray(metadata.responseItems) && metadata.responseItems.length) {
          responseItems(metadata.responseItems);
          continue; // Scoped response items replace fallback content and calls.
        } else if (request.provider.kind === 'anthropic') thinking(metadata.anthropicThinking);
        else if (request.provider.kind === 'openai') {
          text(metadata.reasoning_content);
          thinking(metadata.thinking_blocks);
          if (Array.isArray(metadata.reasoning_items)) responseItems(metadata.reasoning_items);
        }
      }
    }
    if (typeof message.content === 'string') text(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!visit()) break;
        if (part && part.type === 'text') text(part.text);
        else uncertain = true;
      }
    } else if (message.content !== null && message.content !== undefined) uncertain = true;
    text(message.tool_call_id);
    for (const call of message.tool_calls ?? []) {
      if (!visit()) break;
      overhead += 8; text(call.id); text(call.function?.name); text(call.function?.arguments);
    }
  }
  for (const tool of request.tools ?? []) {
    if (!visit()) break;
    overhead += 16; text(tool.function.name); text(tool.function.description); structured(tool.function.parameters);
  }
  return { estimatedInputTokens: Math.ceil(bytes / 4) + overhead, uncertain };
}

export function hasMeaningfulSavings(beforeEstimate: number, afterEstimate: number): boolean {
  return Number.isFinite(beforeEstimate) && Number.isFinite(afterEstimate) && afterEstimate >= 0 &&
    beforeEstimate - afterEstimate >= BUDGET_LIMITS.minSavingsTokens && beforeEstimate - afterEstimate >= beforeEstimate * BUDGET_LIMITS.minSavingsRatio;
}
export function compactionLimits(provider: Provider, model: string, cache = modelCatalog): { maxSourceChars: number; maxSummaryChars: number } | undefined {
  const { contextWindow, outputReserve } = resolveContextBudget(provider, model, cache);
  if (contextWindow === undefined) return { maxSourceChars: 48_000, maxSummaryChars: 24_000 };
  const remaining = contextWindow - outputReserve;
  // Heuristic source allowance reserves space for summary instructions and output.
  // These remain character ceilings, not a promise that a provider will accept it.
  const maxSourceChars = Math.min(48_000, Math.floor(remaining * 0.7) * 4 - 2048);
  const maxSummaryChars = Math.min(24_000, Math.floor(Math.min(outputReserve, remaining * 0.2)) * 4);
  if (maxSourceChars < 512 || maxSummaryChars < 512) return undefined;
  return { maxSourceChars, maxSummaryChars };
}

/** retainedMessages must come from planCompaction's safe latest-turn boundary and
 * the same provider-message mapping as request.messages. This helper never cuts,
 * mutates, fetches, rejects a prompt, or authorizes another compaction attempt. */
export function assessContext(request: BudgetRequest, options: { retainedMessages?: readonly ProviderMessage[]; autoCompactionAttempted?: boolean } = {}, cache = modelCatalog): ContextSnapshot {
  const estimate = estimateRequest(request), budget = resolveContextBudget(request.provider, request.model, cache);
  // The component split reuses the same bounded heuristic per part; it is a
  // readability aid for the /context view, never a second budgeting authority.
  const system = estimateRequest({ messages: [], system: request.system }).estimatedInputTokens;
  const tools = estimateRequest({ messages: [], tools: request.tools }).estimatedInputTokens;
  const snapshot: ContextSnapshot = { providerId: request.provider.id, model: request.model, ...estimate, ...budget, action: 'continue',
    components: { system, tools, history: Math.max(0, estimate.estimatedInputTokens - system - tools) } };
  const continuation = (reason: string) => ({ ...snapshot, reason });
  if (budget.contextWindow === undefined) return continuation('Context window is unknown. This text estimate is advisory; the provider decides whether the request fits.');
  const limits = compactionLimits(request.provider, request.model, cache);
  if (!limits) return continuation('The configured context window leaves too little room for safe automatic summarization. The request is not blocked.');
  const threshold = Math.floor((budget.contextWindow - budget.outputReserve) * BUDGET_LIMITS.proactiveRatio);
  if (estimate.estimatedInputTokens < threshold) return estimate.uncertain ? continuation('Text-only estimate excludes images or opaque provider state; actual input usage may differ.') : snapshot;
  if (options.autoCompactionAttempted) return continuation('Automatic compaction was already attempted this turn. No further estimate-triggered request will be made.');
  if (estimate.uncertain) return continuation('Input includes images, opaque state, or unestimated data. Automatic compaction is skipped; the provider can still accept the request.');
  if (!options.retainedMessages?.length) return continuation('No safe older prefix is available to compact. The latest turn is preserved and the request is not blocked.');
  const retained = estimateRequest({ ...request, messages: options.retainedMessages });
  const after = retained.estimatedInputTokens + Math.ceil(limits.maxSummaryChars / 4) + 128;
  if (retained.uncertain || after > threshold) return continuation('The latest turn, instructions, tools, and summary allowance may still exceed the advisory budget. Shorten large inputs or choose a larger-context model; nothing is trimmed.');
  if (!hasMeaningfulSavings(estimate.estimatedInputTokens, after)) return continuation('Compacting the safe older prefix would not provide meaningful estimated savings. The request is unchanged.');
  return { ...snapshot, action: 'compact', reason: 'Estimated input is near the context budget. Summarize a safe older prefix once while keeping the latest turn intact.' };
}
