import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { boundedWithReceipt, executeTool, executeToolOutputPage, isReadOnlyTool, toolOutputPageTool, type ToolContext } from '../server/tools.js';
import type { Todo } from '../shared/types.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** 100KB+ mixed-width content: ASCII, 2-byte, 3-byte and 4-byte sequences interleaved. */
function multibyteContent(targetBytes: number): string {
  const unit = 'line α β 漢字 😀🎈 mixed-width content\n'; // ASCII + Greek + CJK + emoji
  let value = '';
  while (Buffer.byteLength(value) < targetBytes) value += unit;
  return value;
}
function pageAll(store: Store, sessionId: string, callId: string, limit = 8192): { chunks: Buffer[]; headers: string[] } {
  const chunks: Buffer[] = [];
  const headers: string[] = [];
  let offset = 0;
  for (let iteration = 0; iteration < 1000; iteration++) {
    const page = executeToolOutputPage(store, sessionId, { call_id: callId, offset, limit });
    const newline = page.indexOf('\n');
    headers.push(page.slice(0, newline));
    const next = /\n\[next_offset: (\d+)\]$/.exec(page);
    const body = page.slice(newline + 1, next ? page.length - next[0].length : undefined);
    chunks.push(Buffer.from(body, 'utf8'));
    if (!next) return { chunks, headers };
    offset = Number(next[1]);
  }
  throw new Error('Paging did not terminate.');
}

