/** Framework-free session synchronization: one snapshot fetch, then the SSE
 * journal reduced through the shared `applyEvent` reducer. Listener
 * notifications coalesce to one per frame (16ms) so a burst of deltas costs a
 * single React render. Reconnects back off exponentially — 1s, 2s, 4s … 30s —
 * and the attempt counter never resets, so a flapping server converges to slow
 * polling instead of oscillating. The UI marks reconnecting while preserving
 * the last known state until the stream re-establishes and replays. */
import type { RunEvent, SessionDetail } from '../shared/types.js';
import { applyEvent } from '../shared/events.js';
import { SpeedrailClient } from './client.js';

export type SyncPhase = 'loading' | 'ready' | 'error';

export interface SyncState {
  phase: SyncPhase;
  detail: SessionDetail | null;
  connection?: 'connecting' | 'connected' | 'reconnecting';
  /** Fatal startup error message; only set when phase is "error". */
  error: string | null;
}

export const COALESCE_MS = 16;
export const BACKOFF_CAP_MS = 30000;

/** Delay before reconnect attempt `n` (1-based): min(1000·2^(n−1), 30s). */
export function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (Math.max(1, attempt) - 1), BACKOFF_CAP_MS);
}

export class SessionSync {
  private state: SyncState = { phase: 'loading', detail: null, error: null };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private refreshSequence = 0;

  constructor(readonly client: SpeedrailClient, readonly sessionId: string) {}

  getState(): SyncState { return this.state; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Applies an event locally without waiting for the SSE echo. The reducer's
   * event-ID dedupe makes the later journal replay a no-op. */
  apply(event: RunEvent): void {
    if (!this.state.detail) return;
    this.set({ ...this.state, detail: applyEvent(this.state.detail, event) });
  }

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.run(this.controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
  }

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    const signal = this.controller?.signal;
    const detail = await this.client.api<SessionDetail>(`/sessions/${encodeURIComponent(this.sessionId)}`, undefined, undefined, signal);
    if (signal?.aborted || sequence !== this.refreshSequence) return;
    if ((detail.lastEventId ?? 0) >= (this.state.detail?.lastEventId ?? 0)) this.set({ ...this.state, phase: 'ready', error: null, detail });
  }

  private set(next: SyncState): void {
    this.state = next;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const listener of [...this.listeners]) listener();
    }, COALESCE_MS);
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      const snapshot = await this.client.api<SessionDetail>(`/sessions/${encodeURIComponent(this.sessionId)}`, undefined, undefined, signal);
      if (signal.aborted) return;
      this.set({ phase: 'ready', detail: snapshot, error: null, connection: 'connected' });
    } catch (error) {
      if (signal.aborted) return;
      this.set({ phase: 'error', detail: null, error: error instanceof Error ? error.message : 'Could not load the session.' });
      return;
    }
    while (!signal.aborted) {
      try {
        for await (const event of this.client.events(this.sessionId, this.state.detail?.lastEventId, signal)) {
          if (signal.aborted) return;
          if (event.sessionId !== this.sessionId) continue;
          this.set({ ...this.state, connection: 'connected', detail: applyEvent(this.state.detail!, event) });
        }
      } catch { /* Silent: the backoff loop below re-establishes the stream. */ }
      if (signal.aborted) return;
      this.set({ ...this.state, connection: 'reconnecting' });
      this.attempts += 1;
      await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, backoffDelay(this.attempts));
        signal.addEventListener('abort', finish, { once: true });
      });
      if (signal.aborted) return;
      // The journal replays from Last-Event-ID on reconnect; the snapshot
      // refetch only covers a server whose journal was truncated meanwhile.
      try {
        const snapshot = await this.client.api<SessionDetail>(`/sessions/${encodeURIComponent(this.sessionId)}`, undefined, undefined, signal);
        if (!signal.aborted && (snapshot.lastEventId ?? 0) >= (this.state.detail?.lastEventId ?? 0)) {
          this.set({ ...this.state, detail: snapshot, connection: 'connected' });
        }
      } catch { /* Stay on the last known state and retry the stream. */ }
    }
  }
}
