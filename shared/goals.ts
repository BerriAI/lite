/** GOAL MODE: one session-level objective pursued across multiple turns with
 * structured progress reports (the update_goal tool) and host continuation.
 * The goal lives on Session, so it survives restarts; continuation does NOT
 * auto-resume after a restart or a user cancel — the next user message in the
 * session resumes goal turns while the goal is still 'active'. */
export type GoalStatus = 'active' | 'completed' | 'blocked' | 'cleared';
export type GoalReportStatus = 'continue' | 'complete' | 'blocked';
export interface SessionGoal {
  /** User-authored objective (<= 2000 chars). A USER instruction, not host text. */
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  /** Turns STARTED for this goal (user, queued, and host-continued alike).
   * A cancelled turn stays counted: it was spent. */
  turns: number;
  /** Optional user-selected continuation ceiling. Omitted means no turn limit. */
  maxTurns?: number;
  /** Latest update_goal report, or the host-authored note that settled the goal
   * (turn-limit pause, or the no-report evaluator's verdict). */
  lastReport?: { status: GoalReportStatus; note: string };
}
export const GOAL_LIMITS = { textChars: 2000, noteChars: 1000 } as const;
export const goalTurnLabel = (turns: number, maxTurns?: number): string => `Turn ${turns}${maxTurns === undefined ? '' : ` of ${maxTurns}`}`;
