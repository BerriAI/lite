import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { shellInspection } from '../server/shell-inspection.js';
import { executeTool, type ToolContext } from '../server/tools.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('recognizes the reported compound Git/log inspection and keeps quoted separators literal', () => {
  expect(shellInspection('git status --short; git branch --show-current; git remote -v; git diff --stat; git diff --check; tail -45 /tmp/log.txt; gh --version')).toHaveLength(7);
  expect(shellInspection('cat "file; with spaces" && pwd || gh --version')).toMatchObject([
    { command: 'cat', args: ['file; with spaces'], after: ';' }, { command: 'pwd', after: '&&' }, { command: 'gh', after: '||' },
  ]);
});
it.each([
  'git status; echo changed > file', 'git diff --output=file', 'git branch new-branch', 'git branch -D main',
  'git remote add other somewhere', 'git -c alias.status="!touch file" status', 'cat $(touch file)', 'cat `touch file`',
  'cat file > copy', 'cat file | bash', 'tail -f file', 'cat file &', 'cat <(touch file)', 'git status &&',
  'bash -c "git status"', 'GIT_EXTERNAL_DIFF=script git diff', 'git log --output=file', 'head -n bad file',
])('retains write coordination for unsupported or potentially mutating shell syntax: %s', command => {
  expect(shellInspection(command)).toBeNull();
});
it('executes Git inspection without running configured filters, fsmonitor, external diff, or refreshing the index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'litespeed-inspection-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  await writeFile(join(root, 'tracked.txt'), 'before\n'); git('add', 'tracked.txt'); git('commit', '-m', 'fixture');
  const marker = join(root, 'unexpected-write');
  const script = `sh -c 'touch "${marker}"'`;
  git('config', 'core.fsmonitor', script); git('config', 'diff.external', script);
  git('config', 'filter.inspect.clean', script); git('config', 'filter.inspect.required', 'true');
  git('config', 'diff.inspect.textconv', script);
  await writeFile(join(root, '.gitattributes'), '*.txt filter=inspect diff=inspect\n');
  await writeFile(join(root, 'tracked.txt'), 'after\n');
  const index = await readFile(join(root, '.git', 'index'));
  const context: ToolContext = { workspace: root, sessionId: 'test', signal: new AbortController().signal, onChange() {}, onTodos() {}, getTodos: () => [] };
  const result = await executeTool('bash', { command: 'git status --short; git branch --show-current; git remote -v; git diff --stat; git diff --check; tail -1 tracked.txt' }, context);
  expect(result).toContain('tracked.txt'); expect(result).toContain('after'); expect(result).toContain('Exit code: 0');
  expect(await readFile(join(root, '.git', 'index'))).toEqual(index);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
