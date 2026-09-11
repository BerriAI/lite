import { afterEach, describe, expect, it, vi } from 'vitest';
import { progressTimeout } from '../server/progress-timeout.js';
afterEach(() => vi.useRealTimers());
describe('worker progress timeout', () => {
  it('permits ongoing work beyond the former wall-clock limit, then stops a stalled worker', () => {
    vi.useFakeTimers(); const expired = vi.fn();
    const timeout = progressTimeout(10000, () => false, expired);
    for (let i = 0; i < 50; i++) { vi.advanceTimersByTime(9000); timeout.progress(); }
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10000); expect(expired).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20000); expect(expired).toHaveBeenCalledOnce(); timeout.close();
  });
  it('pauses for human input and gives the worker time to resume afterward', () => {
    vi.useFakeTimers(); const expired = vi.fn(); let waiting = false;
    const timeout = progressTimeout(10000, () => waiting, expired);
    vi.advanceTimersByTime(9000); waiting = true; vi.advanceTimersByTime(600000);
    expect(expired).not.toHaveBeenCalled(); waiting = false;
    vi.advanceTimersByTime(9000); expect(expired).not.toHaveBeenCalled();
    timeout.progress(); vi.advanceTimersByTime(9000); expect(expired).not.toHaveBeenCalled();
    timeout.close(); vi.advanceTimersByTime(600000); expect(expired).not.toHaveBeenCalled();
  });
});

it('keeps a slow provider alive beyond five minutes and resets its deadline on streamed progress', async () => {
  const { streamCompletion } = await import('../server/providers.js');
  vi.useFakeTimers();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  const encoder = new TextEncoder();
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    options.signal.addEventListener('abort', () => output.error(options.signal.reason), { once: true });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }));
  try {
    const stream = streamCompletion({ provider: { id: 'fixture', kind: 'openai', name: 'Fixture', baseUrl: 'https://fixture.invalid' }, model: 'slow', messages: [], signal: new AbortController().signal });
    const first = stream.next(); let settled = false; first.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(6 * 60_000); expect(settled).toBe(false);
    output.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Still working"},"finish_reason":null}]}\n\n'));
    expect((await first).value).toMatchObject({ type: 'text', text: 'Still working' });
    const next = stream.next(); const failure = expect(next).rejects.toThrow('No model progress for 10 minutes');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000); await failure;
  } finally { vi.unstubAllGlobals(); }
});
