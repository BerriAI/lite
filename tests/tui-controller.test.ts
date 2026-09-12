import { describe, expect, it, vi } from 'vitest';
import type { SessionDetail, PermissionRequest } from '../shared/types.js';
import { TerminalController } from '../tui/controller.js';
import type { LitespeedClient } from '../tui/client.js';
import type { SessionSync } from '../tui/sync.js';
import { ApiError } from '../tui/client.js';

function harness(status: 'idle' | 'running' = 'idle') {
  const detail = { session: { id: 'parent', configRevision: 7, status }, messages: [], permissions: [], todos: [], queue: { items: [], paused: false }, lastEventId: 0 } as unknown as SessionDetail;
  const client = { base: 'http://localhost:1', api: vi.fn().mockResolvedValue({}) };
  const sync = { sessionId: 'parent', start: vi.fn(), stop: vi.fn(), subscribe: vi.fn(() => () => {}), getState: () => ({ phase: 'ready', detail, error: null }), refresh: vi.fn().mockResolvedValue(undefined) };
  const storage = { load: () => ({ text: '', attachments: [] }), save: vi.fn(), remember: vi.fn() };
  const controller = new TerminalController(client as unknown as LitespeedClient, sync as unknown as SessionSync, storage);
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

describe('terminal queued input', () => {
  function queued() {
    const fixture=harness('running');
    fixture.detail.queue!.items=['first','second'].map((content,index)=>({id:`q${index}`,sessionId:'parent',content,attachments:[{name:`${content}.txt`,content:`${content} snapshot`}],createdAt:index}));
    fixture.client.api.mockResolvedValue({items:fixture.detail.queue!.items});
    return fixture;
  }
  it('interrupts the displayed turn and leaves draft input untouched',async()=>{
    const {controller,client,detail}=harness('running');
    detail.messages=[{id:'turn',sessionId:'parent',role:'user',content:'Current work',createdAt:1}];
    await controller.interrupt();expect(client.api.mock.calls).toEqual([['/sessions/parent/interrupt',{turnId:'turn'}]]);
    expect(controller.getState().draft.text).toBe('my unsent work');
  });
  it('recalls all queued input ahead of the current draft, preserving attachments',async()=>{
    const {controller,client}=queued();
    controller.setDraft({text:'draft',attachments:[{name:'draft.txt',content:'draft context'}]});
    expect(await controller.recallQueued()).toBe(true);
    expect(client.api.mock.calls).toEqual([['/sessions/parent/queue/recall',{ids:['q0','q1']}]]);
    expect(controller.getState().draft).toEqual({text:'first\nsecond\ndraft',attachments:[{name:'first.txt',content:'first snapshot'},{name:'second.txt',content:'second snapshot'},{name:'draft.txt',content:'draft context'}]});
  });
  it('keeps newer typing and prevents sending or switching during recall',async()=>{
    const {controller,client,detail}=queued();let resolve!:(value:unknown)=>void;
    client.api.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const recall=controller.recallQueued();expect(await controller.send()).toBe(false);
    await expect(controller.open('other')).rejects.toThrow('Wait');
    expect(await controller.recallQueued()).toBe(false);
    controller.setDraft({text:'newer typing',attachments:[]});resolve({items:detail.queue!.items});
    expect(await recall).toBe(true);expect(controller.getState().draft.text).toBe('first\nsecond\nnewer typing');expect(client.api).toHaveBeenCalledTimes(1);
  });
  it('keeps the draft untouched when the queue changed before recall',async()=>{
    const {controller,client}=queued();client.api.mockRejectedValue(new ApiError('Queued messages changed.',409));
    expect(await controller.recallQueued()).toBe(false);
    expect(controller.getState().draft.text).toBe('my unsent work');expect(controller.getState().notice).toContain('changed');
  });
  it('keeps a visible recovery copy if the recall response is lost',async()=>{
    const {controller,client}=queued();client.api.mockRejectedValue(new TypeError('Network disconnected'));
    expect(await controller.recallQueued()).toBe(false);
    expect(controller.getState().draft.text).toBe('first\nsecond\nmy unsent work');expect(controller.getState().notice).toContain('review /queue before resending');
    expect(client.api).toHaveBeenCalledTimes(1);
  });
  it('refuses an oversized combined draft and permits editing one queued message',async()=>{
    const {controller,client,detail}=queued();detail.queue!.items[0].attachments=Array.from({length:10},(_,index)=>({name:`${index}.txt`,content:'context'}));
    expect(await controller.recallQueued()).toBe(false);expect(client.api).not.toHaveBeenCalled();
    client.api.mockResolvedValue({items:[detail.queue!.items[0]]});
    expect(await controller.recallQueued('q0')).toBe(true);
    expect(client.api.mock.calls).toEqual([['/sessions/parent/queue/recall',{ids:['q0']}]]);expect(controller.getState().draft.attachments).toHaveLength(10);
  });
});

describe('terminal skill activation', () => {
  const catalog = { revision: 'revision', skills: [{ id: 'verify', name: 'Verify', description: '' }], profiles: [], diagnostics: [] };
  it('pins a skill with the current profile and revision, without changing mode or model', async () => {
    const { controller, client, detail } = harness();
    detail.session.workspace = '/workspace';
    detail.session.profile = { profileId: 'review', skillIds: [], revision: 'revision', tools: ['read_file'] };
    client.api.mockResolvedValueOnce(catalog).mockResolvedValueOnce({});
    controller.setDraft({ text: '/verify', attachments: [{ name: 'keep', content: 'attachment' }] });
    expect(await controller.activateSkill('verify')).toBe(true);
    expect(client.api.mock.calls).toEqual([
      ['/profiles?workspace=%2Fworkspace'],
      ['/sessions/parent/profile', { expectedConfigRevision: 7, choice: { profileId: 'review', skillIds: ['verify'], catalogRevision: 'revision' } }],
    ]);
    expect(controller.getState().draft).toEqual({ text: '', attachments: [{ name: 'keep', content: 'attachment' }] });
    expect(controller.getState().notice).toContain('paused');
  });
  it('refuses changed pinned sources and keeps the draft', async () => {
    const { controller, client, detail } = harness();
    detail.session.profile = { profileId: 'review', skillIds: [], revision: 'old', tools: ['read_file'] };
    client.api.mockResolvedValue(catalog);
    expect(await controller.activateSkill('verify')).toBe(false);
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(controller.getState().notice).toContain('/skills');
    expect(controller.getState().draft.text).toBe('my unsent work');
  });
  it('does not activate while running or resend already-active skills', async () => {
    const { controller, client, detail } = harness('running');
    await expect(controller.activateSkill('verify')).rejects.toThrow('Finish');
    expect(client.api).not.toHaveBeenCalled();
    detail.session.status = 'idle';
    detail.session.profile = { profileId: null, skillIds: ['verify'], revision: 'old', tools: null };
    expect(await controller.activateSkill('verify')).toBe(true);
    expect(client.api).not.toHaveBeenCalled();
  });
  it('holds the configuration lock during lookup and preserves a newer draft', async () => {
    const { controller, client } = harness();
    let resolve!: (value: unknown) => void;
    client.api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = controller.activateSkill('verify');
    await expect(controller.open('other')).rejects.toThrow('Wait');
    controller.setDraft({ text: 'new draft', attachments: [] });
    resolve(catalog); await pending;
    expect(controller.getState().draft.text).toBe('new draft');
  });
});