describe('lossless tool-output paging', () => {
  let directory: string, store: Store, sessionId: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'speedrail-paging-'));
    store = new Store(directory);
    sessionId = store.createSession({ title: 'Paging' }).id;
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  it('reassembles the exact original through next_offset paging, with a matching sha256', () => {
    const original = multibyteContent(100 * 1024);
    store.saveToolOutput(sessionId, 'call-round-trip', original);
    const { chunks, headers } = pageAll(store, sessionId, 'call-round-trip');
    const reassembled = Buffer.concat(chunks);
    expect(reassembled.equals(Buffer.from(original, 'utf8'))).toBe(true);
    expect(reassembled.toString('utf8')).toBe(original);
    const total = Buffer.byteLength(original);
    const hash = sha256(original);
    for (const header of headers) expect(header).toContain(`of ${total} (sha256 ${hash})`);
    expect(headers[0].startsWith('bytes 0-')).toBe(true);
  });

  it('truncates executeTool results with a receipt naming total bytes, hash prefix and tool_output_page', async () => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'speedrail-paging-ws-')));
    try {
      let todos: Todo[] = [];
      const callId = 'call-bash-1';
      const context: ToolContext = {
        workspace, sessionId, signal: new AbortController().signal,
        onChange: () => {}, onTodos: value => { todos = value; }, getTodos: () => todos,
        saveToolOutput: content => store.saveToolOutput(sessionId, callId, content),
        callId,
      };
      const result = await executeTool('bash', { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("héllo-α😀 ".repeat(4000))'` }, context);
      const stored = store.toolOutput(sessionId, callId);
      expect(stored).toBeDefined();
      expect(Buffer.byteLength(stored!.content)).toBeGreaterThan(32_768);
      const total = Buffer.byteLength(stored!.content, 'utf8');
      const prefix = sha256(stored!.content).slice(0, 16);
      expect(result).toContain(`[Output truncated at 30000 characters of ${total} UTF-8 bytes (sha256 ${prefix}). Read the rest with tool_output_page, call_id "${callId}", starting at byte offset `);
      // The full pre-truncation output is recoverable byte-for-byte.
      const { chunks } = pageAll(store, sessionId, callId, 16_384);
      expect(Buffer.concat(chunks).toString('utf8')).toBe(stored!.content);
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });

  it('degrades to the plain lossy note when no persistence is wired', () => {
    const large = 'x'.repeat(40_000);
    expect(boundedWithReceipt({}, large)).toBe(`${large.slice(0, 32_768)}\n[Output truncated]`);
    expect(boundedWithReceipt({}, 'small')).toBe('small');
    expect(boundedWithReceipt({ saveToolOutput: () => { throw new Error('storage down'); } }, large)).toBe(`${large.slice(0, 32_768)}\n[Output truncated]`);
  });

  it('answers an offset beyond the end honestly with the total and no next_offset', () => {
    const content = 'short content';
    store.saveToolOutput(sessionId, 'call-short', content);
    const total = Buffer.byteLength(content);
    const page = executeToolOutputPage(store, sessionId, { call_id: 'call-short', offset: total + 500 });
    expect(page).toBe(`bytes ${total}-${total} of ${total} (sha256 ${sha256(content)})\n`);
    expect(page).not.toContain('next_offset');
  });

  it('never splits an emoji at a page boundary and still makes progress', () => {
    const content = '😀'.repeat(100); // 400 bytes of 4-byte sequences
    store.saveToolOutput(sessionId, 'call-emoji', content);
    // limit 6 lands mid-emoji: the end rounds down to a character boundary.
    const first = executeToolOutputPage(store, sessionId, { call_id: 'call-emoji', offset: 0, limit: 6 });
    expect(first).toContain('bytes 0-4 of 400');
    expect(first).toContain('😀');
    expect(first).not.toContain('�');
    expect(first).toContain('[next_offset: 4]');
    // An offset mid-character rounds up; a limit smaller than one character still returns one.
    const misaligned = executeToolOutputPage(store, sessionId, { call_id: 'call-emoji', offset: 5, limit: 1 });
    expect(misaligned).toContain('bytes 8-12 of 400');
    expect(misaligned).not.toContain('�');
    const { chunks } = pageAll(store, sessionId, 'call-emoji', 7);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
  });

  it('reports unknown call ids honestly', () => {
    expect(executeToolOutputPage(store, sessionId, { call_id: 'never-stored' }))
      .toBe('No stored output for that call in this session. Only truncated results from the last 200 tool calls are retained.');
  });

  it('retains only the newest 200 outputs per session', () => {
    for (let index = 0; index <= 200; index++) store.saveToolOutput(sessionId, `call-${index}`, `output ${index}`);
    expect(store.toolOutput(sessionId, 'call-0')).toBeUndefined();
    expect(store.toolOutput(sessionId, 'call-1')?.content).toBe('output 1');
    expect(store.toolOutput(sessionId, 'call-200')?.content).toBe('output 200');
    // Another session's retention is independent.
    const other = store.createSession({ title: 'Other' }).id;
    store.saveToolOutput(other, 'other-call', 'other output');
    expect(store.toolOutput(other, 'other-call')?.content).toBe('other output');
    expect(store.toolOutput(sessionId, 'call-1')?.content).toBe('output 1');
  });

  it('scopes read-back to the session that stored the output', () => {
    const other = store.createSession({ title: 'Other' }).id;
    store.saveToolOutput(other, 'call-private', 'private to other session');
    expect(store.toolOutput(sessionId, 'call-private')).toBeUndefined();
    expect(executeToolOutputPage(store, sessionId, { call_id: 'call-private' }))
      .toBe('No stored output for that call in this session. Only truncated results from the last 200 tool calls are retained.');
    // Deleting the owning session cascades its stored outputs away.
    store.deleteSession(other);
    expect(store.toolOutput(other, 'call-private')).toBeUndefined();
  });

  it('clamps the page limit to 16384 bytes and validates offset', () => {
    const content = 'a'.repeat(40_000);
    store.saveToolOutput(sessionId, 'call-clamp', content);
    const page = executeToolOutputPage(store, sessionId, { call_id: 'call-clamp', offset: 0, limit: 999_999 });
    expect(page).toContain('bytes 0-16384 of 40000');
    const floor = executeToolOutputPage(store, sessionId, { call_id: 'call-clamp', offset: 0, limit: -5 });
    expect(floor).toContain('bytes 0-1 of 40000');
    expect(() => executeToolOutputPage(store, sessionId, { call_id: 'call-clamp', offset: -1 })).toThrow(/offset/);
    expect(() => executeToolOutputPage(store, sessionId, { call_id: 'call-clamp', offset: 1.5 })).toThrow(/offset/);
    expect(() => executeToolOutputPage(store, sessionId, { call_id: '' })).toThrow(/call_id/);
  });

  it('caps stored content at 4 MiB with an explicit note, hashing exactly the stored bytes', () => {
    const cap = 4 * 1024 * 1024;
    const original = 'y'.repeat(cap + 100_000);
    store.saveToolOutput(sessionId, 'call-capped', original);
    const stored = store.toolOutput(sessionId, 'call-capped')!;
    expect(stored.content.endsWith('\n[Stored output capped at 4 MiB; the remainder was not retained.]')).toBe(true);
    expect(stored.content.startsWith('y'.repeat(1000))).toBe(true);
    expect(Buffer.byteLength(stored.content)).toBeLessThanOrEqual(cap + 128);
    expect(stored.sha256).toBe(sha256(Buffer.from(stored.content, 'utf8')));
  });

  it('declares tool_output_page as a separate read-only definition, not part of toolDefinitions', () => {
    expect(toolOutputPageTool.function.name).toBe('tool_output_page');
    expect(toolOutputPageTool.function.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(isReadOnlyTool('tool_output_page')).toBe(true);
  });
});
