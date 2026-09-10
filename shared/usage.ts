import type { Usage } from './types.js';

export interface RequestUsage {
  id: string; rootSessionId: string; turnId: string; sessionId: string;
  providerId: string; model: string; role: 'lead' | 'driver' | 'sidekick' | 'worker' | 'expert' | 'research';
  phase: 'response' | 'compaction' | 'review'; invocationId?: string; usage?: Usage;
}
export interface TurnUsage extends Usage { requests: number; reportedRequests: number; breakdown: RequestUsage[] }

/** Missing cost or token reports stay unknown. Never infer a price or charge. */
export function aggregateUsage(records: RequestUsage[]): TurnUsage {
  const reported = records.flatMap(record => record.usage ? [record.usage] : []);
  return {
    inputTokens: reported.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: reported.reduce((sum, usage) => sum + usage.outputTokens, 0),
    requests: records.length, reportedRequests: reported.length, breakdown: records,
    ...(records.length && reported.length === records.length && reported.every(usage => usage.cost !== undefined)
      ? { cost: reported.reduce((sum, usage) => sum + usage.cost!, 0) } : {}),
    ...(reported.length && reported.every(usage => usage.cachedTokens !== undefined)
      ? { cachedTokens: reported.reduce((sum, usage) => sum + usage.cachedTokens!, 0) } : {}),
  };
}
