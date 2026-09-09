import type { Attachment, RunEvent, Session, SessionDetail } from '../../shared/types';
import { useEffect, useRef, useState } from 'react';
import type { DelegationSummary } from '../../shared/delegation';

export interface ComposerDraft { text: string; attachments: Attachment[] }
const DRAFT_PREFIX = 'lite:draft:v1:';
const DRAFT_LIMIT = 1024 * 1024;
const DRAFT_TOTAL_LIMIT = 2 * 1024 * 1024;
const emptyDraft = (): ComposerDraft => ({ text: '', attachments: [] });
const draftBytes = (draft: ComposerDraft) => JSON.stringify(draft).length * 2;
export const fitsDraft = (draft: ComposerDraft) => draftBytes(draft) <= DRAFT_LIMIT;

function validDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ComposerDraft;
  return typeof draft.text === 'string' && draft.text.length <= 200_000 && Array.isArray(draft.attachments) && draft.attachments.length <= 6 && draft.attachments.every(attachment =>
    attachment && typeof attachment.name === 'string' && attachment.name.length <= 255 &&
    ['path', 'content', 'mimeType', 'dataUrl'].every(key => (attachment as unknown as Record<string, unknown>)[key] === undefined || typeof (attachment as unknown as Record<string, unknown>)[key] === 'string') &&
    (!attachment.dataUrl || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(attachment.dataUrl))) && fitsDraft(draft);
}

/** Local convenience only. Failed persistence is visible, while every draft stays in memory on navigation. */
export function useSessionDraft(sessionId: string | null) {
  const drafts = useRef(new Map<string, ComposerDraft>());
  const notices = useRef(new Map<string, string>());
  const unsaved = useRef(new Set<string>());
  // Last value this tab successfully restored or wrote, not whatever another tab has since saved.
  const saved = useRef(new Map<string, string | null>());
  const [, rerender] = useState(0);
  const key = DRAFT_PREFIX + (sessionId ?? 'new');
  if (!drafts.current.has(key)) {
    let draft = emptyDraft();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!validDraft(parsed)) throw new Error('Invalid saved draft');
        draft = parsed;
      }
      saved.current.set(key, raw);
    } catch {
      notices.current.set(key, 'The saved draft could not be restored. Browser storage may be unavailable. No stored data has been deleted.');
    }
    drafts.current.set(key, draft);
  }
  const removeSaved = (target: string, expected: string | null | undefined) => {
    const storage = localStorage;
    if (expected === undefined || storage.getItem(target) !== expected) return false;
    storage.removeItem(target);
    return true;
  };
  const persist = (target: string, draft: ComposerDraft, submitted = false) => {
    try {
      const storage = localStorage;
      if (submitted) {
        if (!removeSaved(target, saved.current.get(target))) {
          notices.current.set(target, 'Message accepted. A different saved draft was left unchanged; it may belong to another tab.');
          unsaved.current.delete(target);
          return;
        }
        saved.current.set(target, null);
      } else {
        if (!fitsDraft(draft)) throw new Error('Saved drafts are limited to 1 MiB including attachments; larger attachments can still be sent.');
        const data = JSON.stringify(draft);
        let total = data.length * 2;
        for (let i = 0; i < storage.length; i++) {
          const other = storage.key(i);
          if (other?.startsWith(DRAFT_PREFIX) && other !== target) total += (storage.getItem(other)?.length ?? 0) * 2;
        }
        if (total > DRAFT_TOTAL_LIMIT) throw new Error('Saved drafts have reached the 2 MiB browser limit. Send or shorten another session’s draft.');
        storage.setItem(target, data);
        saved.current.set(target, data);
      }
      notices.current.delete(target); unsaved.current.delete(target);
    } catch (error) {
      unsaved.current.add(target);
      const reason = error instanceof Error && /^(Drafts are|Saved drafts)/.test(error.message) ? error.message : 'Browser storage is unavailable or full.';
      notices.current.set(target, submitted
        ? 'Message accepted, but its saved draft could not be cleared. It may reappear after reload; check the conversation before sending again.'
        : `${reason} Your current draft is kept in this tab, but is not saved for reload. Copy it before leaving.`);
    }
  };
  const update = (change: Partial<ComposerDraft>) => {
    const draft = { ...drafts.current.get(key)!, ...change };
    drafts.current.set(key, draft); persist(key, draft); rerender(value => value + 1);
  };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsaved.current.size) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return {
    draft: drafts.current.get(key)!, notice: notices.current.get(key),
    setText: (text: string) => update({ text }),
    setAttachments: (attachments: Attachment[]) => update({ attachments }),
    prepareDelete: (id: string) => {
      const target = DRAFT_PREFIX + id;
      // Capture before the server request, including for an unopened sidebar session.
      let expected = saved.current.get(target);
      if (!saved.current.has(target)) {
        try { expected = localStorage.getItem(target); } catch { /* Never delete an unknown value. */ }
      }
      return () => {
        let warning: string | undefined;
        try {
          if (!removeSaved(target, expected)) warning = 'A different saved draft was left unchanged; it may belong to another tab.';
        } catch { warning = 'Its saved draft could not be cleared because browser storage is unavailable.'; }
        drafts.current.delete(target); saved.current.delete(target);
        notices.current.delete(target); unsaved.current.delete(target);
        rerender(value => value + 1);
        return warning;
      };
    },
    clearSubmitted: (submitted: ComposerDraft) => {
      // A response for another session or an older in-flight draft must never erase newer typing.
      const current = drafts.current.get(key);
      if (!current || current.text !== submitted.text || current.attachments !== submitted.attachments) return;
      drafts.current.set(key, emptyDraft()); persist(key, emptyDraft(), true); rerender(value => value + 1);
    },
  };
}

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

/** Only private summaries bound to an exact current task call expose child transcripts. */
export function visibleDelegations(detail: SessionDetail): DelegationSummary[] {
  return (detail.delegations ?? []).filter(task => task.parentSessionId === detail.session.id && detail.messages.some(message =>
    message.role === 'assistant' && message.id === task.parentMessageId && message.sessionId === detail.session.id && message.toolCalls?.some(tool =>
      tool.name === 'task' && tool.id === task.toolCallId && tool.delegationId === task.id)));
}

/** Session configuration is monotonic even when an older snapshot overlaps a newer mutation. */
export function reconcileSession(current: Session, incoming: Session): Session {
  if ((incoming.configRevision ?? 0) >= (current.configRevision ?? 0)) return incoming;
  return { ...incoming, providerId: current.providerId, model: current.model, mode: current.mode, planner: current.planner,
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
