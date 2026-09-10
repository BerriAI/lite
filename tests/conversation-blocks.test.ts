import { describe, expect, it } from 'vitest';
import { conversationBlocks } from '../client/src/conversation-blocks';
import { workerLabels } from '../client/src/worker-presentation';
import type { Message, SessionDetail, ToolCall } from '../shared/types';

const call = (id: string, name = 'read_file'): ToolCall => ({ id, name, args: { path: 'README.md' }, status: 'completed' });
const message = (id: string, patch: Partial<Message> = {}): Message => ({ id, sessionId: 'root', role: 'assistant', content: '', createdAt: 1, ...patch });

describe('web conversation reading boundaries', () => {
  it('combines tool-only rounds under their introduction and keeps later prose separate', () => {
    const messages = [message('intro', { content: 'Inspecting files.', toolCalls: [call('a')] }), message('second', { toolCalls: [call('b'), call('c')] }), message('answer', { content: 'Here are the findings.' })];
    const blocks = conversationBlocks(messages);
    expect(blocks.map(block => block.message.id)).toEqual(['intro', 'answer']);
    expect(blocks[0].steps.flatMap(step => step.toolCalls ?? [])).toHaveLength(3);
    expect(blocks[0].endsRun).toBe(false); expect(blocks[1].endsRun).toBe(true);
    expect(messages[0].toolCalls).toHaveLength(1);
  });

  it('preserves user, system, turn, and error boundaries', () => {
    const messages = [message('first', { toolCalls: [call('a')] }), message('steer', { role: 'system', content: '[Steering] Check tests too.' }), message('second', { toolCalls: [call('b')] }), message('error', { error: 'Connection lost.' }), message('user', { role: 'user', content: 'Continue.' }), message('next', { turnId: 'next-turn', toolCalls: [call('c')] })];
    expect(conversationBlocks(messages).map(block => block.message.id)).toEqual(messages.map(item => item.id));
  });

  it('keeps the live block identity as more rounds arrive and carries final usage', () => {
    const first = message('first', { toolCalls: [call('a')] });
    const next = message('next', { toolCalls: [call('b')], usage: { inputTokens: 10, outputTokens: 5 } });
    const blocks = conversationBlocks([first, next]);
    expect(blocks).toHaveLength(1); expect(blocks[0].message.id).toBe('first');
    expect(blocks[0]).toMatchObject({ endsRun: true, closesTranscript: true, runUsage: { inputTokens: 10, outputTokens: 5 } });
  });
});

describe('worker identities', () => {
  it.each(['team-fusion', 'expert-fusion'] as const)('numbers every requested %s call, including queued calls and repeated provider ids', kind => {
    const detail = { session: { id: 'root', architecture: { kind } }, messages: [message('first', { toolCalls: [{ ...call('a', 'delegate'), status: 'running' }, { ...call('b', 'delegate'), status: 'pending' }] }), message('second', { toolCalls: [call('a', 'delegate')] })], delegations: [] } as unknown as SessionDetail;
    const role = kind === 'expert-fusion' ? 'Expert' : 'Worker';
    expect([...workerLabels(detail)]).toEqual([['first:a', `${role} 1`], ['first:b', `${role} 2`], ['second:a', `${role} 3`]]);
    detail.messages[0].toolCalls![1].status = 'completed';
    expect(workerLabels(detail).get('first:b')).toBe(`${role} 2`);
    detail.messages.push(message('user', { role: 'user', content: 'Next assignment.' }), message('third', { toolCalls: [call('a', 'delegate')] }));
    expect(workerLabels(detail).get('third:a')).toBe(`${role} 1`);
  });
});
