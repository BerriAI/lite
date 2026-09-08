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
import { assertReadablePath, executeTool, gitStatus, isReadOnlyTool, listFiles, readFile, resolveWorkspacePath, searchFiles, toolDefinitions, type ToolContext } from '../server/tools.js';
import type { FileChange, Todo } from '../shared/types.js';

const exec = promisify(execFile);
let temporary: string;
let workspace: string;
let outside: string;
let context: ToolContext;
let controller: AbortController;
let changes: FileChange[];
let todos: Todo[];

beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lite-tools-')));
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
    for (const name of ['read_file', 'glob', 'grep', 'web_fetch', 'todo_read']) expect(isReadOnlyTool(name)).toBe(true);
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
    const protectedFiles = ['.env', '.env.production', '.lite/auth.json', '.lite/state.sqlite', '.ssh/id_ed25519', 'id_rsa', 'private_key.pem'];
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
    await put('.lite/instructions.md', 'Project instructions');
    expect((await readFile(workspace, '.env.example')).content).toBe('KEY=your-key');
    expect((await readFile(workspace, '.config/source.ts')).content).toBe('source');
    expect((await readFile(workspace, '.lite/instructions.md')).content).toBe('Project instructions');
    expect(await assertReadablePath(workspace, path.join(workspace, '.lite/instructions.md'))).toBe(path.join(workspace, '.lite/instructions.md'));
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
    for (const key of ['LITELLM_API_KEY', 'LITE_AUTH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BASH_ENV']) vi.stubEnv(key, 'SYNTHETIC_CREDENTIAL_VALUE');
    vi.stubEnv('NORMAL_PROJECT_OPTION', 'normal-value');
    const result = await tool('bash', { command: 'printf "%s|%s|%s|%s|%s|%s" "$LITELLM_API_KEY" "$LITE_AUTH_TOKEN" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$BASH_ENV" "$NORMAL_PROJECT_OPTION"' });
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
    expect(large.length).toBeLessThan(33_000);
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
});
