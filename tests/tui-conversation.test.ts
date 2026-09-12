import { describe, expect, it } from 'vitest';
import type { DelegationSummary, Message, SessionDetail } from '../shared/types.js';
import { activityActors, activitySections, conversationGroups, taskInvocations, usageLabel, usageDetails } from '../tui/conversation.js';
import { steeringContent } from '../shared/steering-presentation.js';
const message = (id: string, extra: Partial<Message>): Message => ({ id, sessionId: 'root', role: 'assistant', content: id, createdAt: 1, ...extra });
function detail(messages: Message[], status = 'idle'): SessionDetail { return { session: { id: 'root', status, model: 'new-model', mode: 'plan' }, messages, permissions: [], todos: [] } as unknown as SessionDetail; }
describe('current task sidebar', () => {
  const task = (id: string, child: string, turn: string, createdAt: number, status: DelegationSummary['status'] = 'completed'): DelegationSummary => ({ id, childSessionId: child, parentSessionId: 'root', parentTurnId: turn, parentMessageId: id, toolCallId: id, description: id, status, createdAt });
  it('shows only the latest checklist for a reused Sidekick, without deleting its handoff history', () => {
    const session = detail([message('turn', { role: 'user' })]);
    session.delegations = [task('latest', 'sidekick', 'turn', 3), task('first', 'sidekick', 'turn', 1), task('second', 'sidekick', 'turn', 2)];
    expect(taskInvocations(session).map(task => task.id)).toEqual(['latest']);
    expect(session.delegations).toHaveLength(3);
  });
  it('keeps separate workers and prioritizes running work, including an active earlier turn', () => {
    const session = detail([message('turn', { role: 'user' })]);
    session.delegations = [task('old', 'old-worker', 'earlier', 1), task('alpha', 'worker-a', 'turn', 2), task('beta', 'worker-b', 'turn', 3, 'running'), task('background', 'worker-c', 'earlier', 0, 'running')];
    expect(taskInvocations(session).map(task => task.id)).toEqual(['background', 'beta', 'alpha']);
  });
});
describe('terminal conversation parity', () => {
  it('exposes steering as user content without mutating its delivered system message', () => {
    const messages = [message('steer', { role: 'system', content: '[Steering] The user sent this note to the running response. Update the ongoing task using this latest instruction: follow the latest plan' }), message('u', { role: 'user', content: 'ordinary question' })];
    const groups = conversationGroups(detail(messages));
    expect(groups).toHaveLength(2);
    expect(groups[0].message.role).toBe('system');
    expect(steeringContent(groups[0].message)).toBe('follow the latest plan');
    expect(groups[0].message.content).toContain('[Steering]');
  });
  it('groups multi-request turns once across system notices and exposes one family usage footer', () => {
    const messages = [message('u', { role: 'user', turnId: 't' }), message('a', { turnId: 't', usage: { inputTokens: 10, outputTokens: 2 }, toolCalls: [] }), message('notice', { role: 'system', turnId: 't' }), message('b', { turnId: 't', turnUsage: { inputTokens: 110, outputTokens: 12, requests: 2, reportedRequests: 2, breakdown: [] } })];
    const groups = conversationGroups(detail(messages));
    expect(groups.filter(group => group.startsRun)).toHaveLength(1);
    expect(groups.filter(group => group.footer)).toHaveLength(1);
    expect(groups[1].steps.map(step => step.id)).toEqual(['a']);
    expect(groups.at(-1)?.steps.map(step => step.id)).toEqual(['b']);
    expect(groups.at(-1)?.runUsage?.inputTokens).toBe(110);
    expect(groups.some(group => group.message.id === 'notice')).toBe(true);
  });
  it('withholds current turn usage until the whole turn settles', () => {
    const messages = [message('a', { turnId: 't', usage: { inputTokens: 10, outputTokens: 2 } }), message('n', { role: 'system', turnId: 't' })];
    expect(conversationGroups(detail(messages, 'running')).filter(group => group.footer)).toHaveLength(0);
    expect(conversationGroups(detail(messages, 'waiting')).filter(group => group.footer)).toHaveLength(0);
  });
  it('uses historical routing, preserves unreported usage, and distinguishes worker costs', () => {
    const m = message('a', { context: { model: 'old-driver' } as Message['context'], turnUsage: { inputTokens: 12, outputTokens: 4, requests: 2, reportedRequests: 1, breakdown: [{ id: 'r', rootSessionId: 'root', sessionId: 'child', turnId: 't', role: 'expert', providerId: 'fixture', model: 'strong', phase: 'response', usage: { inputTokens: 12, outputTokens: 4 } }, { id: 'r2', rootSessionId: 'root', sessionId: 'root', turnId: 't', role: 'driver', providerId: 'fixture', model: 'old-driver', phase: 'response' }] } });
    expect(usageLabel(m, m.turnUsage)).toBe('old-driver + expert · 16 tokens reported · Cache unavailable');
    expect(usageDetails(m, m.turnUsage)).toContain('expert · fixture/strong');
    expect(usageDetails(m, m.turnUsage)).toContain('Usage not reported');
    expect(usageDetails(m, m.turnUsage)).not.toContain('$0');
  });
});

describe('agent activity sections', () => {
  it('preserves Driver → Sidekick → Driver order within one consecutive group of tools', () => {
    const before = { id: 'read', name: 'read_file', args: { path: 'a.ts' }, status: 'completed' as const };
    const sidekick = { id: 'child', name: 'sidekick', args: {}, status: 'completed' as const };
    const after = { id: 'check', name: 'bash', args: { command: 'npm test' }, status: 'completed' as const };
    const steps = [message('a', { content: '', reasoning: 'Driver first reasoning.', toolCalls: [before, sidekick] }), message('b', { content: '', reasoning: 'Driver reviews the result.', toolCalls: [after] })];
    const sections = activitySections(steps, activityActors(detail(steps)));
    expect(sections.map(section => section.kind)).toEqual(['driver', 'worker', 'driver']);
    expect(sections[1]).toMatchObject({ label: 'Sidekick', call: sidekick });
    expect(sections[0]).toMatchObject({ entries: [{ call: before }] });
    expect(sections[2]).toMatchObject({ entries: [{ message: steps[1] }, { call: after }] });
    expect(sections.flatMap(section => section.kind === 'driver' ? section.entries.filter(entry => !entry.call) : [])).toHaveLength(1);
  });
  it.each(['team-fusion', 'expert-fusion'] as const)('keeps separate numbered agents before, during and after %s assignments', kind => {
    const steps = [message('a', { content: '', toolCalls: [1, 2].map(n => ({ id: `worker-${n}`, name: 'delegate', args: {}, status: 'pending' })) })];
    const session = detail(steps);
    session.session.architecture = { kind, ...(kind === 'team-fusion' ? { worker: { providerId: 'fixture', model: 'fast' } } : { expert: { providerId: 'fixture', model: 'strong' } }) } as SessionDetail['session']['architecture'];
    const expected = kind === 'team-fusion' ? ['Worker 1', 'Worker 2'] : ['Expert 1', 'Expert 2'];
    for (const status of ['pending', 'running', 'completed'] as const) {
      for (const call of steps[0].toolCalls!) call.status = status;
      expect(activitySections(steps, activityActors(session)).map(section => section.kind === 'worker' && section.label)).toEqual(expected);
    }
  });
});
