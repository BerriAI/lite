import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hooks, type HookPayload } from '../server/hooks.js';
import type { HookConfig } from '../shared/hooks.js';

const payload = (overrides: Partial<HookPayload> = {}): HookPayload => ({ event: 'PreToolUse', sessionId: 's1', workspace: '/tmp', tool: 'write_file', args: { path: 'x' }, ...overrides });
const hook = (command: string, extra: Partial<HookConfig> = {}): HookConfig => ({ event: 'PreToolUse', command, ...extra });

describe('Hooks unit: capture, matcher filtering, and run()', () => {
  let directory: string;
  beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-hooks-'))); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('captureHooks merges app hooks with trusted-project hooks in order (app first)', async () => {
    await mkdir(join(directory, '.litespeed'), { recursive: true });
    await writeFile(join(directory, '.litespeed', 'hooks.json'), JSON.stringify({ version: 1, hooks: [{ event: 'Stop', command: 'echo project' }] }));
    const captured = new Hooks().captureHooks(directory, { hooks: [{ event: 'PreToolUse', command: 'echo app' }], trustedWorkspaces: [directory] });
    expect(captured.advisory).toBeUndefined();
    expect(captured.hooks).toEqual([{ event: 'PreToolUse', command: 'echo app' }, { event: 'Stop', command: 'echo project' }]);
  });

  it('an untrusted workspace skips project hooks with the advisory, keeping app hooks', async () => {
    await mkdir(join(directory, '.litespeed'), { recursive: true });
    await writeFile(join(directory, '.litespeed', 'hooks.json'), JSON.stringify({ version: 1, hooks: [{ event: 'Stop', command: 'echo project' }] }));
    const captured = new Hooks().captureHooks(directory, { hooks: [{ event: 'Stop', command: 'echo app' }], trustedWorkspaces: [] });
    expect(captured.hooks).toEqual([{ event: 'Stop', command: 'echo app' }]);
    expect(captured.advisory).toBe('Project hooks are present but this workspace is not trusted; enable in Settings.');
  });

  it('an untrusted workspace with NO hooks file stays silent', () => {
    const captured = new Hooks().captureHooks(directory, {});
    expect(captured).toEqual({ hooks: [] });
  });

  it('an invalid hooks.json in a trusted workspace is ignored with an advisory, never a throw', async () => {
    await mkdir(join(directory, '.litespeed'), { recursive: true });
    for (const bad of ['{not json', JSON.stringify({ version: 2, hooks: [] }), JSON.stringify({ version: 1, hooks: [{ event: 'NotAnEvent', command: 'x' }] }), JSON.stringify({ version: 1, hooks: [{ event: 'Stop', command: 'x'.repeat(1001) }] })]) {
      await writeFile(join(directory, '.litespeed', 'hooks.json'), bad);
      const captured = new Hooks().captureHooks(directory, { trustedWorkspaces: [directory] });
      expect(captured.hooks).toEqual([]);
      expect(captured.advisory).toContain('invalid and were ignored');
    }
  });

  it('trust matching is by canonical path: a non-canonical trusted entry does not match', async () => {
    await mkdir(join(directory, '.litespeed'), { recursive: true });
    await writeFile(join(directory, '.litespeed', 'hooks.json'), JSON.stringify({ version: 1, hooks: [{ event: 'Stop', command: 'echo project' }] }));
    const captured = new Hooks().captureHooks(directory, { trustedWorkspaces: [directory + '/'] });
    expect(captured.hooks).toEqual([]);
    expect(captured.advisory).toContain('not trusted');
  });

  it('select() filters by event and exact tool matcher; no matcher matches every tool', () => {
    const hooks = new Hooks();
    const captured = { hooks: [
      { event: 'PreToolUse', command: 'a', matcher: 'write_file' },
      { event: 'PreToolUse', command: 'b' },
      { event: 'PostToolUse', command: 'c', matcher: 'bash' },
      { event: 'Stop', command: 'd' },
    ] as HookConfig[] };
    expect(hooks.select(captured, 'PreToolUse', 'write_file').map(h => h.command)).toEqual(['a', 'b']);
    expect(hooks.select(captured, 'PreToolUse', 'bash').map(h => h.command)).toEqual(['b']);
    expect(hooks.select(captured, 'PostToolUse', 'bash').map(h => h.command)).toEqual(['c']);
    expect(hooks.select(captured, 'PostToolUse', 'write_file')).toEqual([]);
    expect(hooks.select(captured, 'Stop').map(h => h.command)).toEqual(['d']);
  });

  it('run() reports exit 0 with stdout, exit 2 with stderr, and other codes', async () => {
    const hooks = new Hooks();
    const ok = await hooks.run(payload(), hook('echo hello'), directory);
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.stdout.trim()).toBe('hello');
    const block = await hooks.run(payload(), hook('echo "no secrets" >&2; exit 2'), directory);
    expect(block.code).toBe(2);
    expect(block.stderr.trim()).toBe('no secrets');
    const warn = await hooks.run(payload(), hook('exit 1'), directory);
    expect(warn.code).toBe(1);
  });

  it('run() delivers the JSON payload on stdin', async () => {
    const result = await new Hooks().run(payload({ tool: 'bash', args: { command: 'ls' } }), hook('cat'), directory);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ event: 'PreToolUse', sessionId: 's1', workspace: '/tmp', tool: 'bash', args: { command: 'ls' } });
  });

  it('run() bounds stdout to 8 KiB without splitting characters', async () => {
    const result = await new Hooks().run(payload(), hook('head -c 20000 /dev/zero | tr "\\0" "x"'), directory);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(8192);
  });

  it('run() times out with the injectable timeout and reports timedOut, never throwing', async () => {
    const hooks = new Hooks(200);
    const started = Date.now();
    const result = await hooks.run(payload(), hook('sleep 30'), directory);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.timedOut).toBe(true);
  });

  it('run() survives a hook that never reads stdin', async () => {
    const result = await new Hooks().run(payload(), hook('exec 0<&-; echo ignored-stdin'), directory);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ignored-stdin');
  });
});
