import type { TurnReceipts } from './receipts.js';

export function verificationSummary(receipts: TurnReceipts) {
  const unresolved = receipts.unresolvedChecks ?? receipts.checksFailed;
  if (unresolved.length) return { title: 'Verification needs review', description: `${unresolved.length} earlier verification ${unresolved.length === 1 ? 'attempt failed or timed out' : 'attempts failed or timed out'} without a recorded successful rerun.`, attention: true };
  if (!receipts.filesChanged.length) return null;
  if (!receipts.checksRun.length) return { title: 'Changes haven’t been checked', description: 'No verification commands were recorded after these changes.', attention: true };
  if (receipts.filesChangedAfterLastCheck.length) return { title: 'Changes need another check', description: 'Files were edited after the last verification command.', attention: true };
  return { title: 'Checks ran after changes', description: 'Recorded verification commands are shown below.', attention: false };
}

export function verificationNotice(receipts: TurnReceipts): string | null {
  const summary = verificationSummary(receipts);
  return summary?.attention ? `\n\n${summary.title}: ${summary.description}` : null;
}

/** Only replace the exact host-generated suffix; historical transcripts and
 * ordinary assistant text remain intact in storage and exports. */
export function withoutVerificationNotice(content: string, receipts?: TurnReceipts): string {
  if (!receipts) return content;
  const unresolved = receipts.unresolvedChecks;
  const legacy = unresolved?.length
    ? `\n\n[Receipts: ${unresolved.length} check(s) still failing: ${unresolved.join(', ')}.]`
    : receipts.filesChanged.length && (!receipts.checksRun.length || receipts.filesChangedAfterLastCheck.length)
      ? `\n\n[Receipts: ${receipts.filesChanged.length} file(s) changed${receipts.checksRun.length === 0 ? ', no checks were run' : `, ${receipts.filesChangedAfterLastCheck.length} changed after the last check`}.]`
      : null;
  for (const notice of [verificationNotice(receipts), legacy]) if (notice && content.endsWith(notice)) return content.slice(0, -notice.length);
  return content;
}
