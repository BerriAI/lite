import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { assertReadablePath, executeTool, gitStatus, isReadOnlyTool, listFiles, parseSearchResults, readCommand, readFile, resetWebSearchCourtesy, resolveWorkspacePath, restoreChanges, searchFiles, toolDefinitions, viewImageTool, webSearchEndpoint, webSearchTool, type ToolContext } from '../server/tools.js';
import type { Attachment, FileChange, Todo } from '../shared/types.js';

const exec = promisify(execFile);
let temporary: string;
let workspace: string;
let outside: string;
let context: ToolContext;
let controller: AbortController;
let changes: FileChange[];
let todos: Todo[];

beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'litespeed-tools-')));
  workspace = path.join(temporary, 'workspace');
  outside = path.join(temporary, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  controller = new AbortController();
  changes = [];
  todos = [];
  context = { workspace, sessionId: 'test-session', signal: controller.signal, onChange: change => { changes.push(change); }, onTodos: value => { todos = value; }, getTodos: () => todos };
});
afterEach(async () => { controller.abort(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(temporary, { recursive: true, force: true }); });
async function put(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(workspace, filePath)), { recursive: true });
  await fs.writeFile(path.join(workspace, filePath), content);
}
const tool = (name: string, args: Record<string, unknown> = {}) => executeTool(name, args, context);

