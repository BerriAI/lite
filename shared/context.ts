/** Advisory snapshot taken before a provider request, never a live remaining-token
 * counter. Even uncertain=false uses a text heuristic, not a provider tokenizer. */
export interface ContextSnapshot {
  providerId: string;
  model: string;
  estimatedInputTokens: number;
  contextWindow?: number;
  /** Native Anthropic request cap; an advisory reservation for other adapters. */
  outputReserve: number;
  limitSource: 'override' | 'catalog' | 'catalog-input' | 'unknown';
  /** Images, opaque replay state, unsupported data, or bounded estimation omitted input. */
  uncertain: boolean;
  action: 'continue' | 'compact';
  reason?: string;
  /** Observability only: whether the cacheable prefix (system text + tool
   * schemas) changed since this session's previous request, and why. */
  cache?: import('./cache.js').CacheDiagnostics;
  /** Advisory per-component split of the same heuristic estimate. */
  components?: { system: number; tools: number; history: number };
}
