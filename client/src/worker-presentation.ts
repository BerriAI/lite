import type { SessionDetail } from '../../shared/types';
import { visibleDelegations } from '../../shared/events';

/** Assign identity from the driver's call order, before a child exists. A
 * queued call keeps its number when it starts, completes, or is reloaded. */
export function workerLabels(detail: SessionDetail): Map<string, string> {
  const labels = new Map<string, string>();
  const tasks = visibleDelegations(detail);
  let counts: Record<string, number> = {};
  for (const message of detail.messages) {
    if (message.role === 'user') counts = {};
    for (const tool of message.toolCalls ?? []) {
      if (tool.name !== 'delegate' && tool.name !== 'sidekick') continue;
      const task = tasks.find(task => task.id === tool.delegationId && task.toolCallId === tool.id && task.parentMessageId === message.id);
      const role = tool.name === 'sidekick' ? 'Sidekick' : task?.role === 'expert' || (!task && detail.session.architecture?.kind === 'expert-fusion') ? 'Expert' : 'Worker';
      labels.set(`${message.id}:${tool.id}`, role === 'Sidekick' ? role : `${role} ${counts[role] = (counts[role] ?? 0) + 1}`);
    }
  }
  return labels;
}