// Pure request doubles: no unit test connects to the network, even if URL checks
// regress. DNS is also replaced for every web_fetch test.
interface FakeResponse { status?: number; location?: string; type?: string; body?: string | Buffer; hang?: boolean }
function mockWeb(responses: FakeResponse[]) {
  const requests: { url: URL; options: http.RequestOptions }[] = [];
  const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  const handler = ((url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    requests.push({ url, options });
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
    const fixture = responses.shift();
    if (!fixture) throw new Error('Unexpected HTTP request in test.');
    response.statusCode = fixture.status ?? 200;
    response.headers = { 'content-type': fixture.type ?? 'text/plain', ...(fixture.location ? { location: fixture.location } : {}) };
    const abort = () => { request.emit('error', new Error('Aborted')); response.destroy(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    response.once('close', () => options.signal?.removeEventListener('abort', abort));
    request.end = () => queueMicrotask(() => {
      callback(response as unknown as http.IncomingMessage);
      if (!fixture.hang && !response.destroyed) response.end(fixture.body ?? 'Public text');
    });
    return request as unknown as http.ClientRequest;
  }) as typeof http.request;
  vi.spyOn(http, 'request').mockImplementation(handler);
  vi.spyOn(https, 'request').mockImplementation(handler as typeof https.request);
  return { requests, lookup };
}

describe('schemas and authorization classification', () => {
  it('exports ten concrete JSON-schema function tools and fails closed for unknown tools', async () => {
    expect(toolDefinitions.map(value => value.function.name).sort()).toEqual(['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'web_fetch', 'todo_write', 'todo_read', 'task'].sort());
    for (const definition of toolDefinitions) {
      expect(definition.type).toBe('function');
      expect(definition.function.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect(() => JSON.stringify(definition)).not.toThrow();
    }
    for (const name of ['read_file', 'glob', 'grep', 'web_fetch', 'web_search', 'view_image', 'todo_read']) expect(isReadOnlyTool(name)).toBe(true);
    for (const name of ['write_file', 'edit_file', 'bash', 'todo_write', 'task', 'unknown']) expect(isReadOnlyTool(name)).toBe(false);
    expect(toolDefinitions.find(definition => definition.function.name === 'bash')?.function.description).toContain('NOT SANDBOXED');
    await expect(tool('missing')).rejects.toThrow('Unknown tool');
  });
  it('validates runtime arguments and respects pre-existing cancellation', async () => {
    await expect(tool('read_file', { path: 123 })).rejects.toThrow('path');
    await expect(tool('read_file', { path: 'x', offset: 0 })).rejects.toThrow('offset');
    await expect(tool('bash', { command: 'true', timeout_ms: -1 })).rejects.toThrow('timeout_ms');
    controller.abort();
    await expect(tool('todo_write', { todos: [] })).rejects.toThrow(/cancel/i);
    expect(todos).toEqual([]);
  });
});

describe('workspace resolution and discovery', () => {
  it('resolves normal files, in-workspace symlinks and a symlinked workspace root', async () => {
    await put('nested/a.txt', 'safe');
    await fs.symlink(path.join(workspace, 'nested/a.txt'), path.join(workspace, 'alias.txt'));
    expect(await resolveWorkspacePath(workspace, './nested/a.txt')).toBe(path.join(workspace, 'nested/a.txt'));
    expect(await resolveWorkspacePath(workspace, 'alias.txt')).toBe(path.join(workspace, 'nested/a.txt'));
    const linkedRoot = path.join(temporary, 'linked');
    await fs.symlink(workspace, linkedRoot);
    expect(await resolveWorkspacePath(linkedRoot, 'nested/a.txt')).toBe(path.join(workspace, 'nested/a.txt'));
    expect((await readFile(linkedRoot, 'alias.txt')).content).toBe('safe');
  });
  it('rejects absolute, parent, and sibling-prefix escapes', async () => {
    await fs.writeFile(path.join(outside, 'secret'), 'not for tools');
    for (const filePath of ['../outside/secret', path.join(outside, 'secret'), `${workspace}-other/secret`]) {
      await expect(resolveWorkspacePath(workspace, filePath)).rejects.toThrow(/outside/);
      await expect(readFile(workspace, filePath)).rejects.toThrow(/outside/);
    }
    await expect(resolveWorkspacePath(workspace, 'a\0b')).rejects.toThrow(/Invalid/);
  });
  it('rejects external directory symlinks for reads and missing-parent writes', async () => {
    await fs.writeFile(path.join(outside, 'secret'), 'outside');
    await fs.symlink(outside, path.join(workspace, 'escape'));
    await expect(readFile(workspace, 'escape/secret')).rejects.toThrow(/outside/);
    await expect(resolveWorkspacePath(workspace, 'escape/new/deep/file', { allowMissing: true })).rejects.toThrow(/outside/);
    await expect(tool('write_file', { path: 'escape/new/deep/file', content: 'no' })).rejects.toThrow(/outside/);
    await expect(fs.stat(path.join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(changes).toEqual([]);
  });
  it('rejects dangling symlinks, even when allowMissing is enabled', async () => {
    await fs.symlink(path.join(outside, 'missing'), path.join(workspace, 'dangling'));
    await expect(resolveWorkspacePath(workspace, 'dangling', { allowMissing: true })).rejects.toThrow(/dangling/);
    await expect(tool('write_file', { path: 'dangling', content: 'no' })).rejects.toThrow(/dangling/);
    expect(await resolveWorkspacePath(workspace, 'new/deep/file', { allowMissing: true })).toBe(path.join(workspace, 'new/deep/file'));
  });
  it('excludes hidden paths, secrets, generated dirs, symlink escapes and loops', async () => {
    await put('src/main.ts', 'needle');
    await put('README.txt', 'needle');
    for (const file of ['.git/config', '.env', '.env.production', '.hidden/note', 'src/.env', 'node_modules/pkg/main.ts', 'dist/main.js', 'coverage/result.json', 'vendor/library.ts']) await put(file, 'secret needle');
    await fs.symlink(outside, path.join(workspace, 'escape'));
    await fs.symlink(workspace, path.join(workspace, 'loop'));
    await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'secret-alias'));
    const entries = await listFiles(workspace);
    expect(entries.some(entry => entry.name.startsWith('.'))).toBe(false);
    expect(entries.map(entry => entry.name)).not.toContain('escape');
    expect(entries.map(entry => entry.name)).not.toContain('secret-alias');
    expect(entries.find(entry => entry.name === 'src')).toMatchObject({ path: 'src', type: 'directory' });
    expect(await searchFiles(workspace, '')).toEqual(['README.txt', 'src/main.ts']);
    expect(await searchFiles(workspace, 'MAIN')).toEqual(['src/main.ts']);
    expect(await listFiles(workspace, '.git')).toEqual([]);
    expect(await tool('glob', { pattern: '**/*' })).toBe('README.txt\nsrc/main.ts');
    const result = await tool('grep', { pattern: 'needle' });
    expect(result).toContain('src/main.ts:1:needle');
    expect(result).not.toContain('secret');
    await expect(readFile(workspace, '.env')).rejects.toThrow(/Protected/);
  });
  it('blocks protected state, credentials, symlink aliases and hard links, but permits source dotfiles', async () => {
    const protectedFiles = ['.env', '.env.production', '.litespeed/auth.json', '.litespeed/state.sqlite', '.ssh/id_ed25519', 'id_rsa', 'private_key.pem'];
    for (const file of protectedFiles) {
      await put(file, 'SYNTHETIC_SECRET_NEVER_RETURN');
      await expect(readFile(workspace, file)).rejects.toThrow(/Protected/);
      await expect(assertReadablePath(workspace, file)).rejects.toThrow(/Protected/);
    }
    await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'alias.txt'));
    await fs.link(path.join(workspace, '.env'), path.join(workspace, 'hard-alias.txt'));
    await expect(readFile(workspace, 'alias.txt')).rejects.toThrow(/Protected/);
    await expect(readFile(workspace, 'hard-alias.txt')).rejects.toThrow(/Hard-linked/);
    expect(await tool('grep', { pattern: 'SYNTHETIC_SECRET' })).not.toContain('SYNTHETIC_SECRET_NEVER_RETURN');
    await put('.env.example', 'KEY=your-key');
    await put('.config/source.ts', 'source');
    await put('.litespeed/instructions.md', 'Project instructions');
    expect((await readFile(workspace, '.env.example')).content).toBe('KEY=your-key');
    expect((await readFile(workspace, '.config/source.ts')).content).toBe('source');
    expect((await readFile(workspace, '.litespeed/instructions.md')).content).toBe('Project instructions');
    expect(await assertReadablePath(workspace, path.join(workspace, '.litespeed/instructions.md'))).toBe(path.join(workspace, '.litespeed/instructions.md'));
  });
  it('bounds discovery results and rejects traversing glob patterns', async () => {
    await Promise.all(Array.from({ length: 205 }, (_, index) => put(`files/file-${String(index).padStart(3, '0')}.txt`, 'x')));
    expect((await searchFiles(workspace, 'file')).length).toBe(200);
    const result = await tool('glob', { pattern: '**/*.txt', limit: 2 });
    expect(result).toContain('files/file-000.txt');
    expect(result).toContain('[Results truncated');
    await expect(tool('glob', { pattern: '../*' })).rejects.toThrow(/relative/);
    await expect(tool('glob', { pattern: '/etc/*' })).rejects.toThrow(/relative/);
    await expect(tool('glob', { pattern: '**/*', path: '../outside' })).rejects.toThrow(/outside/);
  });
});

describe('file reads and reversible edits', () => {
  it('reads later line ranges beyond the original 256 KiB prefix with CRLF and UTF-8 intact', async () => {
    await put('beyond.txt', ('prefix '.repeat(100)+'\r\n').repeat(500)+'café 😀 target\r\nlast');
    expect(await tool('read_file', { path: 'beyond.txt', offset: 501, limit: 1 })).toBe('501\tcafé 😀 target\n[File truncated; request a narrower range or use grep.]');
    expect(await tool('read_file', { path: 'beyond.txt', offset: 502, limit: 1 })).toBe('502\tlast');
  });

  it('reads raw content through the API and numbered, paginated lines through the tool', async () => {
    await put('note.txt', 'one\r\ntwo\r\nthree\r\n');
    expect(await readFile(workspace, 'note.txt')).toEqual({ path: 'note.txt', content: 'one\r\ntwo\r\nthree\r\n' });
    expect(await tool('read_file', { path: 'note.txt', offset: 2, limit: 1 })).toBe('2\ttwo\n[File truncated; request a narrower range or use grep.]');
    await put('empty', '');
    expect(await tool('read_file', { path: 'empty' })).toBe('(Empty file)');
  });
  it('bounds large reads and rejects binary, invalid UTF-8, directories and FIFOs', async () => {
    await put('large', 'a'.repeat(400_000));
    const large = await readFile(workspace, 'large');
    expect(large.truncated).toBe(true);
    expect(large.content.length).toBeLessThanOrEqual(256 * 1024);
    expect((await tool('read_file', { path: 'large' })).length).toBeLessThan(33_000);
    await put('binary', Buffer.from([0, 1, 2, 3]));
    await put('invalid-utf8', Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(readFile(workspace, 'binary')).rejects.toThrow(/Binary/);
    await expect(readFile(workspace, 'invalid-utf8')).rejects.toThrow(/UTF-8/);
    await expect(readFile(workspace, '.')).rejects.toThrow(/regular file/);
    if (process.platform !== 'win32') {
      await exec('mkfifo', [path.join(workspace, 'pipe')]);
      await expect(readFile(workspace, 'pipe')).rejects.toThrow(/regular file/);
    }
  });
  it('does not corrupt UTF-8 at the truncation boundary or strip a BOM', async () => {
    await put('unicode', '﻿hello\n');
    expect((await readFile(workspace, 'unicode')).content).toBe('﻿hello\n');
    await put('unicode-large', 'a'.repeat(256 * 1024 - 1) + '😀tail');
    const large = await readFile(workspace, 'unicode-large');
    expect(large.truncated).toBe(true);
    expect(large.content).not.toContain('�');
  });
  it('creates missing parents and records exact before and after snapshots', async () => {
    await tool('write_file', { path: 'new/deep/file.txt', content: 'first\n' });
    expect(await fs.readFile(path.join(workspace, 'new/deep/file.txt'), 'utf8')).toBe('first\n');
    expect(changes).toEqual([{ path: 'new/deep/file.txt', before: null, after: 'first\n' }]);
    const result = await tool('write_file', { path: 'new/deep/file.txt', content: 'second\n' });
    expect(result).toContain('-first');
    expect(result).toContain('+second');
    expect(changes[1]).toEqual({ path: 'new/deep/file.txt', before: 'first\n', after: 'second\n' });
  });
  it('preserves CRLF, absent final newlines, permissions, and exact replacement semantics', async () => {
    await put('script', 'one\r\ntwo\r\nthree');
    await fs.chmod(path.join(workspace, 'script'), 0o755);
    await tool('edit_file', { path: 'script', old_string: 'one\ntwo', new_string: '$&\nreplaced' });
    expect(await fs.readFile(path.join(workspace, 'script'), 'utf8')).toBe('$&\r\nreplaced\r\nthree');
    expect((await fs.stat(path.join(workspace, 'script'))).mode & 0o777).toBe(0o755);
    await tool('write_file', { path: 'script', content: 'new\ntext\n' });
    expect(changes.at(-1)?.after).toBe('new\r\ntext\r\n');
  });
  it('requires unique nonempty exact matches and supports replace_all and deletion', async () => {
    await put('repeat', 'word word\n');
    await expect(tool('edit_file', { path: 'repeat', old_string: 'word', new_string: 'x' })).rejects.toThrow(/more than once/);
    await expect(tool('edit_file', { path: 'repeat', old_string: 'missing', new_string: 'x' })).rejects.toThrow(/not found/);
    await expect(tool('edit_file', { path: 'repeat', old_string: '', new_string: 'x' })).rejects.toThrow(/non-empty/);
    await expect(tool('edit_file', { path: 'repeat', old_string: 'word', new_string: 'x', replace_all: 'yes' })).rejects.toThrow(/boolean/);
    expect(changes).toEqual([]);
    await tool('edit_file', { path: 'repeat', old_string: 'word', new_string: 'x', replace_all: true });
    expect(changes[0].after).toBe('x x\n');
    await tool('edit_file', { path: 'repeat', old_string: 'x ', new_string: '' });
    expect(changes[1].after).toBe('x\n');
    expect(await tool('write_file', { path: 'repeat', content: 'x\n' })).toContain('No changes');
    expect(changes).toHaveLength(2);
    await put('overlap', 'aaa');
    await expect(tool('edit_file', { path: 'overlap', old_string: 'aa', new_string: 'b' })).rejects.toThrow(/more than once/);
  });
  it('allows an exact whitespace-only edit', async () => {
    await put('spaces', 'a  b');
    await tool('edit_file', { path: 'spaces', old_string: '  ', new_string: ' ' });
    expect(changes[0].after).toBe('a b');
  });
  it('forbids .git writes through direct paths and aliases, plus binary and oversized edits', async () => {
    await put('.git/config', 'git data');
    await fs.symlink(path.join(workspace, '.git'), path.join(workspace, 'git-alias'));
    await expect(tool('write_file', { path: '.git/new/file', content: 'no' })).rejects.toThrow(/\.git/);
    await expect(tool('edit_file', { path: 'git-alias/config', old_string: 'git', new_string: 'bad' })).rejects.toThrow(/\.git/);
    await put('binary', Buffer.from([0, 2, 3]));
    await expect(tool('write_file', { path: 'binary', content: 'text' })).rejects.toThrow(/Binary/);
    await put('large', 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(tool('write_file', { path: 'large', content: 'small' })).rejects.toThrow(/too large/);
    expect(changes).toEqual([]);
  });
  it('refuses to mutate hard-linked aliases outside the workspace', async () => {
    await fs.writeFile(path.join(outside, 'original'), 'outside');
    await fs.link(path.join(outside, 'original'), path.join(workspace, 'linked'));
    await expect(tool('write_file', { path: 'linked', content: 'changed' })).rejects.toThrow(/hard-linked/i);
    expect(await fs.readFile(path.join(outside, 'original'), 'utf8')).toBe('outside');
    expect(changes).toEqual([]);
  });
  it('awaits snapshot persistence and reports callback failure rather than claiming success', async () => {
    context.onChange = async () => { throw new Error('Snapshot persistence unavailable'); };
    await expect(tool('write_file', { path: 'persisted', content: 'value' })).rejects.toThrow('Snapshot persistence unavailable');
    expect(await fs.readFile(path.join(workspace, 'persisted'), 'utf8')).toBe('value');
  });
});

describe('safe command loading and undo', () => {
  it('reads bounded command text without allowing secret aliases or arbitrary state', async () => {
    await put('.litespeed/commands/review.md', '# Review\nCheck the changes.');
    expect(await readCommand(workspace, '.litespeed/commands/review.md')).toContain('Check the changes.');
    await put('.env', 'SYNTHETIC_SECRET');
    await put('.litespeed/token.md', 'SYNTHETIC_SECRET');
    await expect(readCommand(workspace, '.litespeed/token.md')).rejects.toThrow(/command/);
    await fs.symlink(path.join(workspace, '.env'), path.join(workspace, '.litespeed/commands/secret.md'));
    await expect(readCommand(workspace, '.litespeed/commands/secret.md')).rejects.toThrow(/protected/i);
    await fs.link(path.join(workspace, '.env'), path.join(workspace, '.litespeed/commands/hard.md'));
    await expect(readCommand(workspace, '.litespeed/commands/hard.md')).rejects.toThrow(/Hard-linked/);
    await put('.litespeed/commands/.env.md', 'SYNTHETIC_SECRET');
    await expect(readCommand(workspace, '.litespeed/commands/.env.md')).rejects.toThrow(/protected/i);
    await put('.litespeed/commands/large.md', 'x'.repeat(70_000));
    await expect(readCommand(workspace, '.litespeed/commands/large.md')).rejects.toThrow(/too large/);
    await put('.config/commands/review.md', 'source command');
    expect(await readCommand(workspace, '.config/commands/review.md')).toBe('source command');
  });
  it('restores replacements, creations and deletions with exact bytes and success callbacks', async () => {
    await put('edited', 'after\n');
    await fs.chmod(path.join(workspace, 'edited'), 0o755);
    await put('created', 'new');
    const snapshots: FileChange[] = [{ path: 'edited', before: 'before\r\n', after: 'after\n' }, { path: 'created', before: null, after: 'new' }, { path: 'missing/deleted', before: 'restored', after: null }];
    const restored: FileChange[] = [];
    await restoreChanges(workspace, snapshots, change => { restored.push(change); });
    expect(restored).toEqual(snapshots);
    expect(await fs.readFile(path.join(workspace, 'edited'), 'utf8')).toBe('before\r\n');
    expect((await fs.stat(path.join(workspace, 'edited'))).mode & 0o777).toBe(0o755);
    await expect(fs.stat(path.join(workspace, 'created'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(workspace, 'missing/deleted'), 'utf8')).toBe('restored');
  });
  it('preflights every file before mutating any, including protected and symlink targets', async () => {
    await put('first', 'after');
    await put('second', 'external change');
    const callback = vi.fn();
    await expect(restoreChanges(workspace, [{ path: 'first', before: 'before', after: 'after' }, { path: 'second', before: 'before', after: 'expected' }], callback)).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(workspace, 'first'), 'utf8')).toBe('after');
    expect(callback).not.toHaveBeenCalled();
    await fs.symlink(path.join(workspace, 'first'), path.join(workspace, 'alias'));
    await expect(restoreChanges(workspace, [{ path: 'alias', before: 'bad', after: 'after' }], callback)).rejects.toThrow(/Symlink/);
    for (const file of ['.env', '.git/config', '.litespeed/auth.json']) {
      await put(file, 'protected');
      await expect(restoreChanges(workspace, [{ path: file, before: 'bad', after: 'protected' }], callback)).rejects.toThrow(/Protected|\.git/);
    }
    await fs.link(path.join(workspace, 'first'), path.join(workspace, 'hard'));
    await expect(restoreChanges(workspace, [{ path: 'hard', before: 'bad', after: 'after' }], callback)).rejects.toMatchObject({ status: 409 });
  });
  it('detects intervening changes after preflight and only reports completed restores', async () => {
    await put('first', 'after');
    await put('second', 'after');
    const snapshots: FileChange[] = [{ path: 'first', before: 'before', after: 'after' }, { path: 'second', before: 'before', after: 'after' }];
    const restored: string[] = [];
    await expect(restoreChanges(workspace, snapshots, async change => {
      restored.push(change.path);
      await fs.writeFile(path.join(workspace, 'second'), 'external change');
    })).rejects.toMatchObject({ status: 409 });
    expect(restored).toEqual(['first']);
    expect(await fs.readFile(path.join(workspace, 'first'), 'utf8')).toBe('before');
    expect(await fs.readFile(path.join(workspace, 'second'), 'utf8')).toBe('external change');
  });
  it('rejects a parent symlink swapped after preflight without touching its new target', async () => {
    await put('first', 'after');
    await put('nested/second', 'after');
    await fs.writeFile(path.join(outside, 'second'), 'outside');
    await expect(restoreChanges(workspace, [{ path: 'first', before: 'before', after: 'after' }, { path: 'nested/second', before: 'before', after: 'after' }], async () => {
      await fs.rename(path.join(workspace, 'nested'), path.join(workspace, 'old-nested'));
      await fs.symlink(outside, path.join(workspace, 'nested'));
    })).rejects.toThrow(/Symlink/);
    expect(await fs.readFile(path.join(outside, 'second'), 'utf8')).toBe('outside');
    expect(await fs.readFile(path.join(workspace, 'old-nested/second'), 'utf8')).toBe('after');
  });
  it('rejects inode replacement even when bytes match and stops on callback failure', async () => {
    await put('first', 'after');
    await put('second', 'after');
    const snapshots: FileChange[] = [{ path: 'first', before: 'before', after: 'after' }, { path: 'second', before: 'before', after: 'after' }];
    await expect(restoreChanges(workspace, snapshots, async () => {
      await fs.rename(path.join(workspace, 'second'), path.join(workspace, 'old-second'));
      await fs.writeFile(path.join(workspace, 'second'), 'after');
    })).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(workspace, 'second'), 'utf8')).toBe('after');
    await put('first', 'after');
    await expect(restoreChanges(workspace, snapshots, () => { throw new Error('Cannot persist progress'); })).rejects.toThrow('Cannot persist progress');
    expect(await fs.readFile(path.join(workspace, 'first'), 'utf8')).toBe('before');
    expect(await fs.readFile(path.join(workspace, 'second'), 'utf8')).toBe('after');
  });
});

describe('grep', () => {
  it('searches regex and literal strings, with filters and case options', async () => {
    await put('src/a.ts', 'Alpha\nfoo.bar\nfooXbar\n');
    await put('src/b.js', 'Alpha');
    expect(await tool('grep', { pattern: '^alpha$', case_sensitive: false, glob: '**/*.ts' })).toBe('src/a.ts:1:Alpha');
    expect(await tool('grep', { pattern: 'foo.bar', literal: true })).toBe('src/a.ts:2:foo.bar');
    expect(await tool('grep', { pattern: 'foo.bar' })).toContain('src/a.ts:3:fooXbar');
    expect(await tool('grep', { pattern: 'no-match' })).toBe('No matches found.');
    await expect(tool('grep', { pattern: '[' })).rejects.toThrow(/Invalid regular expression/);
  });
  it('bounds matches, skips binary files, and marks partial scans', async () => {
    await put('many', 'match\n'.repeat(10));
    await put('binary', Buffer.from([0, 4, 5]));
    const result = await tool('grep', { pattern: 'match', max_results: 2 });
    expect(result).toContain('many:1:match');
    expect(result).not.toContain('many:3:');
    expect(result).toContain('truncated');
    expect(result).toContain('Skipped 1');
  });
  it('terminates pathological regexes without blocking the server', async () => {
    await put('adversarial', 'a'.repeat(40) + '!');
    await expect(tool('grep', { pattern: '(a+)+$' })).rejects.toThrow(/timed out/);
  });
});

describe('bash', () => {
  it('preserves a test runner failure when output is piped through tail', async () => {
    await put('package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(7)"' } }));
    expect(await tool('bash', { command: 'npm test 2>&1 | tail -8' })).toMatch(/Exit code: 7\s*$/);
    await put('package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    expect(await tool('bash', { command: 'npm test 2>&1 | tail -20' })).toMatch(/Exit code: 0\s*$/);
  });
  it('runs real shell commands in the workspace with stdout, stderr and exit status', async () => {
    const result = await tool('bash', { command: 'printf "$PWD"; printf "error text" >&2; exit 7' });
    expect(result).toContain(workspace);
    expect(result).toContain('error text');
    expect(result).toContain('Exit code: 7');
    await fs.mkdir(path.join(workspace, 'sub'));
    expect(await tool('bash', { command: 'pwd', cwd: 'sub' })).toContain(path.join(workspace, 'sub'));
    await expect(tool('bash', { command: 'pwd', cwd: '../outside' })).rejects.toThrow(/outside/);
  });
  it('does not pass harness/provider credentials or startup hooks to the shell', async () => {
    for (const key of ['LITELLM_API_KEY', 'LITESPEED_AUTH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BASH_ENV']) vi.stubEnv(key, 'SYNTHETIC_CREDENTIAL_VALUE');
    vi.stubEnv('NORMAL_PROJECT_OPTION', 'normal-value');
    const result = await tool('bash', { command: 'printf "%s|%s|%s|%s|%s|%s" "$LITELLM_API_KEY" "$LITESPEED_AUTH_TOKEN" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$BASH_ENV" "$NORMAL_PROJECT_OPTION"' });
    expect(result).not.toContain('SYNTHETIC_CREDENTIAL_VALUE');
    expect(result).toContain('|||||normal-value');
  });
  it('bounds continuous output while draining the process streams', async () => {
    const result = await tool('bash', { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(300000)); process.stderr.write("y".repeat(300000))'` });
    expect(result.length).toBeLessThan(34_000);
    expect(result).toContain('truncated');
    expect(result).toContain('Exit code: 0');
  });
  it('times out and aborts entire process groups, including a child ignoring SIGTERM', async () => {
    const marker = path.join(workspace, 'should-not-exist');
    const childScript = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),1200);setInterval(()=>{},1000)`;
    const escapedScript = `'${childScript.replace(/'/g, `'\\''`)}'`;
    const command = `${JSON.stringify(process.execPath)} -e ${escapedScript} & wait`;
    expect(await tool('bash', { command, timeout_ms: 100 })).toContain('timed out');
    await new Promise(resolve => setTimeout(resolve, 1400));
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const running = tool('bash', { command: 'sleep 30 & wait', timeout_ms: 10_000 });
    setTimeout(() => controller.abort(), 50);
    expect(await running).toContain('cancelled');
  });
});

