import type { Usage } from './types.js';

export interface RequestUsage {
  id: string; rootSessionId: string; turnId: string; sessionId: string;
  providerId: string; model: string; role: 'lead' | 'driver' | 'sidekick' | 'worker' | 'expert' | 'research' | 'shunt';
  phase: 'response' | 'compaction' | 'review' | 'shunt_read' | 'shunt_write'; invocationId?: string; usage?: Usage;
  operationId?: string; callerRole?: Exclude<RequestUsage['role'], 'shunt'>;
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
    ...(reported.length === records.length && reported.length && reported.every(usage => usage.cachedTokens !== undefined)
      ? { cachedTokens: reported.reduce((sum, usage) => sum + usage.cachedTokens!, 0) } : {}),
  };
}

type CacheUsage = Pick<Usage,'inputTokens'|'cachedTokens'>;
export function cacheHitLabel(usage: CacheUsage | readonly (CacheUsage | undefined)[]): string {
  let inputTokens=0,cachedTokens=0;
  for(const report of 'inputTokens' in usage ? [usage] : usage) {
    if(!report || !Number.isFinite(report.inputTokens) || report.inputTokens<0 || report.cachedTokens===undefined || !Number.isFinite(report.cachedTokens) || report.cachedTokens<0 || report.cachedTokens>report.inputTokens)continue;
    inputTokens+=report.inputTokens;cachedTokens+=report.cachedTokens;
  }
  if(inputTokens<=0)return 'Cache unavailable';
  return `${Number((100*cachedTokens/inputTokens).toFixed(1))}% cache hit`;
}

export function usagePhase(phase:RequestUsage['phase']):string {return phase==='shunt_read'?'Reader':phase==='shunt_write'?'Writer':phase;}
