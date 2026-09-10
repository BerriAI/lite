import type { SessionDetail } from './types.js';

export type DelegationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

/** An observation, never authority to create, resume, or access a child. Reads
 * must validate the private link and its originating parent transcript. */
export interface DelegationSummary {
  id: string;
  parentSessionId: string;
  parentTurnId: string;
  parentMessageId: string;
  toolCallId: string;
  childSessionId: string;
  description: string;
  status: DelegationStatus;
  createdAt: number;
  finishedAt?: number;
  error?: string;
  /** Absent for one-shot read-only researchers ('task'). 'sidekick' marks the
   * persistent write-capable child of a Sidekick Fusion session: one durable
   * row per child, re-pointed to each new originating tool call. */
  role?: 'sidekick';
}

export type DelegationDetail = SessionDetail & {
  delegation: DelegationSummary;
  readOnly: true;
};
