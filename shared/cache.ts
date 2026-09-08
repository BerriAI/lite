// Cache diagnostics explain, per accepted turn, whether the provider-visible
// request prefix (system text + tool schemas) changed since the previous turn
// and why — so a prompt-cache miss is attributable instead of mysterious.
// They are observability only: no behavior depends on them.
export interface PrefixShape {
  /** sha256 (hex, 16 chars) of the system prompt text. */
  systemHash: string;
  /** sha256 of the canonically serialized, name-sorted tool schema list. */
  toolsHash: string;
  /** sha256 over both — one stable identity for the cacheable prefix. */
  prefixHash: string;
  /** Advisory size of the serialized tool schemas, UTF-8 bytes / 4. */
  toolSchemaTokens: number;
}

export type PrefixChangeReason = 'system' | 'tools' | 'first_turn' | 'history_compacted' | 'history_edited';

export interface CacheDiagnostics {
  shape: PrefixShape;
  prefixChanged: boolean;
  reasons: PrefixChangeReason[];
  /** Provider-reported cached input tokens for this request, when available. */
  cachedTokens?: number;
  inputTokens?: number;
}
