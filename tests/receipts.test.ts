import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeReceipts, receiptsNotice } from '../server/receipts.js';
import { checkFailed, isCheckCommand } from '../shared/receipts.js';
import type { Message, ToolCall } from '../shared/types.js';

// Minimal transcript builders: each assistant message carries one batch of
// finalized tool calls, exactly as the runner persists them.
type Spec = { name: string; args: Record<string, unknown>; status?: ToolCall['status']; output?: string };
const batch = (sessionId: string, specs: Spec[]): Message => ({
  id: randomUUID(), sessionId, role: 'assistant', content: '', createdAt: Date.now(),
  toolCalls: specs.map(spec => ({ id: randomUUID(), name: spec.name, args: spec.args, status: spec.status ?? 'completed', output: spec.output ?? '' })),
});
const user = (sessionId: string, id: string = randomUUID()): Message => ({ id, sessionId, role: 'user', content: 'Task', createdAt: Date.now() });
const read = (path: string): Spec => ({ name: 'read_file', args: { path } });
const write = (path: string): Spec => ({ name: 'write_file', args: { path, content: 'x' } });
const bash = (command: string, output: string, extra: Partial<Spec> = {}): Spec => ({ name: 'bash', args: { command }, output, ...extra });

describe('check heuristic', () => {
  it.each([
    ['npm test', true], ['npm test --help', true], ['cd /tmp && npm test', true],
    ['npm run typecheck', true], ['npm run lint', true], ['npm run check', true],
    ['npx vitest run tests/x.test.ts', true], ['npx tsc --noEmit', true],
    ['pytest -q', true], ['cargo test', true], ['cargo check', true], ['go test ./...', true],
    ['make test', true], ['make check', true],
    ['echo test', false], ['echo "npm test"', false], // Quote before npm is not a shell separator.
    ['pytest-cov', false], ['npm run checkstyle', false], ['npm testx', false], ['gotest', false],
  ])('classifies %j as check=%s', (command, expected) => expect(isCheckCommand(command)).toBe(expected));
  it('detects failure only from a trailing nonzero Exit code or timeout', () => {
    expect(checkFailed('output\nExit code: 1')).toBe(true);
    expect(checkFailed('output\nExit code: 0')).toBe(false);
    expect(checkFailed('Exit code: 1 was mentioned mid-output\nExit code: 0')).toBe(false);
    expect(checkFailed('output\nCommand timed out.')).toBe(true);
    expect(checkFailed('no status line at all')).toBe(false);
  });
});

