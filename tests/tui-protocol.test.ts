import { describe, expect, it } from 'vitest';
import { SseParser, parseSlash, summarizeArgs, terminalText, clip } from '../tui/protocol';
import { applyEvent } from '../shared/events';
import type { RunEvent, SessionDetail } from '../shared/types';

describe('SseParser', () => {
  it('parses a complete frame with id and data', () => {
    const parser = new SseParser();
    expect(parser.push('id: 7\ndata: {"type":"done"}\n\n')).toEqual([{ id: 7, data: '{"type":"done"}' }]);
  });
  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const parser = new SseParser();
    const wire = 'id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b":2}\n\n';
    const frames = [];
    for (const char of wire) frames.push(...parser.push(char));
    expect(frames).toEqual([{ id: 1, data: '{"a":1}' }, { id: 2, data: '{"b":2}' }]);
  });
  it('drops comment frames such as heartbeats and the connected marker', () => {
    const parser = new SseParser();
    expect(parser.push(': connected\n\n: heartbeat\n\n')).toEqual([]);
  });
  it('joins multiple data lines with newlines per the SSE spec', () => {
    const parser = new SseParser();
    expect(parser.push('data: first\ndata: second\n\n')).toEqual([{ data: 'first\nsecond' }]);
  });
  it('keeps a partial frame buffered until its terminator arrives', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"pend')).toEqual([]);
    expect(parser.push('ing":true}\n\n')).toEqual([{ data: '{"pending":true}' }]);
  });
  it('ignores a malformed id but keeps the data', () => {
    const parser = new SseParser();
    expect(parser.push('id: abc\ndata: x\n\n')).toEqual([{ data: 'x' }]);
  });
});

describe('parseSlash', () => {
  it('parses a bare command and lowercases the name', () => {
    expect(parseSlash('/HELP')).toEqual({ name: 'help', args: '' });
  });
  it('keeps everything after the first token as trimmed args', () => {
    expect(parseSlash('/steer  focus on the tests ')).toEqual({ name: 'steer', args: 'focus on the tests' });
  });
  it('returns null for plain messages, a lone slash, and paths', () => {
    expect(parseSlash('hello world')).toBeNull();
    expect(parseSlash('/')).toBeNull();
    expect(parseSlash('/usr/bin/env')).toBeNull();
  });
  it('allows hyphenated names', () => {
    expect(parseSlash('/resume-queue')).toEqual({ name: 'resume-queue', args: '' });
  });
});

describe('summarizeArgs', () => {
  it('prefers well-known string keys over JSON', () => {
    expect(summarizeArgs({ command: 'ls -la', timeout: 5 })).toBe('ls -la');
    expect(summarizeArgs({ file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts');
  });
  it('falls back to compact JSON and clips long values', () => {
    expect(summarizeArgs({ flag: true })).toBe('{"flag":true}');
    expect(summarizeArgs({ command: 'x'.repeat(300) })).toHaveLength(120);
  });
  it('escapes control characters so tool args cannot move the cursor', () => {
    expect(summarizeArgs({ command: 'evil[2Jcmd' })).toBe('evil\\u001b[2Jcmd');
  });
  it('returns empty for missing or empty args', () => {
    expect(summarizeArgs(undefined)).toBe('');
    expect(summarizeArgs({})).toBe('');
  });
});

describe('terminal text and clipping', () => {
  it('escapes C0 controls and keeps newlines only in multiline mode', () => {
    expect(terminalText('ab\nc')).toBe('a\\u0007b\\u000ac');
    expect(terminalText('a\nb\tc', true)).toBe('a\nb\tc');
  });
  it('clip keeps short strings and ellipsizes long ones', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('0123456789X', 10)).toBe('012345678…');
  });
});

describe('event reducer through the shared module', () => {
  const base = (): SessionDetail => ({
    session: { id: 's1', title: 'T', workspace: '/w', model: 'm', providerId: 'p', mode: 'build', permissionMode: 'ask', createdAt: 0, updatedAt: 0, status: 'running', archived: false },
    messages: [{ id: 'a1', sessionId: 's1', role: 'assistant', content: '', createdAt: 0 }],
    todos: [], permissions: [], lastEventId: 0,
  });
  const event = (id: number, type: RunEvent['type'], data: unknown): RunEvent => ({ id, type, sessionId: 's1', data });

  it('appends streamed deltas and dedupes replayed event ids', () => {
    let detail = applyEvent(base(), event(1, 'delta', { messageId: 'a1', delta: 'Hel' }));
    detail = applyEvent(detail, event(2, 'delta', { messageId: 'a1', delta: 'lo' }));
    detail = applyEvent(detail, event(2, 'delta', { messageId: 'a1', delta: 'lo' }));
    expect(detail.messages[0].content).toBe('Hello');
    expect(detail.lastEventId).toBe(2);
  });
  it('tracks tool call status transitions inside the owning message', () => {
    let detail = applyEvent(base(), event(1, 'tool', { messageId: 'a1', tool: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'running' } }));
    detail = applyEvent(detail, event(2, 'tool', { messageId: 'a1', tool: { id: 't1', name: 'bash', args: { command: 'ls' }, status: 'completed', output: 'ok' } }));
    expect(detail.messages[0].toolCalls).toHaveLength(1);
    expect(detail.messages[0].toolCalls?.[0]).toMatchObject({ status: 'completed', output: 'ok' });
  });
  it('moves the session through waiting on permission and idle on done', () => {
    let detail = applyEvent(base(), event(1, 'permission', { id: 'perm1', sessionId: 's1', toolCallId: 't1', tool: 'bash', args: {}, description: 'Run ls' }));
    expect(detail.session.status).toBe('waiting');
    expect(detail.permissions).toHaveLength(1);
    detail = applyEvent(detail, event(2, 'permission_resolved', { id: 'perm1', decision: 'allow' }));
    expect(detail.permissions).toHaveLength(0);
    detail = applyEvent(detail, event(3, 'done', { status: 'completed' }));
    expect(detail.session.status).toBe('idle');
  });
});
