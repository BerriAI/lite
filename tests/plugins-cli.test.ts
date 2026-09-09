import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same spawned-process posture as tests/cli.test.ts, but ONE fixture server for
// the whole file: plugin commands are plain request/response (no SSE, no PTY),
// so the per-test isolation cli.test.ts needs is not worth the boot cost here.
const cli = fileURLToPath(new URL('../bin/lite.mjs', import.meta.url));
const fixtureEntry = fileURLToPath(new URL('./fixtures/cli-server.ts', import.meta.url));
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
interface Result { code: number | null; stdout: string; stderr: string }

function start(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = new Promise<Result>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, result, stdout: () => stdout };
}

describe('spawned lite plugin subcommands against a real fixture server', () => {
  let workspace: string, pkg: string, base: string, fixture: ReturnType<typeof start>;
  const environment = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(workspace, 'home'), TMPDIR: workspace,
    LANG: 'en_US.UTF-8', NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...extra,
  });
  beforeAll(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-plugins-cli-')));
    await mkdir(join(workspace, 'home'));
    pkg = join(workspace, 'pkg'); await mkdir(pkg);
    await writeFile(join(pkg, 'notes.md'), '# Notes command\n');
    await writeFile(join(pkg, 'lite-plugin.json'), JSON.stringify({ name: 'cli-kit', version: '0.9.0', commands: [{ name: 'notes', path: 'notes.md' }], mcpServers: { helper: { command: 'helper-server' } } }));
    fixture = start(['--import', loader, fixtureEntry], workspace, environment({ CLI_TEST_WORKSPACE: workspace }));
    const startAt = Date.now();
    while (!fixture.stdout().includes('\n')) {
      if (fixture.child.exitCode !== null || Date.now() - startAt > 15000) throw new Error('CLI fixture did not start.');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    base = JSON.parse(fixture.stdout().split('\n')[0]).base;
  });
  afterAll(async () => {
    fixture?.child.kill('SIGTERM');
    await fixture?.result.catch(() => {});
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });
  async function run(args: string[]): Promise<Result> {
    const proc = start([cli, ...args, '--url', base], workspace, environment());
    proc.child.stdin.end();
    return proc.result;
  }

  it('plan prints the action table without applying; install lands items; list and remove round-trip', async () => {
    const plan = await run(['plugin', 'plan', pkg, '--workspace', workspace]);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('Plugin: cli-kit@0.9.0');
    expect(plan.stdout).toMatch(/add\s+command\s+notes\s+-> \.lite\/commands\/notes\.md/);
    expect(plan.stdout).toMatch(/add\s+mcp\s+helper\s+-> mcpServers\.helper/);
    expect(plan.stdout).toContain('Dry run only.');
    await expect(readFile(join(workspace, '.lite', 'commands', 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    const install = await run(['plugin', 'install', pkg, '--workspace', workspace]);
    expect(install.code, install.stderr).toBe(0);
    expect(install.stdout).toContain('Installed cli-kit@0.9.0: 2 items landed.');
    expect(install.stdout).toContain('MCP servers were installed DISABLED');
    expect(await readFile(join(workspace, '.lite', 'commands', 'notes.md'), 'utf8')).toBe('# Notes command\n');

    const list = await run(['plugin', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('cli-kit@0.9.0  2 items');

    const removed = await run(['plugin', 'remove', 'cli-kit', '--workspace', workspace]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stdout).toContain('Removed command: .lite/commands/notes.md');
    expect(removed.stdout).toContain('Uninstalled cli-kit (2 items removed).');
    await expect(readFile(join(workspace, '.lite', 'commands', 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run(['plugin', 'list'])).stdout).toContain('No plugins installed.');
  });

  it('rejects bad plugin invocations locally and surfaces server-side manifest errors', async () => {
    for (const args of [['plugin'], ['plugin', 'unknown'], ['plugin', 'plan'], ['plugin', 'remove'], ['plugin', 'plan', 'a', 'b']]) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('Usage: lite plugin plan <dir> | install <dir> | list | remove <name>');
    }
    const hostile = join(workspace, 'hostile'); await mkdir(hostile, { recursive: true });
    await writeFile(join(hostile, 'lite-plugin.json'), JSON.stringify({ name: 'hostile', version: '1', commands: [{ name: 'x', path: '../escape.md' }] }));
    const result = await run(['plugin', 'plan', hostile, '--workspace', workspace]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must stay inside the package directory');
  });
});
