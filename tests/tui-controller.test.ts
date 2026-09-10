import { describe, expect, it, vi } from 'vitest';
import type { SessionDetail, PermissionRequest } from '../shared/types.js';
import { TerminalController } from '../tui/controller.js';
import type { LiteClient } from '../tui/client.js';
import type { SessionSync } from '../tui/sync.js';

function harness(status: 'idle' | 'running' = 'idle') {
  const detail = { session: { id: 'parent', configRevision: 7, status }, messages: [], permissions: [], todos: [], queue: { items: [], paused: false }, lastEventId: 0 } as unknown as SessionDetail;
  const client = { base: 'http://localhost:1', api: vi.fn().mockResolvedValue({}) };
  const sync = { sessionId: 'parent', start: vi.fn(), stop: vi.fn(), subscribe: vi.fn(() => () => {}), getState: () => ({ phase: 'ready', detail, error: null }), refresh: vi.fn().mockResolvedValue(undefined) };
  const storage = { load: () => ({ text: '', attachments: [] }), save: vi.fn(), remember: vi.fn() };
  const controller = new TerminalController(client as unknown as LiteClient, sync as unknown as SessionSync, storage);
  controller.setDraft({ text: 'my unsent work', attachments: [] });
  return { controller, client, sync, storage, detail };
}

describe('terminal task controller', () => {
  it('preserves draft on rejection, exposes error, and never retries the mutation', async () => {
    const { controller, client } = harness(); client.api.mockRejectedValue(new Error('503 temporarily unavailable'));
    expect(await controller.send()).toBe(false);
    expect(controller.getState().draft.text).toBe('my unsent work');
    expect(controller.getState().notice).toContain('503');
    expect(client.api).toHaveBeenCalledTimes(1);
  });
  it('guards double Enter and clears only the accepted draft', async () => {
    const { controller, client } = harness();
    let accept!: () => void; client.api.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
    const first = controller.send();
    expect(await controller.send()).toBe(false);
    expect(client.api).toHaveBeenCalledTimes(1);
    controller.setDraft({ text: 'typed while the request was pending', attachments: [] });
    accept(); expect(await first).toBe(true);
    expect(controller.getState().draft.text).toBe('typed while the request was pending');
    expect(controller.getState().pending).toBeNull();
  });
  it('does not turn an accepted request into a resend after refresh or storage failure', async () => {
    const { controller, client, sync, storage } = harness();
    sync.refresh.mockRejectedValue(new Error('offline'));
    storage.remember.mockImplementation(() => { throw new Error('disk full'); });
    expect(await controller.send()).toBe(true);
    expect(controller.getState().draft.text).toBe('');
    expect(controller.getState().notice).toContain('accepted');
    expect(client.api).toHaveBeenCalledTimes(1);
  });
  it('queues follow-ups during work and steers only text while running', async () => {
    const { controller, client } = harness('running');
    await controller.send(); expect(client.api.mock.calls[0][0]).toBe('/sessions/parent/queue');
    controller.setDraft({ text: 'focus on tests', attachments: [] });
    await controller.send('steer'); expect(client.api.mock.calls[1]).toEqual(['/sessions/parent/steer', { content: 'focus on tests' }]);
    controller.setDraft({ text: 'attachment', attachments: [{ name: 'x', content: 'x' }] });
    expect(await controller.send('steer')).toBe(false); expect(client.api).toHaveBeenCalledTimes(2);
  });
  it('keeps paused queue ordering while idle and refuses a full queue', async () => {
    const { controller, client, detail } = harness();
    detail.queue = { paused: true, items: [{ id: 'q' } as any] };
    await controller.send(); expect(client.api.mock.calls[0][0]).toBe('/sessions/parent/queue');
    controller.setDraft({ text: 'full', attachments: [] }); detail.queue.items = Array.from({ length: 20 }, () => ({ id: 'q' } as any));
    expect(await controller.send()).toBe(false); expect(controller.getState().draft.text).toBe('full');
  });
  it('uses the real cancel endpoint and the root session for child approvals', async () => {
    const { controller, client } = harness('running');
    await controller.cancel(); expect(client.api.mock.calls[0][0]).toBe('/sessions/parent/cancel');
    await controller.decide({ id: 'approval', sessionId: 'child' } as PermissionRequest, 'deny');
    expect(client.api.mock.calls[1]).toEqual(['/sessions/parent/permissions/approval', { decision: 'deny' }]);
  });
  it('saves configuration with the opened revision and disallows switching during submission', async () => {
    const { controller, client } = harness();
    await controller.configure({ model: 'new-model' }, 4);
    expect(client.api.mock.calls[0]).toEqual(['/sessions/parent', { model: 'new-model', expectedConfigRevision: 4 }, 'PATCH']);
    let accept!: () => void; client.api.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
    const send = controller.send();
    await expect(controller.open('other')).rejects.toThrow('Wait');
    accept(); await send;
  });
});