describe('public HTTP fetching', () => {
  it.each(['file:///etc/passwd', 'ftp://example.com/a', 'http://user:secret@example.com', 'http://localhost', 'http://a.localhost', 'http://machine.local', 'http://127.0.0.1', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://10.1.2.3', 'http://172.16.0.1', 'http://192.168.1.1', 'http://169.254.169.254/latest', 'http://100.64.0.1', 'http://0.0.0.0', 'http://224.0.0.1', 'http://192.0.2.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fd00::1]', 'http://[fe80::1]', 'http://[2001:db8::1]', 'http://[64:ff9b::a00:1]'])('rejects unsafe URL %s before requesting it', async url => {
    const mock = mockWeb([]);
    await expect(tool('web_fetch', { url })).rejects.toThrow(/HTTP|private|Local|reserved|credentials/);
    expect(mock.requests).toHaveLength(0);
  });
  it('rejects DNS answers containing any private address', async () => {
    const mock = mockWeb([]);
    mock.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] as never);
    await expect(tool('web_fetch', { url: 'https://example.com' })).rejects.toThrow(/private/);
    expect(mock.requests).toHaveLength(0);
  });
  it('pins public DNS for the actual request, preserves host and strips HTML scripts', async () => {
    const mock = mockWeb([{ type: 'text/html', body: '<h1>Hello &amp; world</h1><script>secret()</script><p>Text &#128512;</p>' }]);
    const result = await tool('web_fetch', { url: 'https://example.com/docs' });
    expect(result).toContain('Hello & world');
    expect(result).toContain('Text 😀');
    expect(result).not.toContain('secret');
    expect(mock.requests[0].url.hostname).toBe('example.com');
    const lookup = mock.requests[0].options.lookup as Function;
    const callback = vi.fn();
    lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(mock.lookup).toHaveBeenCalledTimes(1);
  });
  it('validates every redirect and blocks redirect escape', async () => {
    const mock = mockWeb([{ status: 302, location: 'http://127.0.0.1/private' }]);
    await expect(tool('web_fetch', { url: 'https://example.com' })).rejects.toThrow(/private/);
    expect(mock.requests).toHaveLength(1);
  });
  it('follows relative public redirects and bounds redirect loops', async () => {
    const mock = mockWeb([{ status: 301, location: '/final' }, { body: 'arrived' }]);
    expect(await tool('web_fetch', { url: 'https://example.com/start' })).toContain('arrived');
    expect(mock.requests[1].url.pathname).toBe('/final');
    vi.restoreAllMocks();
    const loop = mockWeb(Array.from({ length: 6 }, () => ({ status: 302, location: '/loop' })));
    await expect(tool('web_fetch', { url: 'https://example.com' })).rejects.toThrow(/Too many/);
    expect(loop.requests).toHaveLength(6);
  });
  it('returns HTTP errors usefully, rejects binary types, and bounds response bodies', async () => {
    mockWeb([{ status: 404, body: 'Not found' }, { type: 'image/png', body: Buffer.from([0, 1]) }, { body: 'x'.repeat(400_000) }]);
    expect(await tool('web_fetch', { url: 'https://example.com/missing' })).toContain('HTTP 404\nNot found');
    await expect(tool('web_fetch', { url: 'https://example.com/image' })).rejects.toThrow(/binary/);
    const large = await tool('web_fetch', { url: 'https://example.com/large' });
    expect(large.length).toBeLessThan(50_100);
    expect(large).toContain('truncated');
  });
  it('times out a stalled response and permits cancellation during DNS lookup', async () => {
    mockWeb([{ hang: true }]);
    await expect(tool('web_fetch', { url: 'https://example.com', timeout_ms: 30 })).rejects.toThrow(/timed out/);
    vi.restoreAllMocks();
    const mock = mockWeb([]);
    mock.lookup.mockImplementation(() => new Promise(() => {}) as never);
    const request = tool('web_fetch', { url: 'https://example.com' });
    setTimeout(() => controller.abort(), 20);
    await expect(request).rejects.toThrow(/cancelled/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('web search', () => {
  // Captured-shape DDG litespeed/html markup: result__a anchors with /l/?uddg=
  // redirect hrefs (entity-encoded &amp;) and result__snippet elements.
  const ddgPage = (results: { title: string; target: string; snippet?: string }[]) => `<html><body>${results.map(r => `<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.target)}&amp;rut=abc123">${r.title}</a></h2>${r.snippet === undefined ? '' : `<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">${r.snippet}</a>`}</div>`).join('')}</body></html>`;
  beforeEach(() => { resetWebSearchCourtesy(); });
  it('declares web_search as a separate read-only definition outside toolDefinitions', () => {
    expect(toolDefinitions.some(value => value.function.name === 'web_search')).toBe(false);
    expect(webSearchTool.function.name).toBe('web_search');
    expect(webSearchTool.function.description).toContain('untrusted');
    expect(isReadOnlyTool('web_search')).toBe(true);
  });
  it('queries the endpoint through the guarded fetch, decodes redirect targets and entities, and carries the untrusted note', async () => {
    const mock = mockWeb([{ type: 'text/html', body: ddgPage([
      { title: 'Rate &amp; limits', target: 'https://example.org/docs?a=1&b=2', snippet: 'How <b>rate</b> limiting works &#128512;' },
      { title: 'Second result', target: 'https://example.net/two' },
    ]) }]);
    const result = await tool('web_search', { query: 'rate limiting guide' });
    expect(mock.requests[0].url.href).toContain('html.duckduckgo.com/html/?q=rate%20limiting%20guide');
    expect(result).toContain('1. Rate & limits — https://example.org/docs?a=1&b=2');
    expect(result).toContain('How rate limiting works 😀');
    expect(result).toContain('2. Second result — https://example.net/two'); // Missing snippet tolerated.
    expect(result).toContain('untrusted suggestions');
    expect(result).toContain('web_fetch');
  });
  it('clamps limit to 5, bounds total output, and reports an unparseable page honestly', async () => {
    mockWeb([{ type: 'text/html', body: ddgPage(Array.from({ length: 12 }, (_, i) => ({ title: `Result ${i}`, target: `https://example.org/${i}`, snippet: 'x'.repeat(500) }))) }]);
    const result = await tool('web_search', { query: 'many', limit: 50 });
    expect(result).toContain('5. Result 4');
    expect(result).not.toContain('Result 5');
    expect(result.length).toBeLessThanOrEqual(8192 + '\n[Output truncated]'.length);
    resetWebSearchCourtesy();
    mockWeb([{ type: 'text/html', body: '<html><body>No results markup here</body></html>' }]);
    const empty = await tool('web_search', { query: 'nothing' });
    expect(empty).toContain('No results parsed');
    expect(empty).toContain('untrusted');
  });
  it('enforces the 2-second per-session courtesy interval with an honest wait error and no second request', async () => {
    const mock = mockWeb([{ type: 'text/html', body: ddgPage([{ title: 'One', target: 'https://example.org/1' }]) }]);
    await tool('web_search', { query: 'first' });
    await expect(tool('web_search', { query: 'second' })).rejects.toThrow(/wait.*2 seconds/i);
    expect(mock.requests).toHaveLength(1);
  });
  it('reuses the SSRF guard: private DNS answers and redirects to private ranges are refused', async () => {
    const mock = mockWeb([]);
    mock.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
    await expect(tool('web_search', { query: 'ssrf' })).rejects.toThrow(/private|reserved/);
    expect(mock.requests).toHaveLength(0);
    resetWebSearchCourtesy();
    vi.restoreAllMocks();
    const redirect = mockWeb([{ status: 302, location: 'http://127.0.0.1/internal' }]);
    await expect(tool('web_search', { query: 'redirect' })).rejects.toThrow(/private|Local/);
    expect(redirect.requests).toHaveLength(1); // The redirect target was never fetched.
  });
  it('turns failures and timeouts into single honest errors, never retry loops', async () => {
    const failing = mockWeb([{ status: 500, body: 'oops' }]);
    await expect(tool('web_search', { query: 'broken' })).rejects.toThrow(/HTTP 500.*Do not retry/);
    expect(failing.requests).toHaveLength(1);
    resetWebSearchCourtesy();
    vi.restoreAllMocks();
    const hanging = mockWeb([{ hang: true }]);
    const original = webSearchEndpoint.timeoutMs;
    webSearchEndpoint.timeoutMs = 30; // Injectable for tests only.
    try { await expect(tool('web_search', { query: 'slow' })).rejects.toThrow(/timed out.*Do not retry/); }
    finally { webSearchEndpoint.timeoutMs = original; }
    expect(hanging.requests).toHaveLength(1);
  });
  it('parseSearchResults is bounded and tolerant of hostile or partial markup', () => {
    expect(parseSearchResults('<a class="result__a">No href</a>', 5)).toEqual([]);
    expect(parseSearchResults('<a class="result__a" href="javascript:alert(1)">Bad scheme</a>', 5)).toEqual([]);
    const direct = parseSearchResults('<a class="result__a" href="https://example.org/direct">Direct link</a>', 5);
    expect(direct).toEqual([{ title: 'Direct link', url: 'https://example.org/direct', snippet: '' }]);
  });
});