describe('computeReceipts', () => {
  const sessionId = 's1';
  it('accounts a mixed turn exactly across all six fields', () => {
    const accepted = user(sessionId, 'turn-1');
    const messages: Message[] = [
      user(sessionId), // Earlier turn: everything before the accepted id is ignored.
      accepted,
      batch(sessionId, [read('a.ts')]),
      batch(sessionId, [write('a.ts'), write('b.ts')]), // b.ts written unread.
      batch(sessionId, [bash('npm test', 'FAIL\nExit code: 1')]),
      batch(sessionId, [bash('npm test', 'PASS\nExit code: 0')]),
      batch(sessionId, [write('a.ts')]), // Edited AFTER the last passing check.
    ];
    expect(computeReceipts(messages, accepted.id)).toEqual({
      filesChanged: ['a.ts', 'b.ts'],
      commandsRun: ['npm test', 'npm test'],
      checksRun: ['npm test', 'npm test'],
      checksFailed: ['npm test'], unresolvedChecks: [],
      filesChangedAfterLastCheck: ['a.ts'],
      unreadFilesChanged: ['b.ts'],
    });
  });
  it('returns all-empty receipts for a no-mutation turn', () => {
    const accepted = user(sessionId);
    const messages = [accepted, batch(sessionId, [read('a.ts'), { name: 'grep', args: { pattern: 'x' } }])];
    expect(computeReceipts(messages, accepted.id)).toEqual({ filesChanged: [], commandsRun: [], checksRun: [], checksFailed: [], unresolvedChecks: [], filesChangedAfterLastCheck: [], unreadFilesChanged: [] });
  });
  it('resolves a timed-out check when its successful retry only changes tail output length', () => {
    const accepted = user(sessionId);
    const failed = 'cd /project && npx vitest run 2>&1 | tail -18';
    const retry = 'cd /project && npx vitest run 2>&1 | tail -20';
    const receipts = computeReceipts([accepted, batch(sessionId, [bash(failed, 'Command timed out.'), bash(retry, '1814 passed\nExit code: 0')])], accepted.id);
    expect(receipts.checksFailed).toEqual([failed]);
    expect(receipts.unresolvedChecks).toEqual([]);
    expect(receipts.checksRun).toEqual([failed, retry]);
  });
  it.each([
    ['npx vitest run subset.test.ts | tail -20', 'Exit code: 0', undefined],
    ['npx vitest run | tail -20', 'Exit code: 1', undefined],
    ['npx vitest run | tail -20', 'No exit status', undefined],
    ['npx vitest run | tail -20', 'Exit code: 0', 'other-project'],
    ['npx vitest run | tail -20 other-file', 'Exit code: 0', undefined],
    ['npx vitest run || true | tail -20', 'Exit code: 0', undefined],
  ])('retains failure for a different or unproven retry: %s, %s, cwd=%s', (command, output, cwd) => {
    const accepted = user(sessionId), failed = 'npx vitest run | tail -18';
    const retry = bash(command, output, { args: { command, cwd } });
    expect(computeReceipts([accepted, batch(sessionId, [bash(failed, 'Command timed out.'), retry])], accepted.id).unresolvedChecks).toEqual([checkFailed(output) ? command : failed]);
  });
  it('leaves filesChangedAfterLastCheck empty when no checks ran', () => {
    const accepted = user(sessionId);
    const receipts = computeReceipts([accepted, batch(sessionId, [write('a.ts'), bash('ls', 'a.ts\nExit code: 0')])], accepted.id);
    expect(receipts.filesChangedAfterLastCheck).toEqual([]);
    expect(receipts.checksRun).toEqual([]);
    expect(receipts.commandsRun).toEqual(['ls']);
  });
  it('flags only paths written without an earlier completed exact-path read', () => {
    const accepted = user(sessionId);
    const messages = [accepted, batch(sessionId, [
      read('seen.ts'),
      { ...read('failed.ts'), status: 'error' as const }, // Failed read proves nothing.
      { name: 'grep', args: { pattern: 'fuzzy' }, output: 'fuzzy.ts:1:match' }, // Grep hits never count (documented).
    ]), batch(sessionId, [write('seen.ts'), write('failed.ts'), write('fuzzy.ts')])];
    expect(computeReceipts(messages, accepted.id).unreadFilesChanged).toEqual(['failed.ts', 'fuzzy.ts']);
  });
  it('a read in the same batch as (not before) the write does not clear the flag, and later reads never do', () => {
    const accepted = user(sessionId);
    const messages = [accepted, batch(sessionId, [write('late.ts'), read('late.ts')])];
    expect(computeReceipts(messages, accepted.id).unreadFilesChanged).toEqual(['late.ts']);
  });
  it('excludes background bash starts and non-completed calls from commandsRun', () => {
    const accepted = user(sessionId);
    const messages = [accepted, batch(sessionId, [
      bash('npm test', 'Started background job job-1', { args: { command: 'npm test', run_in_background: true } }),
      bash('true', '\nExit code: 0'),
      bash('rm -rf x', 'The user denied or cancelled this action.', { status: 'denied' }),
      { ...write('denied.ts'), status: 'denied' as const },
    ])];
    const receipts = computeReceipts(messages, accepted.id);
    expect(receipts.commandsRun).toEqual(['true']);
    expect(receipts.checksRun).toEqual([]); // The background npm test never completed in-turn.
    expect(receipts.filesChanged).toEqual([]); // Denied write changed nothing.
  });
  it('dedupes filesChanged in first-change order and tracks the LAST change against the LAST check', () => {
    const accepted = user(sessionId);
    const messages = [accepted,
      batch(sessionId, [read('a.ts'), read('b.ts')]),
      batch(sessionId, [write('b.ts')]),
      batch(sessionId, [bash('npx vitest run', 'ok\nExit code: 0')]),
      batch(sessionId, [write('a.ts'), write('b.ts')]),
    ];
    const receipts = computeReceipts(messages, accepted.id);
    expect(receipts.filesChanged).toEqual(['b.ts', 'a.ts']);
    expect(receipts.filesChangedAfterLastCheck.sort()).toEqual(['a.ts', 'b.ts']);
    expect(receipts.unreadFilesChanged).toEqual([]);
  });
  it('walks from the start when sinceMessageId is undefined or unknown', () => {
    const messages = [user(sessionId), batch(sessionId, [write('a.ts')])];
    expect(computeReceipts(messages, undefined).filesChanged).toEqual(['a.ts']);
    expect(computeReceipts(messages, 'missing-id').filesChanged).toEqual(['a.ts']);
  });
});

describe('receiptsNotice', () => {
  const base = { filesChanged: [], commandsRun: [], checksRun: [], checksFailed: [], unresolvedChecks: [], filesChangedAfterLastCheck: [], unreadFilesChanged: [] };
  it('is silent for pure-read turns and verified turns', () => {
    expect(receiptsNotice(base)).toBeNull();
    expect(receiptsNotice({ ...base, filesChanged: ['a.ts'], checksRun: ['npm test'] })).toBeNull();
  });
  it('reports missing checks and post-check edits', () => {
    expect(receiptsNotice({ ...base, filesChanged: ['a.ts', 'b.ts'] })).toBe('\n\n[Receipts: 2 file(s) changed, no checks were run.]');
    expect(receiptsNotice({ ...base, filesChanged: ['a.ts'], checksRun: ['npm test'], filesChangedAfterLastCheck: ['a.ts'] })).toBe('\n\n[Receipts: 1 file(s) changed, 1 changed after the last check.]');
  });
});
