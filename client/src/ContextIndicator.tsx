import { ChevronRight, Info } from 'lucide-react';
import type { ContextSnapshot } from '../../shared/types';

const tokenCount = (value: number) => Number.isFinite(value) && value >= 0 ? Math.ceil(value).toLocaleString() : null;

/** A saved pre-request estimate, never a live budget for the composer. */
export function ContextIndicator({ context }: { context: ContextSnapshot }) {
  const input = tokenCount(context.estimatedInputTokens);
  const reserve = tokenCount(context.outputReserve);
  const knownWindow = context.limitSource !== 'unknown' && Number.isInteger(context.contextWindow) && context.contextWindow! >= 1024 && context.contextWindow! <= 10_000_000;
  const window = knownWindow ? context.contextWindow!.toLocaleString() : null;
  const source = !knownWindow ? 'Unknown' : context.limitSource === 'override' ? 'Provider setting · exact-model override' : 'Model catalog';
  return <details className="context-estimate" aria-label="Context estimate">
    <summary><Info size={12} /><span>Context estimate · {input ? `≈${input} input tokens` : 'input unavailable'}{!window && ' · limit unknown'}{context.uncertain && ' · uncertain'}{context.action === 'compact' && ' · compaction needed'}</span><ChevronRight size={12} className="disclosure-chevron" /></summary>
    <div className="context-estimate-body">
      <p>Approximate pre-request snapshot for this response, not live remaining context or draft usage. Text token counts are heuristic estimates, not provider-reported usage.</p>
      <dl>
        <div><dt>Estimated input</dt><dd>{input ? `≈${input} tokens` : 'Unavailable'}</dd></div>
        <div><dt>Context window</dt><dd>{window ? `${window} tokens` : 'Unknown · no verified limit'}</dd></div>
        <div><dt>Output reserve</dt><dd>{reserve ? `${reserve} tokens` : 'Unavailable'}</dd></div>
        <div><dt>Limit source</dt><dd>{source}</dd></div>
        <div><dt>Model</dt><dd>{context.model}</dd></div>
        <div><dt>Provider</dt><dd>{context.providerId}</dd></div>
      </dl>
      <p>The output reserve is separate from estimated input. It is a planning allowance, not a guarantee of output length.</p>
      {context.uncertain && <p className="context-estimate-warning">This estimate is uncertain: images, opaque provider data, or incomplete inputs may not be fully counted. Actual usage can differ substantially.</p>}
      {context.action === 'compact' && <p className="context-estimate-warning">Compaction was needed at this snapshot. This estimate does not confirm that compaction succeeded.</p>}
      {context.reason && <p className="context-estimate-reason">{context.reason}</p>}
    </div>
  </details>;
}
