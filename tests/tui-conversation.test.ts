import { describe, expect, it } from 'vitest';
import type { Message, SessionDetail } from '../shared/types.js';
import { activityActors, activitySections, conversationGroups, usageLabel, usageDetails } from '../tui/conversation.js';
const message = (id: string, extra: Partial<Message>): Message => ({ id, sessionId: 'root', role: 'assistant', content: id, createdAt: 1, ...extra });
function detail(messages: Message[], status = 'idle'): SessionDetail { return { session: { id: 'root', status, model: 'new-model', mode: 'plan' }, messages, permissions: [], todos: [] } as unknown as SessionDetail; }
describe('terminal conversation parity', () => {
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
    expect(usageLabel(m, m.turnUsage)).toBe('old-driver · 16 tokens reported');
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
