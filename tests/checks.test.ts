import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandCheckKey } from '../server/checks.js';

let cwd: string;
beforeEach(async () => { cwd = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-check-key-'))); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
it('connects npm test to its exact Vitest script across output-only tail changes', async () => {
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  expect(await commandCheckKey(`cd ${cwd} && npm test 2>&1 | tail -50`, tmpdir())).toBe(await commandCheckKey('npx vitest run 2>&1 | tail -80', cwd));
});
it('keeps different suites, directories, and npm lifecycle hooks distinct', async () => {
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', pretest: 'node prepare.mjs' } }));
  const npm = await commandCheckKey('npm test', cwd);
  expect(npm).not.toBe(await commandCheckKey('npx vitest run', cwd));
  expect(npm).not.toBe(await commandCheckKey('npm test', tmpdir()));
  expect(await commandCheckKey('npx vitest run test-a', cwd)).not.toBe(await commandCheckKey('npx vitest run test-b', cwd));
});
it.each(['npm test; echo done', 'npm test || true', 'echo npm test', "npm test | tail -8; echo done", 'FLAG=x npm test'])('does not infer a passing check from compound or ambiguous shell text: %s', async command => {
  expect(await commandCheckKey(command, cwd)).toBeUndefined();
});
