import type { RunEvent, SessionDetail } from '../../shared/types';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const query = (values: Record<string, string>) => new URLSearchParams(values).toString();
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

/** Idempotent for snapshot messages and tool updates; SSE replay is deduplicated by event ID by the caller. */
export function applyEvent(detail: SessionDetail, event: RunEvent): SessionDetail {
  if (event.id && event.id <= (detail.lastEventId ?? 0)) return detail;
  return { ...reduceEvent(detail, event), lastEventId: event.id ?? detail.lastEventId };
}
function reduceEvent(detail: SessionDetail, event: RunEvent): SessionDetail {
  const data = event.data;
  switch (event.type) {
    case 'session': return { ...detail, session: { ...detail.session, ...(data.session ?? data) } };
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
    case 'todos': return { ...detail, todos: data.todos ?? data };
    case 'done': return { ...detail, session: { ...detail.session, status: data.status === 'error' ? 'error' : 'idle' } };
    case 'error': return { ...detail, session: { ...detail.session, status: 'error' } };
    default: return detail;
  }
}
