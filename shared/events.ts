import type { RunEvent, Session, SessionDetail } from './types.js';
import type { DelegationSummary } from './delegation.js';

/** Only private summaries bound to an exact current task call expose child transcripts. */
export function visibleDelegations(detail: SessionDetail): DelegationSummary[] {
  return (detail.delegations ?? []).filter(task => task.parentSessionId === detail.session.id && detail.messages.some(message =>
    message.role === 'assistant' && message.id === task.parentMessageId && message.sessionId === detail.session.id && message.toolCalls?.some(tool =>
      tool.name === 'task' && tool.id === task.toolCallId && tool.delegationId === task.id)));
}

/** Session configuration is monotonic even when an older snapshot overlaps a newer mutation. */
export function reconcileSession(current: Session, incoming: Session): Session {
  if ((incoming.configRevision ?? 0) >= (current.configRevision ?? 0)) return incoming;
  return { ...incoming, providerId: current.providerId, model: current.model, mode: current.mode, planner: current.planner, outputStyle: current.outputStyle,
    permissionMode: current.permissionMode, profile: current.profile, configRevision: current.configRevision };
}

/** Idempotent for snapshot messages and tool updates; SSE replay is deduplicated by event ID by the caller. */
export function applyEvent(detail: SessionDetail, event: RunEvent): SessionDetail {
  if (event.id && event.id <= (detail.lastEventId ?? 0)) return detail;
  return { ...reduceEvent(detail, event), lastEventId: event.id ?? detail.lastEventId };
}
function reduceEvent(detail: SessionDetail, event: RunEvent): SessionDetail {
  const data = event.data;
  switch (event.type) {
    case 'session': {
      const session = data.session ?? data;
      // Revision-bearing events are full persisted sessions; an omitted profile means explicitly cleared.
      const incoming = { ...detail.session, ...session, ...(session.configRevision !== undefined ? { profile: session.profile } : {}) };
      return { ...detail, session: reconcileSession(detail.session, incoming) };
    }
    case 'message': {
      const message = data.message ?? data;
      if (!message.id) return detail;
      const exists = detail.messages.some(m => m.id === message.id);
      return { ...detail, messages: exists ? detail.messages.map(m => m.id === message.id ? { ...m, ...message } : m) : [...detail.messages, message] };
    }
    case 'delta':
    case 'reasoning': {
      const messageId = data.messageId ?? data.id;
      const field = event.type === 'reasoning' ? 'reasoning' : 'content';
      const text = data.delta ?? data.text ?? data.content ?? '';
      return { ...detail, messages: detail.messages.map(m => m.id === messageId ? { ...m, [field]: (m[field] ?? '') + text } : m) };
    }
    case 'tool': {
      const tool = data.tool ?? data.toolCall ?? data;
      return { ...detail, messages: detail.messages.map(m => {
        if (m.id !== data.messageId && !m.toolCalls?.some(t => t.id === tool.id)) return m;
        const calls = m.toolCalls ?? [];
        return { ...m, toolCalls: calls.some(t => t.id === tool.id) ? calls.map(t => t.id === tool.id ? { ...t, ...tool } : t) : [...calls, tool] };
      }) };
    }
    case 'permission': {
      const permission = data.permission ?? data;
      return { ...detail, session: { ...detail.session, status: 'waiting' }, permissions: [...detail.permissions.filter(p => p.id !== permission.id), permission] };
    }
    case 'permission_resolved': return { ...detail, permissions: detail.permissions.filter(p => p.id !== (data.id ?? data.requestId ?? data.permissionId)) };
    case 'question': return { ...detail, session: { ...detail.session, status: 'waiting' }, questions: [...(detail.questions ?? []).filter(question => question.id !== data.id), data] };
    case 'question_resolved': return { ...detail, questions: (detail.questions ?? []).filter(question => question.id !== data.id) };
    case 'queue': return { ...detail, queue: data };
    case 'history': return { ...detail, history: data };
    case 'delegation': {
      const task = data as DelegationSummary;
      if (task.parentSessionId !== detail.session.id) return detail;
      const previous = detail.delegations?.find(item => item.id === task.id);
      // Terminal task settlement is immutable; a delayed running summary cannot revive it.
      if (previous && previous.status !== 'running') return detail;
      return { ...detail, delegations: previous ? detail.delegations!.map(item => item.id === task.id ? task : item) : [...(detail.delegations ?? []), task] };
    }
    case 'reset': {
      const next = { ...detail, messages: data.messages, ...(Array.isArray(data.delegations) ? { delegations: data.delegations } : {}) };
      return { ...next, delegations: visibleDelegations(next) };
    }
    case 'todos': return { ...detail, todos: data.todos ?? data };
    case 'done': return { ...detail, session: { ...detail.session, status: data.status === 'error' ? 'error' : 'idle' } };
    case 'error': return { ...detail, session: { ...detail.session, status: 'error' } };
    default: return detail;
  }
}
