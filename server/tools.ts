import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Worker } from 'node:worker_threads';
import { createPatch } from 'diff';
import type { FileChange, FileEntry, Todo, ToolDefinition } from '../shared/types.js';

export interface ToolContext {
  workspace: string;
  sessionId: string;
  signal: AbortSignal;
  onChange: (change: FileChange) => void | Promise<void>;
  prepareChange?: (change: FileChange) => void | Promise<void>;
  onTodos: (todos: Todo[]) => void | Promise<void>;
  getTodos: () => Todo[];
  delegate?: (prompt: string) => Promise<string>;
}

const OUTPUT_LIMIT = 32_768;
const READ_LIMIT = 256 * 1024;
const EDIT_LIMIT = 2 * 1024 * 1024;
const DISCOVERY_LIMIT = 10_000;
const ENTRY_LIMIT = 20_000;
const IGNORED_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '__pycache__']);
const READ_ONLY = new Set(['read_file', 'glob', 'grep', 'web_fetch', 'todo_read']);
const string = { type: 'string' };
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const toolDefinitions: ToolDefinition[] = [
  definition('read_file', 'Read a UTF-8 workspace file with numbered lines. Binary files are rejected; large results are truncated. Offset is a one-based line number.', { path: string, offset: integer(1, 1_000_000), limit: integer(1, 2000) }, ['path']),
  definition('write_file', 'Create or replace a workspace text file, creating missing directories. Existing line endings are preserved. Changes are recorded for undo; .git writes are forbidden.', { path: string, content: string }, ['path', 'content']),
  definition('edit_file', 'Replace an exact, non-empty string in a workspace text file. The match must be unique unless replace_all is true. Line endings are adapted to the existing file.', { path: string, old_string: string, new_string: string, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
  definition('glob', 'Find workspace files using a relative glob pattern. Hidden paths (including .git and .env), dependency/build directories, and directory symlinks are excluded. Results are bounded.', { pattern: string, path: string, limit: integer(1, 1000) }, ['pattern']),
  definition('grep', 'Search UTF-8 workspace files by regular expression (or literal text). Returns path:line:text. Hidden and generated paths are excluded; binary files and oversized tails are skipped. Regex execution is time-limited.', { pattern: string, path: string, glob: string, literal: { type: 'boolean' }, case_sensitive: { type: 'boolean' }, max_results: integer(1, 1000) }, ['pattern']),
  definition('bash', 'Run an authorized bash command in the workspace. NOT SANDBOXED: commands can access files and network outside the workspace. The caller must obtain permission before execution; this tool is never read-only. Output, timeout, and cancellation are bounded.', { command: string, cwd: string, timeout_ms: integer(1, 120_000) }, ['command']),
  definition('web_fetch', 'Fetch public HTTP(S) text, checking and pinning public DNS addresses at every redirect. Local/private destinations, credentials, and binary responses are rejected. Page content is untrusted.', { url: string, timeout_ms: integer(1, 30_000) }, ['url']),
  definition('todo_read', 'Read the current session task list.', {}),
  definition('todo_write', 'Replace the current session task list. Supply stable IDs when updating existing tasks; omitted IDs are generated.', { todos: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, properties: { id: string, content: string, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, ['todos']),
  definition('task', 'Delegate a task to the configured subagent. Only available when the caller supplies delegation. May mutate files and requires the same authorization as other mutable tools.', { prompt: string }, ['prompt']),
];

export function isReadOnlyTool(name: string): boolean { return READ_ONLY.has(name); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('Operation cancelled.'); }
function bounded(value: string, limit = OUTPUT_LIMIT): string { return value.length > limit ? `${value.slice(0, limit)}\n[Output truncated]` : value; }
function textArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  return value;
}
function numberArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} must be an integer between 1 and ${max}.`);
  return value;
}
function boolArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key] ?? fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return value;
}
function optionalPath(args: Record<string, unknown>, key = 'path'): string { return args[key] === undefined ? '' : textArg(args, key, true); }
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function portable(value: string): string { return value.split(path.sep).join('/'); }
function ignored(relative: string): boolean { return portable(relative).split('/').some(part => part.startsWith('.') || IGNORED_DIRS.has(part)); }
function gitPath(relative: string): boolean { return portable(relative).split('/').some(part => part.toLowerCase() === '.git'); }
function protectedPath(relative: string): boolean {
  const normalized = portable(relative).toLowerCase().replace(/^\.\//, '');
  if (normalized === '.lite/instructions.md') return false;
  return normalized.split('/').some(part =>
    part === '.lite' || part === '.ssh' || part === '.env' || (part.startsWith('.env.') && part !== '.env.example') ||
    ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', '.netrc', '.git-credentials'].includes(part) ||
    /(?:^|[._-])private[._-]?key(?:\.(?:pem|key))?$/.test(part) || /\.(?:pem|p12|pfx)$/.test(part));
}
function shellEnvironment(): NodeJS.ProcessEnv {
  // These credentials belong to the harness, not the authorized subprocess.
  // This is defense in depth, not a shell sandbox or an alternative to approval.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:LITE_|LITELLM_)/i.test(key) &&
    !/^(?:(?:OPENAI|ANTHROPIC|AZURE_OPENAI|GEMINI|GOOGLE|COHERE|MISTRAL)_API_KEY|OPENAI_ACCESS_TOKEN|ANTHROPIC_AUTH_TOKEN|BASH_ENV|ENV)$/i.test(key)));
}

/** Resolve every existing component, including ancestors of a not-yet-created file. */
export async function resolveWorkspacePath(workspace: string, filePath: string, options: { allowMissing?: boolean } = {}): Promise<string> {
  if (typeof workspace !== 'string' || !workspace || typeof filePath !== 'string' || filePath.includes('\0')) throw new Error('Invalid workspace path.');
  const lexicalRoot = path.resolve(workspace);
  const root = await fs.realpath(lexicalRoot);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Workspace must be a directory.');
  const candidate = path.resolve(lexicalRoot, filePath);
  const base = within(lexicalRoot, candidate) ? lexicalRoot : root;
  if (!within(base, candidate)) throw new Error('Path is outside the workspace.');
  const parts = path.relative(base, candidate).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const entry = await fs.lstat(current);
      // A dangling symlink is not a missing file: resolving it must fail.
      const resolved = await fs.realpath(current);
      if (!within(root, resolved)) throw new Error('Symlink points outside the workspace.');
      if (index < parts.length - 1 && !(entry.isDirectory() || (entry.isSymbolicLink() && (await fs.stat(resolved)).isDirectory()))) throw new Error('A parent path is not a directory.');
      current = resolved;
    } catch (error) {
      if (options.allowMissing && hasCode(error, 'ENOENT')) {
        // lstat detects a dangling link, even when realpath failed with ENOENT.
        const existing = await fs.lstat(current).catch(e => { if (hasCode(e, 'ENOENT')) return null; throw e; });
        if (existing) throw new Error('Cannot resolve a dangling symlink.');
        return path.join(current, ...parts.slice(index + 1));
      }
      throw error;
    }
  }
  return current;
}

export async function assertReadablePath(workspace: string, filePath: string): Promise<string> {
  const absolute = await resolveWorkspacePath(workspace, filePath);
  const root = await fs.realpath(workspace);
  const candidate = path.resolve(workspace, filePath);
  const lexical = path.relative(within(path.resolve(workspace), candidate) ? path.resolve(workspace) : root, candidate);
  if (protectedPath(lexical) || protectedPath(path.relative(root, absolute))) throw new Error('Protected credential or application-state files cannot be read by tools.');
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('Path is not a regular file.');
  if (stat.nlink > 1) throw new Error('Hard-linked files cannot be read safely because their aliases may contain protected credentials.');
  return absolute;
}

async function readTextFile(workspace: string, filePath: string, maxBytes: number, complete = false): Promise<{ absolute: string; content: string; truncated: boolean }> {
  const absolute = await assertReadablePath(workspace, filePath);
  return readAbsoluteText(absolute, maxBytes, complete);
}

async function readAbsoluteText(absolute: string, maxBytes: number, complete = false): Promise<{ absolute: string; content: string; truncated: boolean }> {
  // O_NONBLOCK avoids hanging on FIFOs; O_NOFOLLOW catches last-component swaps.
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Path is not a regular file.');
    if (stat.nlink > 1) throw new Error('Hard-linked files cannot be read safely because their aliases may contain protected credentials.');
    if (complete && stat.size > maxBytes) throw new Error(`File is too large to edit safely (maximum ${maxBytes} bytes).`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const truncated = length > maxBytes;
    if (complete && truncated) throw new Error('File grew beyond the safe editing limit.');
    const bytes = buffer.subarray(0, Math.min(length, maxBytes));
    if (bytes.includes(0)) throw new Error('Binary files are not supported; select a UTF-8 text file.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated }); }
    catch { throw new Error('File is binary or is not valid UTF-8 text.'); }
    const controls = content.match(/[\x01-\x08\x0b\x0e-\x1f]/g)?.length ?? 0;
    if (controls > Math.max(2, content.length / 100)) throw new Error('Binary files are not supported.');
    return { absolute, content, truncated };
  } finally { await handle.close(); }
}

export async function readFile(workspace: string, filePath: string): Promise<{ path: string; content: string; truncated?: boolean }> {
  const result = await readTextFile(workspace, filePath, READ_LIMIT);
  return { path: portable(path.relative(await fs.realpath(workspace), result.absolute)), content: result.content, ...(result.truncated ? { truncated: true } : {}) };
}

/** Internal profile loader only: no caller-controlled paths outside this exact
 * layout, no aliases, and never exposed as a model tool. */
export async function readProfileSource(workspace: string, relative: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  signal?.throwIfAborted();
  const skill = /^\.lite\/skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/.exec(relative);
  if (relative !== '.lite/profiles.json' && (!skill || protectedPath(skill[1]))) fail('PROFILE_PATH', 'Invalid profile source path.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) fail('PROFILE_LIMIT', 'Invalid profile source bound.');
  const root = await fs.realpath(workspace);
  const parts = relative.split('/');
  const identities: { value: string; stat: Awaited<ReturnType<typeof fs.lstat>> }[] = [];
  let value = root;
  for (let index = 0; index < parts.length; index++) {
    value = path.join(value, parts[index]);
    const stat = await fs.lstat(value);
    if (stat.isSymbolicLink()) fail('PROFILE_ALIAS', 'Profile sources cannot use symbolic links.');
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) fail('PROFILE_TYPE', 'Profile sources must be regular files in real directories.');
    if (index === parts.length - 1 && stat.nlink !== 1) fail('PROFILE_ALIAS', 'Profile sources cannot use hard links.');
    identities.push({ value, stat });
    signal?.throwIfAborted();
  }
  const expected = identities.at(-1)!.stat;
  if (expected.size > maxBytes) fail('PROFILE_SIZE', 'Profile source exceeds its byte limit.');
  const verify = async () => {
    for (const entry of identities) {
      const now = await fs.lstat(entry.value);
      if (now.isSymbolicLink() || now.dev !== entry.stat.dev || now.ino !== entry.stat.ino || now.isDirectory() !== entry.stat.isDirectory()) fail('PROFILE_CHANGED', 'Profile source changed while being read.');
    }
    if (await fs.realpath(value) !== value) fail('PROFILE_ALIAS', 'Profile sources cannot use redirected paths.');
    signal?.throwIfAborted();
  };
  const handle = await fs.open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs || opened.ctimeMs !== expected.ctimeMs) fail('PROFILE_CHANGED', 'Profile source changed while being opened.');
    await verify();
    const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail('PROFILE_SIZE', 'Profile source exceeds its byte limit.');
    const after = await handle.stat();
    if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || length !== opened.size) fail('PROFILE_CHANGED', 'Profile source changed while being read.');
    await verify();
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) fail('PROFILE_UTF8', 'Profile sources must be complete UTF-8 text without NUL bytes.');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return fail('PROFILE_UTF8', 'Profile sources must be complete UTF-8 text.'); }
  } finally { await handle.close(); }
}

/** Command loading has one narrow exception to the private .lite state policy. */
export async function readCommand(workspace: string, filePath: string): Promise<string> {
  const root = await fs.realpath(workspace);
  const absolute = await resolveWorkspacePath(workspace, filePath);
  const candidate = path.resolve(workspace, filePath);
  const lexical = portable(path.relative(within(path.resolve(workspace), candidate) ? path.resolve(workspace) : root, candidate));
  const canonical = portable(path.relative(root, absolute));
  const commandPath = (relative: string) => /^\.lite\/commands\/[^/]+\.md$/.test(relative) && !protectedPath(path.posix.basename(relative));
  const allowedDirectory = (relative: string) => relative.split('/').length === 3 && relative.split('/')[1] === 'commands' && relative.endsWith('.md');
  if (!allowedDirectory(lexical) || (!commandPath(lexical) && protectedPath(lexical)) || (!commandPath(canonical) && protectedPath(canonical))) throw new Error('Invalid or protected command file.');
  // Reject redirection entirely; a command cannot use even an in-workspace
  // symlink to bypass credential checks or alias another private command file.
  await noSymlinkPath(root, lexical);
  if (path.resolve(root, lexical) !== absolute) throw new Error('Command symlink redirection is forbidden.');
  const result = await readAbsoluteText(absolute, 64 * 1024, true);
  return result.content;
}

async function noSymlinkPath(root: string, filePath: string): Promise<string> {
  const absolute = path.resolve(root, filePath);
  if (!within(root, absolute)) throw new Error('Path is outside the workspace.');
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink redirection is forbidden for this operation.'); }
    catch (error) { if (hasCode(error, 'ENOENT')) break; throw error; }
  }
  return absolute;
}

export async function listFiles(workspace: string, filePath = ''): Promise<FileEntry[]> {
  const root = await fs.realpath(workspace);
  const directory = await resolveWorkspacePath(workspace, filePath);
  if (ignored(path.relative(root, directory)) || protectedPath(path.relative(root, directory))) return [];
  const entries: FileEntry[] = [];
  const stream = await fs.opendir(directory);
  let visited = 0;
  for await (const entry of stream) {
    if (++visited > ENTRY_LIMIT || entries.length >= 2000) break;
    const relative = path.relative(root, path.join(directory, entry.name));
    if (ignored(relative) || protectedPath(relative)) continue;
    try {
      const absolute = await resolveWorkspacePath(root, relative);
      if (ignored(path.relative(root, absolute)) || protectedPath(path.relative(root, absolute))) continue;
      const stat = await fs.stat(absolute);
      if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1)) continue;
      entries.push({ name: entry.name, path: portable(relative), type: stat.isDirectory() ? 'directory' : 'file', ...(stat.isFile() ? { size: stat.size } : {}) });
    } catch (error) {
      if (!entry.isSymbolicLink() && !hasCode(error, 'ENOENT') && !hasCode(error, 'EACCES')) throw error;
    }
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
}

async function discoverFiles(workspace: string, filePath = '', signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  const root = await fs.realpath(workspace);
  const start = await resolveWorkspacePath(workspace, filePath);
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const deadline = Date.now() + 10_000;
  async function visit(absolute: string, depth: number): Promise<void> {
    checkAbort(signal);
    if (truncated || ++visited > ENTRY_LIMIT || files.length >= DISCOVERY_LIMIT || Date.now() > deadline) { truncated = true; return; }
    const relative = path.relative(root, absolute);
    if (ignored(relative) || protectedPath(relative)) return;
    const stat = await fs.lstat(absolute);
    // Do not descend through discovered symlinks; the explicit start was resolved above.
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { if (stat.nlink === 1) files.push(portable(relative)); return; }
    if (!stat.isDirectory()) return;
    if (depth >= 50) { truncated = true; return; }
    const directory = await fs.opendir(await resolveWorkspacePath(root, relative));
    for await (const entry of directory) {
      try { await visit(path.join(absolute, entry.name), depth + 1); }
      catch (error) { if (!hasCode(error, 'ENOENT') && !hasCode(error, 'EACCES')) throw error; }
      if (truncated) break;
    }
  }
  await visit(start, 0);
  return { files: files.sort(), truncated };
}

export async function searchFiles(workspace: string, query: string): Promise<string[]> {
  if (typeof query !== 'string') throw new Error('Query must be a string.');
  const needle = query.toLocaleLowerCase();
  return (await discoverFiles(workspace)).files.filter(file => file.toLocaleLowerCase().includes(needle)).slice(0, 200);
}

function globPattern(value: string): string {
  if (value.length > 1000 || path.isAbsolute(value) || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) throw new Error('Glob patterns must be relative workspace patterns without parent traversal.');
  return value.replace(/^\.\//, '');
}
function withFileEndings(value: string, before: string): string {
  const ending = before.match(/\r\n|\n|\r/)?.[0];
  return ending ? value.replace(/\r\n|\n|\r/g, ending) : value;
}
async function writablePath(workspace: string, filePath: string): Promise<string> {
  const root = await fs.realpath(workspace);
  const absolute = await resolveWorkspacePath(workspace, filePath, { allowMissing: true });
  if (protectedPath(path.relative(root, absolute))) throw new Error('Protected credential or application-state files cannot be written by tools.');
  if (gitPath(filePath) || gitPath(path.relative(root, absolute))) throw new Error('Writes inside .git are forbidden.');
  if (absolute === root) throw new Error('Cannot write the workspace directory.');
  return absolute;
}

async function mutateFile(args: Record<string, unknown>, context: ToolContext, edit: boolean): Promise<string> {
  const filePath = textArg(args, 'path');
  let absolute = await writablePath(context.workspace, filePath);
  let before: string | null = null;
  try { before = (await readTextFile(context.workspace, absolute, EDIT_LIMIT, true)).content; }
  catch (error) { if (edit || !hasCode(error, 'ENOENT')) throw error; }
  let after: string;
  let replacements = 0;
  if (edit) {
    const original = before!;
    const oldString = withFileEndings(textArg(args, 'old_string', true), original);
    if (!oldString.length) throw new Error('old_string must be a non-empty string.');
    const newString = withFileEndings(textArg(args, 'new_string', true), original);
    const replaceAll = boolArg(args, 'replace_all');
    let index = original.indexOf(oldString);
    if (index < 0) throw new Error('old_string was not found. Read the current file and provide an exact match.');
    if (!replaceAll && original.indexOf(oldString, index + 1) >= 0) throw new Error('old_string matches more than once. Include more context or set replace_all to true.');
    if (replaceAll) {
      const parts = original.split(oldString);
      replacements = parts.length - 1;
      after = parts.join(newString);
    } else { replacements = 1; after = original.slice(0, index) + newString + original.slice(index + oldString.length); }
  } else { after = withFileEndings(textArg(args, 'content', true), before ?? ''); }
  if (Buffer.byteLength(after) > EDIT_LIMIT) throw new Error(`Content is too large (maximum ${EDIT_LIMIT} bytes).`);
  if (after.includes('\0')) throw new Error('Binary content is not supported.');
  if (after === before) return 'No changes: the file already has the requested content.';
  checkAbort(context.signal);
  const relative = portable(path.relative(await fs.realpath(context.workspace), absolute));
  await context.prepareChange?.({ path: relative, before, after });
  checkAbort(context.signal);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  absolute = await writablePath(context.workspace, filePath);
  // Recheck the file after async work, and use O_EXCL for new files. Do not silently
  // overwrite an intervening edit or a final-component symlink.
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before === null ? constants.O_CREAT | constants.O_EXCL : 0);
  checkAbort(context.signal);
  const handle = await fs.open(absolute, flags, 0o666);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Path is not a regular file.');
    if (stat.nlink > 1) throw new Error('Refusing to modify a hard-linked file; it may have aliases outside the workspace.');
    if (before !== null) {
      const latest = await readTextFile(context.workspace, absolute, EDIT_LIMIT, true);
      const latestStat = await fs.stat(absolute);
      if (latest.content !== before || latestStat.ino !== stat.ino || latestStat.dev !== stat.dev) throw new Error('File changed while preparing this edit. Read it again and retry.');
    }
    checkAbort(context.signal);
    await handle.truncate(0);
    await handle.writeFile(after, 'utf8');
  } finally { await handle.close(); }
  // Once the mutation happened, always record it, even if cancellation arrived.
  await context.onChange({ path: relative, before, after });
  const patch = createPatch(relative, before ?? '', after, 'before', 'after', { timeout: 250, maxEditLength: 10_000 }) ?? '[Diff omitted: change is too large to render quickly.]';
  return bounded(`${edit ? `Updated ${relative} (${replacements} replacement${replacements === 1 ? '' : 's'})` : `${before === null ? 'Created' : 'Wrote'} ${relative}`}\n${patch}`);
}

/** Read a recovery target with the same policy as undo; never follows aliases. */
export async function readRestoreTarget(workspace: string, filePath: string): Promise<string | null> {
  const root = await fs.realpath(workspace);
  const absolute = await restorePath(root, filePath);
  try { return (await readAbsoluteText(absolute, EDIT_LIMIT, true)).content; }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}

interface RestoreTarget { change: FileChange; absolute: string; identity: { dev: number; ino: number } | null }
function restoreConflict(filePath: string): Error {
  return Object.assign(new Error(`Cannot restore ${filePath}: file changed or is no longer safe. Remaining changes were not restored.`), { status: 409 });
}
async function restorePath(root: string, filePath: string): Promise<string> {
  const absolute = await noSymlinkPath(root, filePath);
  if (await writablePath(root, filePath) !== absolute) throw restoreConflict(filePath);
  return absolute;
}
async function checkRestoreDescriptor(handle: Awaited<ReturnType<typeof fs.open>>, target: RestoreTarget): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > EDIT_LIMIT || (target.identity && (target.identity.dev !== stat.dev || target.identity.ino !== stat.ino))) throw restoreConflict(target.change.path);
  const bytes = Buffer.alloc(EDIT_LIMIT + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (target.change.after === null || !bytes.subarray(0, length).equals(Buffer.from(target.change.after, 'utf8'))) throw restoreConflict(target.change.path);
  target.identity ??= { dev: stat.dev, ino: stat.ino };
}

/** Preflight all targets, then recheck each descriptor immediately before undo.
 * Not a transaction against unrelated external writers: completed callbacks are
 * durable progress; callers must retain pending records when a later file fails.
 */
export async function restoreChanges(workspace: string, changes: FileChange[], onRestored: (change: FileChange) => void | Promise<void>): Promise<void> {
  if (!Array.isArray(changes) || changes.length > 10_000 || typeof onRestored !== 'function') throw new Error('Invalid restore request.');
  const root = await fs.realpath(workspace);
  const targets: RestoreTarget[] = [];
  const seen = new Set<string>();
  for (const value of changes) {
    if (!value || typeof value.path !== 'string' || !value.path || [value.before, value.after].some(text => text !== null && (typeof text !== 'string' || Buffer.byteLength(text) > EDIT_LIMIT || text.includes('\0')))) throw new Error('Invalid file-change snapshot.');
    const change = { path: value.path, before: value.before, after: value.after };
    const absolute = await restorePath(root, change.path);
    if (seen.has(absolute)) throw new Error('Duplicate restore targets are not allowed.');
    seen.add(absolute);
    const target: RestoreTarget = { change, absolute, identity: null };
    if (change.after === null) {
      try { await fs.lstat(absolute); throw restoreConflict(change.path); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    } else {
      let handle;
      try {
        handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        await checkRestoreDescriptor(handle, target);
      } catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ELOOP')) throw restoreConflict(change.path); throw error; }
      finally { await handle?.close(); }
    }
    targets.push(target);
  }
  for (const target of targets) {
    const { change, absolute } = target;
    if (await restorePath(root, change.path) !== absolute) throw restoreConflict(change.path);
    if (change.after === null && change.before === null) {
      try { await fs.lstat(absolute); throw restoreConflict(change.path); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    } else {
      if (change.after === null) {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await restorePath(root, change.path);
      }
      const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (change.after === null ? constants.O_CREAT | constants.O_EXCL : 0);
      let handle;
      try {
        handle = await fs.open(absolute, flags, 0o666);
        const descriptor = await handle.stat();
        await restorePath(root, change.path);
        const current = await fs.lstat(absolute);
        if (!current.isFile() || current.nlink !== 1 || current.dev !== descriptor.dev || current.ino !== descriptor.ino) throw restoreConflict(change.path);
        if (change.after !== null) await checkRestoreDescriptor(handle, target);
        if (change.before === null) await fs.unlink(absolute);
        else {
          const content = Buffer.from(change.before, 'utf8');
          let offset = 0;
          while (offset < content.length) {
            const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
            if (!bytesWritten) throw new Error('Restore could not write file contents.');
            offset += bytesWritten;
          }
          await handle.truncate(content.length);
        }
      } catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'EEXIST') || hasCode(error, 'ELOOP')) throw restoreConflict(change.path); throw error; }
      finally { await handle?.close(); }
    }
    await onRestored({ ...change });
  }
}

interface ProcessResult { output: string; code: number | null; signal: NodeJS.Signals | null; cancelled: boolean; timedOut: boolean; truncated: boolean }
async function runProcess(command: string, args: string[], cwd: string, signal: AbortSignal | undefined, timeout: number, env = process.env): Promise<ProcessResult> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = Buffer.alloc(0);
    let truncated = false;
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let killing = false;
    let code: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      const remaining = 64 * 1024 - output.length;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)]);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const killTree = (force: boolean) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => { child.kill(force ? 'SIGKILL' : 'SIGTERM'); });
        } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch (error) { if (!hasCode(error, 'ESRCH')) child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      signal?.removeEventListener('abort', abort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output: output.toString('utf8'), code, signal: exitSignal, cancelled, timedOut, truncated });
    };
    const stop = () => {
      if (killing || settled) return;
      killing = true;
      killTree(false);
      // Do not clear this on the parent's exit: descendants may ignore SIGTERM.
      hardKill = setTimeout(() => { killTree(true); hardKill = undefined; }, 200);
      fallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 1000);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (hardKill) clearTimeout(hardKill);
      reject(new Error(`Could not start ${path.basename(command)}: ${errorMessage(error)}`));
    });
    child.once('exit', (status, reason) => { code = status; exitSignal = reason; });
    child.once('close', finish);
  });
}

// This exception is private to Git status. Other tools still cannot resolve or
// read external worktree metadata. Git's reciprocal registration is evidence of
// a local worktree, not authentication against another process with the same UID.
async function gitMetadataPath(value: string, optional = false): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  let stat;
  try { stat = await fs.lstat(value); }
  catch (error) { if (optional && hasCode(error, 'ENOENT')) return null; throw error; }
  if (stat.isSymbolicLink() || await fs.realpath(value) !== path.resolve(value)) throw new Error('Unsafe Git metadata: symlinks outside the validated metadata layout are forbidden.');
  if (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1)) throw new Error('Unsafe Git metadata: expected a regular, non-hard-linked file.');
  return stat;
}
async function gitMetadataText(value: string, maximum = 4096): Promise<string> {
  const stat = await gitMetadataPath(value);
  if (!stat?.isFile() || stat.size > maximum) throw new Error('Invalid or oversized Git metadata file.');
  const handle = await fs.open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink > 1 || current.size > maximum) throw new Error('Git metadata changed while being validated.');
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum || bytes.subarray(0, bytesRead).includes(0)) throw new Error('Invalid Git metadata text.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await handle.close(); }
}
function gitPointer(value: string): string {
  const line = value.replace(/\r?\n$/, '');
  if (!line || /[\0\r\n]/.test(line)) throw new Error('Invalid Git metadata pointer.');
  return line;
}
async function statusMetadata(root: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const entry = path.join(root, '.git');
  const stat = await gitMetadataPath(entry, true);
  if (!stat) return null;
  if (stat.isDirectory()) return { gitDir: entry, commonDir: entry };
  const pointer = gitPointer(await gitMetadataText(entry));
  if (!pointer.startsWith('gitdir: ')) throw new Error('Invalid Git worktree metadata pointer.');
  const gitDir = path.resolve(root, pointer.slice(8));
  if (path.basename(path.dirname(gitDir)) !== 'worktrees' || ['.', '..'].includes(path.basename(gitDir))) throw new Error('Unregistered external Git metadata: expected a worktree registration.');
  const commonDir = path.dirname(path.dirname(gitDir));
  if (!(await gitMetadataPath(gitDir))?.isDirectory() || !(await gitMetadataPath(commonDir))?.isDirectory()) throw new Error('Invalid Git worktree metadata directories.');
  const common = gitPointer(await gitMetadataText(path.join(gitDir, 'commondir')));
  const backlink = gitPointer(await gitMetadataText(path.join(gitDir, 'gitdir')));
  if (path.resolve(gitDir, common) !== commonDir || path.resolve(gitDir, backlink) !== entry) throw new Error('Git worktree registration does not point back to this workspace.');
  for (const directory of ['objects', 'refs']) {
    if (!(await gitMetadataPath(path.join(commonDir, directory)))?.isDirectory()) throw new Error('Git worktree common directory is not a repository.');
  }
  await gitMetadataText(path.join(commonDir, 'HEAD'));
  await gitMetadataText(path.join(gitDir, 'HEAD'));
  await gitMetadataText(path.join(commonDir, 'config'), READ_LIMIT);
  return { gitDir, commonDir };
}
async function safeStatusConfig(gitDir: string, commonDir: string, root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const settings = ['core.fsmonitor=false', 'core.untrackedCache=false', `core.hooksPath=${nullFile}`, `core.excludesFile=${nullFile}`, `core.attributesFile=${nullFile}`, `core.worktree=${root}`, 'core.bare=false', 'core.sparseCheckout=false', 'submodule.recurse=false', 'protocol.allow=never', 'core.alternateRefsCommand='];
  for (const directory of new Set([gitDir, commonDir])) {
    for (const name of ['HEAD', 'index', 'packed-refs', 'shallow', 'info', 'info/exclude', 'objects', 'objects/info', 'objects/info/alternates', 'objects/info/http-alternates', 'refs']) {
      const file = path.join(directory, name);
      const stat = await gitMetadataPath(file, true);
      if (stat && name.endsWith('alternates') && (await gitMetadataText(file)).trim()) throw new Error('External Git object alternates are not supported for safe status.');
    }
  }
  // Parse local files only: never follow include/includeIf, and never expose
  // parser errors or config values (which may contain credentials) in results.
  for (const file of new Set([path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')])) {
    if (!await gitMetadataPath(file, true)) continue;
    await gitMetadataText(file, READ_LIMIT);
    const parsed = await runProcess('git', [`--git-dir=${nullFile}`, 'config', '--no-includes', '--file', file, '--null', '--list'], root, undefined, 2000, env);
    if (parsed.code !== 0 || parsed.timedOut || parsed.truncated) throw new Error('Could not safely parse Git configuration.');
    for (const item of parsed.output.split('\0')) {
      const key = item.split('\n', 1)[0];
      if (/^include(?:if\..+)?\.path$/i.test(key)) throw new Error('Git configuration includes are not supported for safe status.');
      const filter = /^filter\.(.+)\.(?:clean|process|required)$/i.exec(key);
      if (filter) settings.push(`filter.${filter[1]}.clean=`, `filter.${filter[1]}.process=`, `filter.${filter[1]}.required=false`);
    }
  }
  return [...new Set(settings)].flatMap(setting => ['-c', setting]);
}

export async function gitStatus(workspace: string): Promise<{ branch: string; files: { path: string; status: string }[]; isRepo: boolean }> {
  const empty = { branch: '', files: [], isRepo: false };
  const root = await resolveWorkspacePath(workspace, '');
  const metadata = await statusMetadata(root);
  if (!metadata) return empty;
  const env = Object.fromEntries(Object.entries(shellEnvironment()).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: path.dirname(root), GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' });
  let result: ProcessResult;
  try {
    const config = await safeStatusConfig(metadata.gitDir, metadata.commonDir, root, env);
    result = await runProcess('git', ['--no-optional-locks', `--git-dir=${metadata.gitDir}`, `--work-tree=${root}`, ...config, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal', '--ignore-submodules=all'], root, undefined, 5000, env);
  } catch (error) { if (errorMessage(error).includes('ENOENT')) return empty; throw error; }
  if (result.timedOut) throw new Error('Git status timed out.');
  if (result.code !== 0) throw new Error(`Git status failed (exit ${result.code ?? 'unknown'}); check repository metadata.`);
  const records = result.output.split('\0');
  if (result.truncated) records.pop();
  const branchLine = records.shift() ?? '';
  const branch = branchLine.replace(/^## /, '').replace(/^(?:No commits yet on |Initial commit on )/, '').split('...')[0];
  const files: { path: string; status: string }[] = [];
  for (let index = 0; index < records.length && files.length < 1000; index++) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!ignored(filePath)) files.push({ path: filePath, status: status.trim() });
    if (/[RC]/.test(status)) index++; // -z emits the destination first, then the source.
  }
  return { branch: branch === 'HEAD (no branch)' ? 'HEAD' : branch, files, isRepo: true };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Operation cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

// Regex matching runs off the server event loop, so even pathological expressions
// can be interrupted without freezing cancellation or other sessions.
async function grepFiles(args: Record<string, unknown>, context: ToolContext): Promise<string> {
  const pattern = textArg(args, 'pattern');
  if (pattern.length > 2000) throw new Error('Search pattern is too long.');
  const literal = boolArg(args, 'literal');
  const caseSensitive = boolArg(args, 'case_sensitive', true);
  const limit = numberArg(args, 'max_results', 100, 1000);
  const filter = args.glob === undefined ? '**/*' : globPattern(textArg(args, 'glob'));
  if (!literal) { try { new RegExp(pattern, caseSensitive ? '' : 'i'); } catch (error) { throw new Error(`Invalid regular expression: ${errorMessage(error)}`); } }
  const discovery = await discoverFiles(context.workspace, optionalPath(args), context.signal);
  const worker = new Worker(`
    const { parentPort, workerData: d } = require('node:worker_threads');
    const regex = d.literal ? null : new RegExp(d.pattern, d.caseSensitive ? '' : 'i');
    const needle = d.caseSensitive ? d.pattern : d.pattern.toLowerCase();
    parentPort.on('message', ({ text, limit }) => {
      const result = [];
      const lines = text.split(/\\r\\n|\\n|\\r/);
      for (let i = 0; i < lines.length && result.length < limit; i++) {
        const line = lines[i];
        if (regex ? regex.test(line) : (d.caseSensitive ? line : line.toLowerCase()).includes(needle)) result.push({ line: i + 1, text: line.slice(0, 1000) + (line.length > 1000 ? ' [line truncated]' : '') });
      }
      parentPort.postMessage(result);
    });
  `, { eval: true, workerData: { pattern, literal, caseSensitive } });
  let workerError: Error | undefined;
  const trackError = (error: Error) => { workerError = error; };
  worker.on('error', trackError);
  const lines: string[] = [];
  let incomplete = discovery.truncated;
  let skipped = 0;
  const deadline = Date.now() + 10_000;
  try {
    for (const file of discovery.files) {
      checkAbort(context.signal);
      if (Date.now() > deadline || lines.length >= limit || lines.join('\n').length >= OUTPUT_LIMIT) { incomplete = true; break; }
      if (!path.matchesGlob(file, filter)) continue;
      let data: Awaited<ReturnType<typeof readTextFile>>;
      try { data = await readTextFile(context.workspace, file, READ_LIMIT); }
      catch (error) {
        if (hasCode(error, 'ENOENT') || hasCode(error, 'EACCES') || /binary|UTF-8|regular file/i.test(errorMessage(error))) { skipped++; continue; }
        throw error;
      }
      incomplete ||= data.truncated;
      if (workerError) throw workerError;
      const matches = await new Promise<{ line: number; text: string }[]>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); worker.off('message', done); worker.off('error', fail); worker.off('exit', exited); context.signal.removeEventListener('abort', abort); };
        const done = (value: { line: number; text: string }[]) => { cleanup(); resolve(value); };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const exited = () => fail(new Error('Search worker stopped unexpectedly.'));
        const abort = () => fail(new Error('Search cancelled.'));
        const timer = setTimeout(() => fail(new Error('Regular expression timed out. Simplify the pattern or use literal: true.')), 1000);
        worker.once('message', done); worker.once('error', fail); worker.once('exit', exited);
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort(); else worker.postMessage({ text: data.content, limit: limit - lines.length + 1 });
      });
      for (const match of matches) {
        if (lines.length >= limit) { incomplete = true; break; }
        lines.push(`${file}:${match.line}:${match.text}`);
      }
    }
  } finally { await worker.terminate(); }
  return bounded(`${lines.join('\n') || 'No matches found.'}${incomplete ? '\n[Search truncated; narrow the path, glob, or pattern.]' : ''}${skipped ? `\n[Skipped ${skipped} binary or unreadable file(s).]` : ''}`);
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    if (address === '168.63.129.16') return false; // Cloud-host platform services.
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Only globally routed unicast. This also rejects mapped IPv4, NAT64,
  // link-local, multicast, unique-local, loopback and unspecified addresses.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [first, second = '0'] = normalized.split(':');
  const a = parseInt(first, 16), b = parseInt(second || '0', 16);
  return a >= 0x2000 && a < 0x3ffe && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}

async function publicUrl(input: string, signal: AbortSignal): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid URL. Use an absolute public HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid|onion|arpa)$/.test(hostname) || hostname === 'metadata.google.internal') throw new Error('Local or private network URLs are forbidden.');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await abortable(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error('URL resolves to a private, local, or reserved IP address.');
  return { url, address: addresses[0].address, family: addresses[0].family };
}

async function fetchResponse(target: Awaited<ReturnType<typeof publicUrl>>, signal: AbortSignal): Promise<{ status: number; location?: string; type: string; bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === 'https:' ? https : http).request(target.url, {
      method: 'GET', agent: false, signal,
      headers: { accept: 'text/*, application/json, application/xml;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'Lite/0.1' },
      // Pin the validated address, preserving the original hostname for TLS SNI
      // and Host. A second DNS answer cannot rebind the request to a private IP.
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.destroy();
        resolve({ status, location, type, bytes: Buffer.alloc(0), truncated: false });
        return;
      }
      if ((type && !/^(text\/|application\/(?:json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript)(?:;|$))/.test(type)) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy();
        reject(new Error('Response is binary or uses an unsupported content encoding.'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const finish = (truncated: boolean) => { if (settled) return; settled = true; resolve({ status, type, bytes: Buffer.concat(chunks), truncated }); };
      response.on('data', (chunk: Buffer) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = READ_LIMIT - total;
        chunks.push(bytes.subarray(0, remaining));
        total += Math.min(bytes.length, remaining);
        if (bytes.length > remaining) { finish(true); response.destroy(); }
      });
      response.once('end', () => finish(false));
      response.once('error', reject);
      response.once('aborted', () => { if (!settled) reject(new Error('HTTP response ended prematurely.')); });
    });
    request.once('error', reject);
    request.end();
  });
}
function htmlToText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (!value.startsWith('#')) return named[value.toLowerCase()] ?? entity;
    const number = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
  }).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function webFetch(args: Record<string, unknown>, context: ToolContext): Promise<string> {
  let input = textArg(args, 'url');
  if (input.length > 8192) throw new Error('URL is too long.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, numberArg(args, 'timeout_ms', 15_000, 30_000));
  try {
    checkAbort(context.signal);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const target = await publicUrl(input, controller.signal);
      const response = await abortable(fetchResponse(target, controller.signal), controller.signal);
      if (response.location) {
        if (redirect === 5) throw new Error('Too many HTTP redirects.');
        input = new URL(response.location, target.url).href;
        continue;
      }
      if (response.bytes.includes(0)) throw new Error('Response is binary, not UTF-8 text.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes, { stream: response.truncated }); }
      catch { throw new Error('Response is not valid UTF-8 text.'); }
      if (/html/.test(response.type)) text = htmlToText(text);
      return bounded(`HTTP ${response.status}\n${text}${response.truncated ? '\n[Response truncated]' : ''}`);
    }
    throw new Error('Too many HTTP redirects.');
  } catch (error) {
    if (controller.signal.aborted) throw new Error(context.signal.aborted ? 'Web fetch cancelled.' : 'Web fetch timed out.');
    throw new Error(`Web fetch failed: ${errorMessage(error)}`);
  } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
}

export async function executeTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
  checkAbort(context.signal);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  switch (name) {
    case 'read_file': {
      const offset = numberArg(args, 'offset', 1, 1_000_000);
      const limit = numberArg(args, 'limit', 2000, 2000);
      const file = await readFile(context.workspace, textArg(args, 'path'));
      checkAbort(context.signal);
      const lines = file.content.split(/\r\n|\n|\r/);
      if (lines.at(-1) === '') lines.pop();
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const output = selected.map((line, index) => `${offset + index}\t${line}`).join('\n');
      return bounded(`${output || (lines.length ? 'Offset is beyond the end of the available file content.' : '(Empty file)')}${file.truncated || offset - 1 + limit < lines.length ? '\n[File truncated; request a narrower range or use grep.]' : ''}`);
    }
    case 'write_file': return mutateFile(args, context, false);
    case 'edit_file': return mutateFile(args, context, true);
    case 'glob': {
      const pattern = globPattern(textArg(args, 'pattern'));
      const limit = numberArg(args, 'limit', 200, 1000);
      const found = await discoverFiles(context.workspace, optionalPath(args), context.signal);
      const matches = found.files.filter(file => path.matchesGlob(file, pattern));
      return bounded(`${matches.slice(0, limit).join('\n') || 'No files found.'}${found.truncated || matches.length > limit ? '\n[Results truncated; narrow the pattern or path.]' : ''}`);
    }
    case 'grep': return grepFiles(args, context);
    case 'bash': {
      const command = textArg(args, 'command');
      if (command.length > 128 * 1024 || command.includes('\0')) throw new Error('Command is too large or contains a null byte.');
      const cwd = await resolveWorkspacePath(context.workspace, optionalPath(args, 'cwd'));
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Command cwd must be a directory.');
      const result = await runProcess(process.platform === 'win32' ? 'bash.exe' : '/bin/bash', ['-c', command], cwd, context.signal, numberArg(args, 'timeout_ms', 30_000, 120_000), shellEnvironment());
      const status = result.cancelled ? 'Command cancelled.' : result.timedOut ? 'Command timed out.' : `Exit code: ${result.code ?? result.signal ?? 'unknown'}`;
      return `${bounded(result.output)}${result.truncated ? '\n[Process output truncated]' : ''}\n${status}`;
    }
    case 'web_fetch': return webFetch(args, context);
    case 'todo_read': return bounded(JSON.stringify(context.getTodos(), null, 2));
    case 'todo_write': {
      if (!Array.isArray(args.todos) || args.todos.length > 200) throw new Error('todos must be an array of at most 200 items.');
      const ids = new Set<string>();
      const todos: Todo[] = args.todos.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each todo must be an object.');
        const value = item as Record<string, unknown>;
        const id = value.id === undefined ? randomUUID() : textArg(value, 'id');
        const content = textArg(value, 'content');
        const status = textArg(value, 'status');
        if (id.length > 200 || content.length > 2000 || !['pending', 'in_progress', 'completed'].includes(status)) throw new Error('Invalid todo: check ID, content length, and status.');
        if (ids.has(id)) throw new Error('Todo IDs must be unique.');
        ids.add(id);
        return { id, content, status: status as Todo['status'] };
      });
      checkAbort(context.signal);
      await context.onTodos(todos);
      return bounded(JSON.stringify(todos, null, 2));
    }
    case 'task': {
      const prompt = textArg(args, 'prompt');
      if (prompt.length > 64 * 1024) throw new Error('Task prompt is too long.');
      if (!context.delegate) throw new Error('Task delegation is not configured for this session.');
      return bounded(await abortable(context.delegate(prompt), context.signal));
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