describe('image viewing', () => {
  // Minimal magic-byte-valid headers; sniffing never requires a full decode.
  const png = (width: number, height: number) => { const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b; };
  const attached: Attachment[] = [];
  beforeEach(() => { attached.length = 0; context.attachImage = attachment => { attached.push(attachment); return true; }; });
  it('declares view_image as a separate read-only definition outside toolDefinitions', () => {
    expect(toolDefinitions.some(value => value.function.name === 'view_image')).toBe(false);
    expect(viewImageTool.function.name).toBe('view_image');
    expect(isReadOnlyTool('view_image')).toBe(true);
  });
  it('sniffs magic bytes, attaches a base64 data URL, and reports dimensions and size', async () => {
    await put('shots/pic.dat', png(320, 200)); // Wrong extension on purpose: bytes decide.
    const result = await tool('view_image', { path: 'shots/pic.dat' });
    expect(result).toBe('[Image shots/pic.dat attached: image/png, 320x200, 64 bytes]');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ name: 'pic.dat', path: 'shots/pic.dat', mimeType: 'image/png' });
    expect(attached[0].dataUrl).toBe(`data:image/png;base64,${png(320, 200).toString('base64')}`);
  });
  it('recognizes JPEG, GIF and WebP by their signatures', async () => {
    await put('a.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]));
    await put('b.gif', Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x10, 0x00, 0x08, 0x00]), Buffer.alloc(8)]));
    await put('c.webp', Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]));
    expect(await tool('view_image', { path: 'a.jpg' })).toContain('image/jpeg');
    expect(await tool('view_image', { path: 'b.gif' })).toContain('image/gif, 16x8');
    expect(await tool('view_image', { path: 'c.webp' })).toContain('image/webp');
    expect(attached).toHaveLength(3);
  });
  it('rejects a .png-named text file by content, not extension', async () => {
    await put('fake.png', 'plain text pretending to be an image');
    await expect(tool('view_image', { path: 'fake.png' })).rejects.toThrow(/magic bytes/);
    expect(attached).toEqual([]);
  });
  it('rejects images over 8 MiB honestly instead of downscaling', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big, 0);
    await put('big.png', big);
    await expect(tool('view_image', { path: 'big.png' })).rejects.toThrow(/too large.*No downscaling/);
    expect(attached).toEqual([]);
  });
  it('reports honestly when the provider route cannot carry images in tool results', async () => {
    await put('pic.png', png(2, 2));
    context.attachImage = () => false; // codex-style route.
    expect(await tool('view_image', { path: 'pic.png' })).toContain('NOT attached: this provider route does not support images in tool results');
    delete context.attachImage; // No runner wiring at all: same honest fallback.
    expect(await tool('view_image', { path: 'pic.png' })).toContain('NOT attached');
  });
  it('enforces the workspace read policy: outside paths and protected files are refused', async () => {
    await fs.writeFile(path.join(outside, 'secret.png'), png(1, 1));
    await expect(tool('view_image', { path: '../outside/secret.png' })).rejects.toThrow(/outside/);
    await put('.env', 'SECRET=1'); // The workspace .env is a test fixture, not project state.
    await expect(tool('view_image', { path: '.env' })).rejects.toThrow(/Protected/);
  });
});

