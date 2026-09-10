/** Minimal end-of-turn evidence receipts: a host-computed account of what a
 * turn actually DID, derived purely from completed tool calls. Observation
 * only — no contracts, no sign-off, no gating — so silence in the assistant's
 * prose cannot hide unverified work. */
export interface TurnReceipts {
  /** Paths of completed write_file/edit_file calls, deduped, in first-change order. */
  filesChanged: string[];
  /** Completed foreground bash commands. A run_in_background start is excluded:
   * it proves the job started, not that the command ran to completion. */
  commandsRun: string[];
  /** commandsRun entries matching the check heuristic, in execution order (not deduped). */
  checksRun: string[];
  /** checksRun entries whose result reported failure (see checkFailed). */
  checksFailed: string[];
  /** Failed check commands not superseded by a later successful identical check. */
  unresolvedChecks?: string[];
  /** Files whose LAST change landed after the LAST completed check — the
   * "you edited after your tests passed" catch. Empty when no checks ran
   * (that case is already reported as "no checks were run"). */
  filesChangedAfterLastCheck: string[];
  /** Files changed with no completed read_file of the exact same path string
   * earlier in the same turn ("wrote without looking"). Exact read_file
   * args.path match only: a file merely appearing inside grep/glob RESULT
   * content is too fuzzy to prove the model looked at it, and path spelling
   * variants ('a.ts' vs './a.ts') are not unified — a deliberate, documented
   * over-flagging heuristic, never a gate. */
  unreadFilesChanged: string[];
}

/** Conservative verification heuristic. A bash command counts as a check when
 * it starts with — or contains, after a shell separator (;, &, |, (, or
 * whitespace) — one of these known checker invocations:
 *   npm test · npx vitest · npx tsc · npm run typecheck · npm run lint ·
 *   npm run check · pytest · cargo test · cargo check · go test ·
 *   make test · make check
 * Deliberately narrow: a false "no checks were run" is a small annoyance,
 * while a false "checks ran" would launder unverified work. */
const CHECKERS = ['npm test', 'npx vitest', 'npx tsc', 'npx playwright test', 'npm run test', 'npm run typecheck', 'npm run lint', 'npm run check', 'pytest', 'cargo test', 'cargo check', 'go test', 'make test', 'make check'];
// Word boundaries on both sides so 'echo test', 'pytest-cov' and 'npm run checkstyle' never match.
const CHECK_PATTERN = new RegExp(`(?:^|[;&|(\\s])(?:${CHECKERS.map(checker => checker.replace(/ /g, '\\s+')).join('|')})(?=$|[;&|)\\s])`);
export const isCheckCommand = (command: string): boolean => CHECK_PATTERN.test(command);

/** A check failed when its result content ends with the bash tool's trailing
 * status line reporting a nonzero exit — 'Exit code: <anything but 0>', which
 * includes signal names and 'unknown' — or a timeout ('Command timed out'). */
export const checkFailed = (output: string): boolean => {
  if (/(?:^|\n)Command timed out\.?\s*$/.test(output)) return true;
  const match = output.match(/(?:^|\n)Exit code: (\S+)\s*$/);
  return match !== null && match[1] !== '0';
};
