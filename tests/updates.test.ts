import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { installed, installPackage, manifest, newer, updateService } from '../bin/updates.mjs';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(version = '1.0.0', kind = 'valid') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-update-test-'))); roots.push(root);
  const packageRoot = join(root, 'speedrail'), platform = `${process.platform}-${process.arch}`;
  await mkdir(join(packageRoot, 'runtime'), { recursive: true }); await mkdir(join(packageRoot, 'bin'));
  await writeFile(join(packageRoot, 'runtime/node'), `#!/bin/sh\nprintf '%s\\n' '${kind === 'broken' ? 'broken' : version}'\n`, { mode: 0o755 });
  await writeFile(join(packageRoot, 'bin/speedrail.mjs'), '');
  await writeFile(join(packageRoot, 'release.json'), JSON.stringify({ schema: 1, version, platform }));
  if (kind === 'hardlink') await link(join(packageRoot, 'runtime/node'), join(packageRoot, 'runtime/node-copy'));
  if (kind === 'symlink') await symlink('/etc/passwd', join(packageRoot, 'external'));
  const file = `speedrail-${version}-${platform}.tar.gz`, archive = join(root, file);
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', root, 'speedrail']);
  const data = await readFile(archive);
  return { root, archive, release: { schema: 1, version, assets: { [platform]: { file, size: data.length, sha256: createHash('sha256').update(data).digest('hex') } } } };
}
describe('release metadata', () => {
  it('compares stable numeric versions and rejects prerelease/path injection metadata', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true); expect(newer('1.0.0', '1.0.0')).toBe(false); expect(newer('0.9.9', '1.0.0')).toBe(false);
    expect(newer('2.0.0-beta', '1.0.0')).toBe(false);
    for (const version of ['../../escape', '1.0.0-beta', '1.0.0; touch file', '01.0.0']) expect(() => manifest({ schema: 1, version, assets: {} })).toThrow();
  });
});
describe.skipIf(process.platform !== 'darwin')('macOS package installation', () => {
  it('installs and atomically upgrades while keeping old versions and separate user data', async () => {
    const first = await fixture(), second = await fixture('1.1.0');
    const home = join(first.root, 'install with spaces'), data = join(first.root, 'user-data');
    await mkdir(data); await writeFile(join(data, 'session.db'), 'existing session');
    await installPackage({ home, release: first.release, archive: first.archive });
    expect(await realpath(join(home, 'current'))).toBe(join(home, 'releases/1.0.0'));
    expect(await installed(join(home, 'current'))).toMatchObject({ home });
    await installPackage({ home, release: second.release, archive: second.archive });
    expect(await realpath(join(home, 'current'))).toBe(join(home, 'releases/1.1.0'));
    expect(await readFile(join(home, 'releases/1.0.0/release.json'), 'utf8')).toContain('1.0.0');
    expect(await readFile(join(data, 'session.db'), 'utf8')).toBe('existing session');
    await expect(installPackage({ home, release: first.release, archive: first.archive })).rejects.toThrow('Downgrades');
    expect(await realpath(join(home, 'current'))).toBe(join(home, 'releases/1.1.0'));
  });
  it.each(['checksum', 'broken', 'symlink'])('leaves the current version in place after a %s failure', async kind => {
    const first = await fixture(), second = await fixture('1.1.0', kind);
    const home = join(first.root, 'install');
    await installPackage({ home, release: first.release, archive: first.archive });
    if (kind === 'checksum') await writeFile(second.archive, 'corrupt');
    await expect(installPackage({ home, release: second.release, archive: second.archive })).rejects.toThrow();
    expect(await realpath(join(home, 'current'))).toBe(join(home, 'releases/1.0.0'));
  });
  it('accepts runtime hard links whose targets are both inside the package', async () => {
    const value = await fixture('1.0.0', 'hardlink');
    await expect(installPackage({ home: join(value.root, 'install'), release: value.release, archive: value.archive })).resolves.toMatchObject({ version: '1.0.0' });
  });
  it('serializes concurrent updates and refuses to adopt an unrelated directory', async () => {
    const first = await fixture(), home = join(first.root, 'install');
    await mkdir(home); await writeFile(join(home, 'user-file'), 'leave alone');
    await expect(installPackage({ home, release: first.release, archive: first.archive })).rejects.toThrow('not empty');
    await rm(join(home, 'user-file')); await installPackage({ home, release: first.release, archive: first.archive });
    await mkdir(join(home, 'update.lock'));
    await expect(installPackage({ home, release: first.release, archive: first.archive })).rejects.toThrow('Another install');
  });
  it('shares background checks, persists the cache, and exposes a staged restart', async () => {
    const first = await fixture(), second = await fixture('1.1.0'), home = join(first.root, 'install');
    await installPackage({ home, release: first.release, archive: first.archive });
    const root = join(home, 'releases/1.0.0'), directory = join(first.root, 'state');
    const fetchLatest = vi.fn(async () => second.release);
    const service = updateService({ root, version: '1.0.0', directory, fetchLatest });
    const statuses = await Promise.all([service.status(), service.status(), service.status()]);
    expect(fetchLatest).toHaveBeenCalledOnce(); expect(statuses[0]).toMatchObject({ available: true, packaged: true, restartRequired: false, latestVersion: '1.1.0' });
    const reopened = updateService({ root, version: '1.0.0', directory, fetchLatest });
    await reopened.status(); expect(fetchLatest).toHaveBeenCalledOnce();
    await installPackage({ home, release: second.release, archive: second.archive });
    expect(await reopened.status()).toMatchObject({ restartRequired: true, installedVersion: '1.1.0' });
  });
  it('does not make offline checks fatal or let a source checkout self-update', async () => {
    const first = await fixture(); const service = updateService({ root: first.root, version: '1.0.0', directory: join(first.root, 'state'), fetchLatest: async () => { throw new Error('Offline'); } });
    expect(await service.status()).toMatchObject({ available: false, error: 'Offline', packaged: false });
    await expect(service.install()).rejects.toThrow('Source checkouts');
  });
});
