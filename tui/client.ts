/** HTTP + SSE client for the terminal UI. The base URL is validated by the
 * launcher; everything here assumes a reachable Lite server and surfaces
 * failures as thrown errors with an optional HTTP status. */
import type { RunEvent } from '../shared/types.js';
import { SseParser } from './protocol.js';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export class LiteClient {
  constructor(readonly base: string) {}
  async api<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.base}/api${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', 'X-Lite-Client': 'terminal' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30000),
    });
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; }
    catch { throw new ApiError(`The Lite server returned an invalid response (HTTP ${response.status}).`, response.status); }
    if (!response.ok) throw new ApiError(typeof data.error === 'string' && data.error ? data.error : `HTTP ${response.status}`, response.status);
    return data as T;
  }

  /** Long-lived event subscription. Yields parsed run events; returns normally
   * when the server closes the stream (caller reconnects), throws on transport
   * errors, and ends silently when `signal` aborts. */
  async *events(sessionId: string, after: number | undefined, signal: AbortSignal): AsyncGenerator<RunEvent> {
    yield* this.eventsAtPath(`/sessions/${encodeURIComponent(sessionId)}/events`, after, signal);
  }
  async *eventsAtPath(path: string, after: number | undefined, signal: AbortSignal): AsyncGenerator<RunEvent> {
    const response = await fetch(`${this.base}/api${path}`, {
      headers: { Accept: 'text/event-stream', ...(after ? { 'Last-Event-ID': String(after) } : {}) },
      signal,
    });
    if (!response.ok || !response.body) throw new ApiError(`Could not connect to the session stream (HTTP ${response.status}).`, response.status);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          let event: RunEvent;
          try { event = JSON.parse(frame.data) as RunEvent; } catch { continue; }
          if (frame.id !== undefined && event.id === undefined) event.id = frame.id;
          yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
