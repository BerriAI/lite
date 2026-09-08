import { ChevronRight, Info } from 'lucide-react';
import type { ContextSnapshot } from '../../shared/types';
import type { PrefixChangeReason } from '../../shared/cache';

const tokenCount = (value: number) => Number.isFinite(value) && value >= 0 ? Math.ceil(value).toLocaleString() : null;
const prefixReasonLabels: Record<PrefixChangeReason, string> = { first_turn: 'First request of this process', system: 'System text changed', tools: 'Tool schemas changed', history_compacted: 'History compacted', history_edited: 'History edited (undo/redo)' };

/** A saved pre-request estimate, never a live budget for the composer. */
export function ContextIndicator({ context }: { context: ContextSnapshot }) {
  const input = tokenCount(context.estimatedInputTokens);
  const reserve = tokenCount(context.outputReserve);
  const knownWindow = context.limitSource !== 'unknown' && Number.isInteger(context.contextWindow) && context.contextWindow! >= 1024 && context.contextWindow! <= 10_000_000;
  const window = knownWindow ? context.contextWindow!.toLocaleString() : null;
  const source = !knownWindow ? 'Unknown' : context.limitSource === 'override' ? 'Provider setting · exact-model override' : 'Model catalog';
  const cache = context.cache;
  const cached = cache && typeof cache.cachedTokens === 'number' ? tokenCount(cache.cachedTokens) : null;
  const cachedOf = cache && typeof cache.inputTokens === 'number' && cache.inputTokens > 0 ? tokenCount(cache.inputTokens) : null;
  const hitPercent = cache && cached && cachedOf ? Math.round((cache.cachedTokens! / cache.inputTokens!) * 100) : null;
  const schemaTokens = cache ? tokenCount(cache.shape.toolSchemaTokens) : null;
  const prefix = !cache ? null : !cache.prefixChanged ? 'Stable since previous request' : cache.reasons.map(reason => prefixReasonLabels[reason] ?? reason).join(' · ') || 'Changed since previous request';
  return <details className="context-estimate" aria-label="Context estimate">
    <summary><Info size={12} /><span>Context estimate · {input ? `≈${input} input tokens` : 'input unavailable'}{!window && ' · limit unknown'}{context.uncertain && ' · uncertain'}{context.action === 'compact' && ' · compaction needed'}{hitPercent !== null && hitPercent >= 1 && ` · cache hit ${hitPercent}%`}</span><ChevronRight size={12} className="disclosure-chevron" /></summary>
    <div className="context-estimate-body">
      <p>Approximate pre-request snapshot for this response, not live remaining context or draft usage. Text token counts are heuristic estimates, not provider-reported usage.</p>
      <dl>
        <div><dt>Estimated input</dt><dd>{input ? `≈${input} tokens` : 'Unavailable'}</dd></div>
        <div><dt>Context window</dt><dd>{window ? `${window} tokens` : 'Unknown · no verified limit'}</dd></div>
        <div><dt>Output reserve</dt><dd>{reserve ? `${reserve} tokens` : 'Unavailable'}</dd></div>
        <div><dt>Limit source</dt><dd>{source}</dd></div>
        <div><dt>Model</dt><dd>{context.model}</dd></div>
        <div><dt>Provider</dt><dd>{context.providerId}</dd></div>
        {cache && <div><dt>Prompt cache</dt><dd>{cached && cachedOf ? `≈${cached} cached of ${cachedOf} input (${hitPercent}%)` : cached ? `≈${cached} cached` : 'Not reported by provider'}</dd></div>}
        {cache && <div><dt>Prefix</dt><dd>{prefix}</dd></div>}
        {cache && <div><dt>Tool schemas</dt><dd>{schemaTokens ? `≈${schemaTokens} tokens` : 'Unavailable'}</dd></div>}
      </dl>
      <p>The output reserve is separate from estimated input. It is a planning allowance, not a guarantee of output length.</p>
      {context.uncertain && <p className="context-estimate-warning">This estimate is uncertain: images, opaque provider data, or incomplete inputs may not be fully counted. Actual usage can differ substantially.</p>}
      {context.action === 'compact' && <p className="context-estimate-warning">Compaction was needed at this snapshot. This estimate does not confirm that compaction succeeded.</p>}
      {context.reason && <p className="context-estimate-reason">{context.reason}</p>}
    </div>
  </details>;
}
