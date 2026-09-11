import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

function launch(entry: string, version: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
    Object.defineProperty(process, 'version', { value: ${JSON.stringify('v' + version)} });
    process.argv = [process.execPath, ${JSON.stringify(resolve(entry))}, '--help'];
    await import(${JSON.stringify(pathToFileURL(resolve(entry)).href)});
  `], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 5000 });
}

it.each(['20.20.2', '22.13.0', '26.3.0'])('stops unsupported Node %s with upgrade instructions', version => {
  const result = launch('bin/litespeed.mjs', version);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires Node.js 26.4 or later');
  expect(result.stderr).toContain(`running v${version}`);
  expect(result.stderr).toContain('node --version');
  expect(result.stderr).not.toContain('ERR_UNKNOWN_BUILTIN_MODULE');
});

it('allows the declared minimum to reach CLI help', () => {
  const result = launch('bin/litespeed.mjs', '26.4.0');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('litespeed serve');
});

it('checks the runtime even when npm engine enforcement is overridden', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(manifest.engines.node).toBe('>=26.4.0');
  expect(manifest.scripts.preinstall).toBe('node bin/check-node.mjs');
  expect(readFileSync('.npmrc', 'utf8')).toContain('engine-strict=true');
  const result = launch('bin/check-node.mjs', '20.20.2');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires Node.js 26.4 or later');
});
