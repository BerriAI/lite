import { describe, expect, it } from 'vitest';
import type { TurnReceipts } from '../shared/receipts.js';
import { verificationNotice, verificationSummary, withoutVerificationNotice } from '../shared/verification.js';

const base: TurnReceipts = { filesChanged: [], commandsRun: [], checksRun: [], checksFailed: [], unresolvedChecks: [], filesChangedAfterLastCheck: [], unreadFilesChanged: [] };

describe('verification presentation', () => {
  it('distinguishes unconfirmed earlier command failures from currently failing tests', () => {
    const command = "python3 - <<'PY'\nprint('edit script')\nPY\nnpm test";
    const receipts = { ...base, checksRun: [command], checksFailed: [command], unresolvedChecks: [command] };
    expect(verificationSummary(receipts)).toEqual({ title: 'Checks need attention', description: '', attention: true });
    expect(verificationNotice(receipts)).not.toContain(command);
    expect(verificationNotice(receipts)).not.toContain('still failing');
    expect(receipts.unresolvedChecks).toEqual([command]);
  });
  it.each([1,3])('removes the old attempts wording from saved answers with %i unresolved checks', count => {
    const receipts={...base,unresolvedChecks:Array.from({length:count},(_,index)=>`npm run test:${index}`)};
    const previous=`Done.\n\nVerification needs review: ${count} earlier verification ${count===1?'attempt failed or timed out':'attempts failed or timed out'} without a recorded successful rerun.`;
    expect(withoutVerificationNotice(previous,receipts)).toBe('Done.');
    expect(verificationNotice(receipts)).toBe('\n\nChecks need attention');
  });
  it('keeps recovered failures out of the current warning and respects older receipt records', () => {
    const receipts = { ...base, filesChanged: ['a.ts'], checksRun: ['npm test', 'npm test'], checksFailed: ['npm test'] };
    expect(verificationSummary(receipts)?.attention).toBe(false);
    expect(verificationNotice(receipts)).toBeNull();
    expect(verificationSummary({ ...receipts, unresolvedChecks: undefined })?.attention).toBe(true);
  });
  it('removes an exact legacy command dump from display without losing the final answer', () => {
    const commands = ['npx vitest run | tail -18', 'npm test', "python3 - <<'PY'\nprint('edit')\nPY\nnpm run typecheck"];
    const receipts = { ...base, checksRun: commands, checksFailed: commands, unresolvedChecks: commands };
    const content = `Done.\n\n[Receipts: 3 check(s) still failing: ${commands.join(', ')}.]`;
    expect(withoutVerificationNotice(content, receipts)).toBe('Done.');
    expect(withoutVerificationNotice(content)).toBe(content);
    expect(withoutVerificationNotice(content + '\nMore explanation.', receipts)).toBe(content + '\nMore explanation.');
    expect(withoutVerificationNotice(content.replace('3 check(s)', '2 check(s)'), receipts)).toContain('2 check(s)');
  });
  it.each([
    [{ ...base, filesChanged: ['a.ts'] }, '\n\n[Receipts: 1 file(s) changed, no checks were run.]'],
    [{ ...base, filesChanged: ['a.ts'], checksRun: ['npm test'], filesChangedAfterLastCheck: ['a.ts'] }, '\n\n[Receipts: 1 file(s) changed, 1 changed after the last check.]'],
  ])('replaces both old and new host footers without duplicating the verification row', (receipts, legacy) => {
    expect(withoutVerificationNotice('Done.' + legacy, receipts)).toBe('Done.');
    expect(withoutVerificationNotice('Done.' + verificationNotice(receipts), receipts)).toBe('Done.');
    expect(withoutVerificationNotice('Ordinary text about receipts.', receipts)).toBe('Ordinary text about receipts.');
  });
});
