/** Advisory snapshot taken before a provider request, never a live remaining-token
 * counter. Even uncertain=false uses a text heuristic, not a provider tokenizer. */
export interface ContextSnapshot {
  providerId: string;
  model: string;
  estimatedInputTokens: number;
  contextWindow?: number;
  /** Native Anthropic request cap; an advisory reservation for other adapters. */
  outputReserve: number;
  limitSource: 'override' | 'catalog' | 'unknown';
  /** Images, opaque replay state, unsupported data, or bounded estimation omitted input. */
  uncertain: boolean;
  action: 'continue' | 'compact';
  reason?: string;
}
