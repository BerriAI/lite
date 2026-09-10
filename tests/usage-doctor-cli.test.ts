import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same one-fixture posture as tests/plugins-cli.test.ts: usage/doctor are plain
// request/response commands, so a single shared fixture server is enough.
const cli = fileURLToPath(new URL('../bin/speedrail.mjs', import.meta.url));
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

describe('spawned speedrail usage / speedrail doctor against a real fixture server', () => {
  let workspace: string, base: string, fixture: ReturnType<typeof start>;
  const environment = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(workspace, 'home'), TMPDIR: workspace,
    LANG: 'en_US.UTF-8', NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...extra,
  });
  beforeAll(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-usage-cli-')));
    await mkdir(join(workspace, 'home'));
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

  it('usage prints an honest empty state, then real totals after a run, and --json is machine-readable', async () => {
    const empty = await run(['usage']);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('No recorded usage in the last 30 days.');

    // A plain text run through the fixture provider reports usage {21, 13}.
    const turn = await run(['run', 'usage seeding prompt']);
    expect(turn.code, turn.stderr).toBe(0);

    const report = await run(['usage', '--days', '7']);
    expect(report.code, report.stderr).toBe(0);
    expect(report.stdout).toContain('fixture/cli-default');
    expect(report.stdout).toMatch(/in 21\b.*out 13\b/);
    expect(report.stdout).toContain('Costs are not computed');

    const json = await run(['usage', '--json']);
    expect(json.code, json.stderr).toBe(0);
    const data = JSON.parse(json.stdout);
    expect(data.totals).toMatchObject({ inputTokens: 21, outputTokens: 13, requests: 1 });
  });

  it('usage rejects an out-of-range --days locally', async () => {
    const result = await run(['usage', '--days', '500']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--days must be an integer between 1 and 90.');
  });

  it('doctor prints a redacted report and never the provider key; --reindex reports rebuild counts', async () => {
    const doctor = await run(['doctor']);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain('integrity ok');
    expect(doctor.stdout).toContain('key configured'); // hasKey: true, redacted.
    expect(doctor.stdout).toContain('host 127.0.0.1'); // Host only, never the full URL.
    expect(doctor.stdout).not.toContain('CLI_FIXTURE_KEY_DO_NOT_PRINT');
    expect(doctor.stdout).not.toContain('/v1'); // Path segments never leak.

    const json = await run(['doctor', '--json']);
    expect(json.code, json.stderr).toBe(0);
    const data = JSON.parse(json.stdout);
    expect(data.settings.providers.every((provider: { hasKey: boolean }) => provider.hasKey)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('CLI_FIXTURE_KEY_DO_NOT_PRINT');

    const reindex = await run(['doctor', '--reindex']);
    expect(reindex.code, reindex.stderr).toBe(0);
    expect(reindex.stdout).toMatch(/Search index rebuilt: \d+ sessions?, \d+ indexed parts?\./);
  });
});