describe('session todos and delegation', () => {
  it('validates and persists session todos with generated stable IDs', async () => {
    expect(await tool('todo_read')).toBe('[]');
    await tool('todo_write', { todos: [{ content: 'Do work', status: 'in_progress' }] });
    expect(todos[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(await tool('todo_read'))).toEqual(todos);
    const id = todos[0].id;
    await tool('todo_write', { todos: [{ id, content: 'Do work', status: 'completed' }] });
    expect(todos[0]).toEqual({ id, content: 'Do work', status: 'completed' });
    await expect(tool('todo_write', { todos: [{ id, content: 'Bad', status: 'bad' }] })).rejects.toThrow(/Invalid todo/);
    await expect(tool('todo_write', { todos: [todos[0], todos[0]] })).rejects.toThrow(/unique/);
    expect(todos[0].status).toBe('completed');
  });
  it('only delegates when configured and bounds delegate output', async () => {
    await expect(tool('task', { prompt: 'Inspect the code' })).rejects.toThrow(/not configured/);
    const delegate = vi.fn(async (prompt: string) => `${prompt}\n${'a'.repeat(50_000)}`);
    context.delegate = delegate;
    const output = await tool('task', { prompt: 'Inspect the code' });
    expect(delegate).toHaveBeenCalledExactlyOnceWith('Inspect the code');
    expect(output).toContain('Inspect the code');
    expect(output.length).toBeLessThan(33_000);
  });
  it('cancels waiting for a delegated task', async () => {
    context.delegate = () => new Promise(() => {});
    const result = tool('task', { prompt: 'Wait' });
    controller.abort();
    await expect(result).rejects.toThrow(/cancel/i);
  });
});

describe('git status', () => {
  it('returns isRepo false for a plain directory and does not discover a parent repository', async () => {
    expect(await gitStatus(workspace)).toEqual({ branch: '', files: [], isRepo: false });
    await exec('git', ['init', '--quiet'], { cwd: temporary });
    expect((await gitStatus(workspace)).isRepo).toBe(false);
  });
  it('reports branch, untracked, modified and renamed paths without exposing hidden files', async () => {
    await exec('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace });
    await put('tracked.txt', 'one\n');
    await put('old name.txt', 'rename\n');
    await exec('git', ['add', '.'], { cwd: workspace });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: workspace });
    await put('tracked.txt', 'two\n');
    await put('new file.txt', 'untracked');
    await put('.env', 'secret');
    await exec('git', ['mv', 'old name.txt', 'new name.txt'], { cwd: workspace });
    const result = await gitStatus(workspace);
    expect(result.isRepo).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.files).toEqual(expect.arrayContaining([{ path: 'tracked.txt', status: 'M' }, { path: 'new file.txt', status: '??' }, { path: 'new name.txt', status: 'R' }]));
    expect(result.files.some(file => file.path === '.env' || file.path === 'old name.txt')).toBe(false);
  });
  it('rejects external git metadata paths instead of reading them', async () => {
    await fs.symlink(outside, path.join(workspace, '.git'));
    await expect(gitStatus(workspace)).rejects.toThrow(/outside/);
  });
  async function worktreeFixture() {
    const repository = path.join(temporary, 'repository');
    await fs.mkdir(repository);
    await exec('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository });
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'one\n');
    await fs.writeFile(path.join(repository, 'old name.txt'), 'rename\n');
    await exec('git', ['add', '.'], { cwd: repository });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture'], { cwd: repository });
    await exec('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '-b', 'feature/test', workspace], { cwd: repository });
    const pointer = (await fs.readFile(path.join(workspace, '.git'), 'utf8')).trim().slice(8);
    return { repository, commonDir: path.join(repository, '.git'), gitDir: path.resolve(workspace, pointer) };
  }
  it('supports clean, dirty, and renamed files in a registered external worktree without weakening file boundaries', async () => {
    const { gitDir } = await worktreeFixture();
    expect(await gitStatus(workspace)).toEqual({ branch: 'feature/test', files: [], isRepo: true });
    await put('tracked.txt', 'two\n');
    await put('new file.txt', 'untracked');
    await exec('git', ['mv', 'old name.txt', 'new name.txt'], { cwd: workspace });
    const result = await gitStatus(workspace);
    expect(result.branch).toBe('feature/test');
    expect(result.files).toEqual(expect.arrayContaining([{ path: 'tracked.txt', status: 'M' }, { path: 'new file.txt', status: '??' }, { path: 'new name.txt', status: 'R' }]));
    await expect(resolveWorkspacePath(workspace, gitDir)).rejects.toThrow(/outside/);
    await expect(readFile(workspace, path.join(gitDir, 'HEAD'))).rejects.toThrow(/outside/);
    await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${path.relative(workspace, gitDir)}\n`);
    expect((await gitStatus(workspace)).isRepo).toBe(true);
    const alias = path.join(temporary, 'workspace-alias');
    await fs.symlink(workspace, alias);
    expect((await gitStatus(alias)).branch).toBe('feature/test');
  });
  it('does not execute repository filters, fsmonitor, hooks, or global configuration', async () => {
    const { repository, commonDir } = await worktreeFixture();
    const marker = path.join(temporary, 'must-not-execute');
    const hook = path.join(temporary, 'hook');
    await fs.writeFile(hook, `#!/bin/sh\nprintf unsafe > '${marker}'\n`, { mode: 0o755 });
    const hooks = path.join(temporary, 'hooks');
    await fs.mkdir(hooks);
    await fs.copyFile(hook, path.join(hooks, 'post-index-change'));
    await fs.chmod(path.join(hooks, 'post-index-change'), 0o755);
    for (const [key, value] of [['core.fsmonitor', hook], ['core.hooksPath', hooks], ['filter.unsafe.clean', hook], ['filter.unsafe.process', hook], ['filter.unsafe.required', 'true'], ['core.worktree', outside]]) {
      await exec('git', ['--git-dir', commonDir, 'config', key, value], { cwd: repository });
    }
    await put('.gitattributes', '*.txt filter=unsafe\n');
    await put('tracked.txt', 'changed\n');
    const global = path.join(temporary, 'global-config');
    await fs.writeFile(global, '[this is not valid configuration');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    vi.stubEnv('GIT_DIR', outside);
    vi.stubEnv('GIT_WORK_TREE', outside);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor');
    vi.stubEnv('GIT_CONFIG_VALUE_0', hook);
    expect((await gitStatus(workspace)).files).toContainEqual({ path: 'tracked.txt', status: 'M' });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects arbitrary external targets and a registration belonging to another worktree', async () => {
    await put('.git', `gitdir: ${outside}\n`);
    await expect(gitStatus(workspace)).rejects.toThrow(/Unregistered/);
    await fs.unlink(path.join(workspace, '.git'));
    const { gitDir } = await worktreeFixture();
    await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.join(outside, '.git')}\n`);
    await expect(gitStatus(workspace)).rejects.toThrow(/does not point back/);
  });
  it('rejects escaping commondir pointers and symlinked registration metadata', async () => {
    const { gitDir } = await worktreeFixture();
    await fs.writeFile(path.join(gitDir, 'commondir'), `${outside}\n`);
    await expect(gitStatus(workspace)).rejects.toThrow(/does not point back/);
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    const backlink = await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8');
    await fs.unlink(path.join(gitDir, 'gitdir'));
    await fs.writeFile(path.join(outside, 'backlink'), backlink);
    await fs.symlink(path.join(outside, 'backlink'), path.join(gitDir, 'gitdir'));
    await expect(gitStatus(workspace)).rejects.toThrow(/symlinks/);
  });
  it('rejects symlinked indexes and config includes without returning their contents', async () => {
    const { repository, commonDir, gitDir } = await worktreeFixture();
    const secret = path.join(outside, 'secret');
    await fs.writeFile(secret, 'SYNTHETIC_SECRET');
    await exec('git', ['--git-dir', commonDir, 'config', 'include.path', secret], { cwd: repository });
    await expect(gitStatus(workspace)).rejects.toThrow(/includes are not supported/);
    await exec('git', ['--git-dir=/dev/null', 'config', '--no-includes', '--file', path.join(commonDir, 'config'), '--unset', 'include.path'], { cwd: repository });
    await fs.unlink(path.join(gitDir, 'index'));
    await fs.symlink(secret, path.join(gitDir, 'index'));
    await expect(gitStatus(workspace)).rejects.toThrow(/symlinks/);
  });
});
