import { describe, expect, it } from 'vitest';
import type { Message, SessionDetail } from '../shared/types.js';
import { conversationGroups, usageLabel, usageDetails } from '../tui/conversation.js';
const message = (id: string, extra: Partial<Message>): Message => ({ id, sessionId: 'root', role: 'assistant', content: id, createdAt: 1, ...extra });
function detail(messages: Message[], status = 'idle'): SessionDetail { return { session: { id: 'root', status, model: 'new-model', mode: 'plan' }, messages, permissions: [], todos: [] } as unknown as SessionDetail; }
describe('terminal conversation parity', () => {
  it('groups multi-request turns once across system notices and exposes one family usage footer', () => {
    const messages = [message('u', { role: 'user', turnId: 't' }), message('a', { turnId: 't', usage: { inputTokens: 10, outputTokens: 2 }, toolCalls: [] }), message('notice', { role: 'system', turnId: 't' }), message('b', { turnId: 't', turnUsage: { inputTokens: 110, outputTokens: 12, requests: 2, reportedRequests: 2, breakdown: [] } })];
    const groups = conversationGroups(detail(messages));
    expect(groups.filter(group => group.startsRun)).toHaveLength(1);
    expect(groups.filter(group => group.footer)).toHaveLength(1);
    expect(groups[1].steps.map(step => step.id)).toEqual(['a', 'b']);
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
