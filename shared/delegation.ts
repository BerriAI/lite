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
}

export type DelegationDetail = SessionDetail & {
  delegation: DelegationSummary;
  readOnly: true;
};
