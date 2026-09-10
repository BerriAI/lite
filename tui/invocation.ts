import type { DelegationDetail, DelegationSummary, RunEvent } from '../shared/types.js';
import { applyEvent } from '../shared/events.js';
import { SpeedrailClient } from './client.js';

export function invocationPath(task: DelegationSummary) {
  return `/sessions/${encodeURIComponent(task.parentSessionId)}/delegations/${encodeURIComponent(task.id)}`;
}

/** A subscription belongs to one handoff, even when Sidekick reuses its context. */
export class InvocationSync {
  private state: { detail: DelegationDetail | null; error: string } = { detail: null, error: '' };
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private sequence = 0;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private client: SpeedrailClient, readonly task: DelegationSummary) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(next: typeof this.state) {
    this.state = next;
    this.timer ??= setTimeout(() => { this.timer = undefined; for (const listener of this.listeners) listener(); }, 40);
  }
  async refresh() {
    const sequence = ++this.sequence;
    try {
      const value = await this.client.api<DelegationDetail>(invocationPath(this.task), undefined, undefined, this.controller.signal);
      if (sequence !== this.sequence || this.controller.signal.aborted) return;
      const task = value.delegation;
      if (!value.readOnly || value.session.id !== this.task.childSessionId || task.id !== this.task.id || task.parentSessionId !== this.task.parentSessionId || task.parentMessageId !== this.task.parentMessageId || task.parentTurnId !== this.task.parentTurnId || task.toolCallId !== this.task.toolCallId) throw new Error('Transcript does not match this assignment.');
      if (this.state.detail && this.state.detail.delegation.status !== 'running') return;
      if (task.status !== 'running' || (value.lastEventId ?? 0) >= (this.state.detail?.lastEventId ?? 0)) { this.set({ detail: value, error: '' }); if (task.status !== 'running') this.controller.abort(); }
    } catch (error) { if (!this.controller.signal.aborted && sequence === this.sequence) this.set({ ...this.state, error: (error as Error).message }); }
  }
  apply(event: RunEvent) {
    const current = this.state.detail;
    if (this.controller.signal.aborted || !current || current.delegation.status !== 'running' || event.sessionId !== this.task.childSessionId) return;
    const userId = current.messages.find(message => message.role === 'user')?.id;
    if (event.type === 'message') {
      const message = event.data.message ?? event.data;
      if (userId && ((message.role === 'user' && message.id !== userId) || (message.turnId && message.turnId !== userId))) return;
    }
    if (event.type === 'tool' && event.data.messageId && !current.messages.some(message => message.id === event.data.messageId)) return;
    this.set({ detail: { ...applyEvent(current, event), delegation: current.delegation, readOnly: true }, error: '' });
  }
  async start() {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    try { await this.run(); } finally { this.started = false; }
  }
  private async run() {
    await this.refresh();
    while (!this.controller.signal.aborted && this.state.detail?.delegation.status === 'running') {
      try {
        for await (const event of this.client.eventsAtPath(invocationPath(this.task) + '/events', this.state.detail.lastEventId, this.controller.signal)) {
          this.apply(event);
          if (event.type === 'done' || event.type === 'error') await this.refresh();
          if (this.state.detail?.delegation.status !== 'running' || this.controller.signal.aborted) return;
        }
      } catch { if (!this.controller.signal.aborted) this.set({ ...this.state, error: 'Reconnecting to this assignment…' }); }
      if (this.controller.signal.aborted) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.controller.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1000); this.controller.signal.addEventListener('abort', finish, { once: true });
      });
      if (!this.controller.signal.aborted) await this.refresh();
    }
  }
  stop() { this.controller.abort(); this.sequence++; if (this.timer) clearTimeout(this.timer); this.listeners.clear(); }
}
