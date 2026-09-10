import type { Message, SessionDetail, Usage } from '../shared/types.js';
import { conversationBlocks } from '../shared/conversation-blocks.js';
import { formatDuration } from './transcriptModel.js';

export function conversationGroups(detail: SessionDetail) {
  const busy = detail.session.status === 'running' || detail.session.status === 'waiting';
  const groups = conversationBlocks(detail.messages);
  return groups.map((group, index) => ({ ...group, live: busy && group.closesTranscript && index === groups.length - 1, footer: group.endsRun && !(busy && group.closesTranscript) }));
}
export function usageLabel(message: Message, usage?: Usage) {
  const family = message.turnUsage;
  const model = message.context?.model ?? family?.breakdown.find(item => item.sessionId === message.sessionId)?.model;
  const reported = !family || family.reportedRequests > 0;
  const parts = [model, usage ? reported ? `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens${family && family.reportedRequests < family.requests ? ' reported' : ''}` : 'Usage unavailable' : undefined, usage?.durationMs ? formatDuration(usage.durationMs) : undefined, usage?.cost !== undefined ? `$${usage.cost.toFixed(4)}` : undefined];
  return parts.filter(Boolean).join(' · ');
}
export function usageDetails(message: Message, usage?: Usage) {
  const rows = new Map<string, { label: string; input: number; output: number; count: number; reported: number }>();
  for (const record of message.turnUsage?.breakdown ?? []) {
    const key = JSON.stringify([record.role, record.providerId, record.model, record.phase]);
    const row = rows.get(key) ?? { label: `${record.role === 'lead' ? 'Driver' : record.role} · ${record.providerId}/${record.model} · ${record.phase}`, input: 0, output: 0, count: 0, reported: 0 };
    row.count++; if (record.usage) { row.reported++; row.input += record.usage.inputTokens; row.output += record.usage.outputTokens; } rows.set(key, row);
  }
  return [usageLabel(message, usage) || 'Usage not reported.', ...[...rows.values()].map(row => `${row.label}\n${row.reported ? `${row.input.toLocaleString()} input · ${row.output.toLocaleString()} output` : 'Usage not reported'} · ${row.count} requests${row.reported < row.count ? ` (${row.count - row.reported} unreported)` : ''}`)].join('\n\n');
}
