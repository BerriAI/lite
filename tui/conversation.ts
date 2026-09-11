import { cacheHitLabel, usagePhase } from '../shared/usage.js';
import type { DelegationSummary, Message, SessionDetail, ToolCall, Usage } from '../shared/types.js';
import { conversationBlocks } from '../shared/conversation-blocks.js';
import { workerLabels } from '../shared/worker-presentation.js';
import { visibleDelegations } from '../shared/events.js';
import { formatDuration } from './transcriptModel.js';

export function conversationGroups(detail: SessionDetail) {
  const busy = detail.session.status === 'running' || detail.session.status === 'waiting';
  const groups = conversationBlocks(detail.messages);
  return groups.map((group, index) => ({ ...group, live: busy && group.closesTranscript && index === groups.length - 1, footer: group.endsRun && !(busy && group.closesTranscript) }));
}

export type ActivityEntry = { message: Message; call?: ToolCall };
export type ActivitySection = { kind: 'driver'; id: string; entries: ActivityEntry[] } | { kind: 'worker'; id: string; message: Message; call: ToolCall; label: string; task?: DelegationSummary };
export function activityActors(detail: SessionDetail) {
  const actors = new Map([...workerLabels(detail)].map(([key, label]) => [key, { label, task: undefined as DelegationSummary | undefined }]));
  for (const task of visibleDelegations(detail)) {
    const key = `${task.parentMessageId}:${task.toolCallId}`;
    actors.set(key, { label: actors.get(key)?.label ?? 'Research', task });
  }
  return actors;
}
export function activitySections(steps: Message[], actors: ReturnType<typeof activityActors>): ActivitySection[] {
  const sections: ActivitySection[] = [];
  const append = (entry: ActivityEntry) => {
    let section = sections.at(-1);
    if (section?.kind !== 'driver') { section = { kind: 'driver', id: entry.call?.id ?? entry.message.id, entries: [] }; sections.push(section); }
    section.entries.push(entry);
  };
  for (const [index, message] of steps.entries()) {
    if (index > 0 && message.reasoning) append({ message });
    for (const call of message.toolCalls ?? []) {
      const actor = actors.get(`${message.id}:${call.id}`);
      if (actor) sections.push({ kind: 'worker', id: call.id, message, call, ...actor });
      else append({ message, call });
    }
  }
  return sections;
}
export function usageLabel(message: Message, usage?: Usage) {
  const family = message.turnUsage;
  const model = message.context?.model ?? family?.breakdown.find(item => item.sessionId === message.sessionId)?.model;
  const companions = [...new Set(family?.breakdown.filter(item => item.rootSessionId === message.sessionId && item.sessionId !== message.sessionId && item.role !== 'driver' && item.role !== 'lead').map(item => item.role) ?? [])];
  const modelLabel = model ? [model, ...companions].join(' + ') : undefined;
  const reported = !family || family.reportedRequests > 0;
  const parts = [modelLabel, usage ? reported ? `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens${family && family.reportedRequests < family.requests ? ' reported' : ''}` : 'Usage unavailable' : undefined, usage ? cacheHitLabel(usage,!family||family.reportedRequests===family.requests) : undefined, usage?.durationMs ? formatDuration(usage.durationMs) : undefined, usage?.cost !== undefined ? `$${usage.cost.toFixed(4)}` : undefined];
  return parts.filter(Boolean).join(' · ');
}
export function usageDetails(message: Message, usage?: Usage) {
  const rows = new Map<string, { label: string; input: number; output: number; count: number; reported: number; cached: number; cacheReports: number }>();
  for (const record of message.turnUsage?.breakdown ?? []) {
    const key = JSON.stringify([record.role, record.providerId, record.model, record.phase]);
    const row = rows.get(key) ?? { label: `${record.role === 'lead' ? 'Driver' : record.role} · ${record.providerId}/${record.model} · ${usagePhase(record.phase)}`, input: 0, output: 0, count: 0, reported: 0, cached:0, cacheReports:0 };
    row.count++; if (record.usage) { row.reported++; row.input += record.usage.inputTokens; row.output += record.usage.outputTokens; if(record.usage.cachedTokens!==undefined){row.cached+=record.usage.cachedTokens;row.cacheReports++;} } rows.set(key, row);
  }
  return [usageLabel(message, usage) || 'Usage not reported.', ...[...rows.values()].map(row => `${row.label}\n${row.reported ? `${row.input.toLocaleString()} input · ${row.output.toLocaleString()} output` : 'Usage not reported'} · ${cacheHitLabel({inputTokens:row.input,cachedTokens:row.cached},row.cacheReports===row.count)} · ${row.count} requests${row.reported < row.count ? ` (${row.count - row.reported} unreported)` : ''}`), 'Cache hit = cached input tokens / total input tokens. Output tokens are excluded.'].join('\n\n');
}
