import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, SessionDetail } from '../shared/types.js';
import type { LiteClient } from '../tui/client.js';
import { parseOptions } from '../tui/options.js';
import { backoffDelay, BACKOFF_CAP_MS, COALESCE_MS, SessionSync } from '../tui/sync.js';

function detailFixture(): SessionDetail {
  return {
    session: { id: 's1', title: 'Fixture', workspace: '/tmp/w', model: 'test-model', providerId: 'fixture', mode: 'build', permissionMode: 'ask', status: 'idle', createdAt: 1, updatedAt: 1 } as SessionDetail['session'],
    messages: [], todos: [], permissions: [], lastEventId: 0,
  };
}

/** A LiteClient stand-in whose event stream is fed by the test. */
function fakeClient(detail: SessionDetail, streams: RunEvent[][]) {
  let connection = 0;
  const snapshots: number[] = [];
  const client = {
    api: vi.fn(async (path: string) => { snapshots.push(Date.now()); return structuredClone(detail); }),
    events: vi.fn(async function* (_id: string, _after: number | undefined, signal: AbortSignal) {
      const batch = streams[connection++];
      if (!batch) { await new Promise(() => {}); return; }
      for (const event of batch) {
        if (signal.aborted) return;
        yield event;
      }
    }),
  };
  return { client: client as unknown as LiteClient, snapshots };
}

describe('tui options', () => {
  it('parses launcher-forwarded flags with defaults', () => {
    const options = parseOptions(['--url', 'http://127.0.0.1:3211/', '--workspace', '/w', '--plan', '--auto'], {}, '/cwd');
    expect(options).toEqual({ url: 'http://127.0.0.1:3211', workspace: '/w', sessionId: undefined, model: undefined, providerId: undefined, mode: 'plan', permissionMode: 'auto' });
  });
  it('falls back to environment and cwd', () => {
    const options = parseOptions([], { LITE_PORT: '4000' }, '/cwd');
    expect(options.url).toBe('http://localhost:4000');
    expect(options.workspace).toBe('/cwd');
    expect(options.mode).toBeUndefined();
    expect(options.permissionMode).toBeUndefined();
  });
});

describe('tui backoff', () => {
  it('doubles from one second and caps at thirty', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(0)).toBe(1000);
    expect(BACKOFF_CAP_MS).toBe(30000);
  });
});

describe('tui session sync', () => {
  it('loads the snapshot, reduces events, and coalesces notifications', async () => {
    vi.useFakeTimers();
    try {
      const events: RunEvent[] = [
        { id: 1, type: 'message', sessionId: 's1', data: { id: 'm1', sessionId: 's1', role: 'assistant', content: '', createdAt: 2 } },
        { id: 2, type: 'delta', sessionId: 's1', data: { messageId: 'm1', delta: 'Hello' } },
        { id: 3, type: 'delta', sessionId: 's1', data: { messageId: 'm1', delta: ' world' } },
      ];
      const { client } = fakeClient(detailFixture(), [events]);
      const sync = new SessionSync(client, 's1');
      const listener = vi.fn();
      sync.subscribe(listener);
      sync.start();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);
      // Snapshot plus three journal events collapse into at most two frames.
      expect(listener.mock.calls.length).toBeLessThanOrEqual(2);
      expect(sync.getState().phase).toBe('ready');
      expect(sync.getState().detail?.messages[0]?.content).toBe('Hello world');
      expect(sync.getState().detail?.lastEventId).toBe(3);
      sync.stop();
    } finally { vi.useRealTimers(); }
  });

  it('ignores events for other sessions and duplicate event IDs', async () => {
    vi.useFakeTimers();
    try {
      const events: RunEvent[] = [
        { id: 1, type: 'message', sessionId: 's1', data: { id: 'm1', sessionId: 's1', role: 'assistant', content: '', createdAt: 2 } },
        { id: 2, type: 'delta', sessionId: 'other', data: { messageId: 'm1', delta: 'WRONG' } },
        { id: 2, type: 'delta', sessionId: 's1', data: { messageId: 'm1', delta: 'once' } },
        { id: 2, type: 'delta', sessionId: 's1', data: { messageId: 'm1', delta: 'twice' } },
      ];
      const { client } = fakeClient(detailFixture(), [events]);
      const sync = new SessionSync(client, 's1');
      sync.start();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);
      expect(sync.getState().detail?.messages[0]?.content).toBe('once');
      sync.stop();
    } finally { vi.useRealTimers(); }
  });

  it('reports a fatal error when the snapshot fetch fails', async () => {
    vi.useFakeTimers();
    try {
      const client = { api: vi.fn(async () => { throw new Error('HTTP 404'); }), events: vi.fn() } as unknown as LiteClient;
      const sync = new SessionSync(client, 'missing');
      sync.start();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);
      expect(sync.getState().phase).toBe('error');
      expect(sync.getState().error).toBe('HTTP 404');
      sync.stop();
    } finally { vi.useRealTimers(); }
  });

  it('backs off between reconnects without resetting the counter', async () => {
    vi.useFakeTimers();
    try {
      // Every stream closes immediately (server hangup); attempts accumulate.
      const { client } = fakeClient(detailFixture(), [[], [], [], []]);
      const sync = new SessionSync(client, 's1');
      sync.start();
      await vi.advanceTimersByTimeAsync(5); // snapshot resolves, first stream ends, 1s backoff starts
      const eventCalls = () => (client.events as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(eventCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(900); // t≈905: still inside the 1s backoff
      expect(eventCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(200); // t≈1105: reconnected after ~1s
      expect(eventCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1700); // t≈2805: inside the 2s backoff (not reset to 1s)...
      expect(eventCalls()).toBe(2);
      await vi.advanceTimersByTimeAsync(500); // t≈3305: reconnected after ~2s more
      expect(eventCalls()).toBe(3);
      await vi.advanceTimersByTimeAsync(4200); // third gap ~4s
      expect(eventCalls()).toBe(4);
      sync.stop();
    } finally { vi.useRealTimers(); }
  });

  it('applies local events optimistically and dedupes the journal echo', async () => {
    vi.useFakeTimers();
    try {
      const { client } = fakeClient(detailFixture(), [
        [{ id: 1, type: 'message', sessionId: 's1', data: { id: 'm1', sessionId: 's1', role: 'user', content: 'hi', createdAt: 2 } }],
      ]);
      const sync = new SessionSync(client, 's1');
      sync.start();
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);
      expect(sync.getState().detail?.messages).toHaveLength(1);
      sync.apply({ id: 1, type: 'message', sessionId: 's1', data: { id: 'm1', sessionId: 's1', role: 'user', content: 'REPLAYED', createdAt: 2 } });
      await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);
      // Same event ID: the reducer drops it, content is unchanged.
      expect(sync.getState().detail?.messages[0]?.content).toBe('hi');
      sync.stop();
    } finally { vi.useRealTimers(); }
  });
});
