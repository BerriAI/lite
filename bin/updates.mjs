import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, readdir, realpath, lstat, symlink } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const exec = promisify(execFile);
export const RELEASES = 'https://github.com/BerriAI/speedrail/releases';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newer(candidate, current) {
  if (!stable.test(candidate) || !stable.test(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function manifest(value) {
  if (!value || value.schema !== 1 || !stable.test(value.version) || !value.assets || typeof value.assets !== 'object') throw new Error('Invalid Speedrail release manifest.');
  for (const [platform, asset] of Object.entries(value.assets)) {
    if (!['darwin-arm64', 'darwin-x64'].includes(platform) || !asset || asset.file !== `speedrail-${value.version}-${platform}.tar.gz` || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1024 ** 3) throw new Error('Invalid Speedrail release asset.');
  }
  if (!Object.keys(value.assets).length) throw new Error('The release has no packages.');
  return value;
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function installed(root) {
  try {
    root = await realpath(root);
    const release = await json(join(root, 'release.json'));
    const home = resolve(root, '../..');
    const marker = await json(join(home, 'install.json'));
    if (marker.product !== 'speedrail' || marker.schema !== 1 || !stable.test(release.version) || resolve(home, 'releases', release.version) !== await realpath(root)) return null;
    return { home, release };
  } catch { return null; }
}
export async function latest() {
  const response = await fetch(`${RELEASES}/latest/download/manifest.json`, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Speedrail update check' } });
  if (!response.ok) throw new Error(response.status === 404 ? 'No packaged release is available yet.' : `Update check failed (HTTP ${response.status}).`);
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) throw new Error('Release manifest is too large.'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel(); }
  return manifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
async function hash(path) { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); }
async function validateTree(root, directory = root, links = new Map()) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) { const target = await realpath(path), local = relative(root, target); if (local === '..' || local.startsWith('../') || isAbsolute(local)) throw new Error('Package contains an external symlink.'); }
    else if (info.isDirectory()) await validateTree(root, path, links);
    else if (!info.isFile()) throw new Error('Package contains an unsupported file.');
    else { const key = `${info.dev}:${info.ino}`, group = links.get(key) || { count: 0, total: info.nlink }; group.count++; links.set(key, group); }
  }
  if (directory === root && [...links.values()].some(group => group.count !== group.total)) throw new Error('Package contains an external hard link.');
}
export async function installPackage({ home, release, archive, platform = `${process.platform}-${process.arch}` }) {
  release = manifest(release);
  const asset = release.assets[platform];
  if (!asset || platform !== `${process.platform}-${process.arch}`) throw new Error('This release does not support this Mac architecture.');
  home = resolve(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  home = await realpath(home);
  const markerPath = join(home, 'install.json');
  try { const marker = await json(markerPath); if (marker.schema !== 1 || marker.product !== 'speedrail') throw new Error('That directory belongs to a different installation.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; if ((await readdir(home)).length) throw new Error('Installation directory is not empty. Choose a new directory.'); await writeFile(markerPath, JSON.stringify({ schema: 1, product: 'speedrail' }), { flag: 'wx', mode: 0o600 }); }
  const lock = join(home, 'update.lock');
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Another install or update is running. If it was interrupted, remove ${lock} and retry.`); throw error; }
  const temporary = await mkdtemp(join(home, '.update-'));
  try {
    let current; try { current = await json(join(home, 'current/release.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current && newer(current.version, release.version)) throw new Error('A newer version is already installed. Downgrades are not automatic.');
    const target = join(home, 'releases', release.version);
    let prior;
    try { prior = await json(join(target, 'release.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (prior && prior.archiveSha256 !== asset.sha256) throw new Error('An existing version has a different checksum. It was left unchanged.');
    if (!prior) {
      const download = archive || join(temporary, asset.file);
      if (!archive) {
        const response = await fetch(`${RELEASES}/download/v${release.version}/${asset.file}`, { signal: AbortSignal.timeout(300000) });
        if (!response.ok || !response.body) throw new Error(`Package download failed (HTTP ${response.status}).`);
        let bytes = 0;
        await pipeline(Readable.fromWeb(response.body), async function* (source) { for await (const chunk of source) { bytes += chunk.length; if (bytes > asset.size) throw new Error('Package exceeds the published size.'); yield chunk; } }, createWriteStream(download, { flags: 'wx', mode: 0o600 }));
      }
      if ((await lstat(download)).size !== asset.size || await hash(download) !== asset.sha256) throw new Error('Package checksum or size mismatch. The installed version was left unchanged.');
      const { stdout } = await exec('/usr/bin/tar', ['-tzf', download], { maxBuffer: 16 * 1024 ** 2 });
      const names = stdout.trim().split('\n');
      if (names.some(name => !name.startsWith('speedrail/') || name.split('/').includes('..') || name.includes('\\'))) throw new Error('Package contains an unsafe path.');
      await exec('/usr/bin/tar', ['-xzf', download, '-C', temporary], { maxBuffer: 1024 ** 2 });
      const unpacked = join(temporary, 'speedrail');
      await validateTree(unpacked);
      const descriptor = await json(join(unpacked, 'release.json'));
      if (descriptor.version !== release.version || descriptor.platform !== platform) throw new Error('Package version or architecture does not match its manifest.');
      const { stdout: version } = await exec(join(unpacked, 'runtime/node'), [join(unpacked, 'bin/speedrail.mjs'), '--version'], { timeout: 15000 });
      if (version.trim() !== release.version) throw new Error('The downloaded Speedrail could not start.');
      await writeFile(join(unpacked, 'release.json'), JSON.stringify({ ...descriptor, archiveSha256: asset.sha256 }) + '\n');
      await mkdir(dirname(target), { recursive: true });
      await rename(unpacked, target);
    }
    const next = join(home, `.current-${randomUUID()}`);
    await symlink(join('releases', release.version), next);
    try { await rename(next, join(home, 'current')); } finally { await rm(next, { force: true }); }
    return { version: release.version, root: target };
  } finally { await rm(temporary, { recursive: true, force: true }); await rm(lock, { recursive: true, force: true }); }
}
export function updateService({ root, version, directory, fetchLatest = latest }) {
  let cache, loading, pending, updating;
  const cachePath = join(directory, 'updates.json');
  async function status(force = false) {
    const installation = await installed(root);
    if (!cache) { const saved = await (loading ||= json(cachePath).catch(() => ({}))); cache ||= saved; }
    const age = Date.now() - (cache.checkedAt || 0);
    if ((force || process.env.SPEEDRAIL_NO_UPDATE_CHECK !== '1') && (force ? age > 1000 : age > (cache.error ? 3600000 : 86400000))) {
      pending ||= (async () => {
        try { cache = { release: await fetchLatest(), checkedAt: Date.now() }; }
        catch (error) { cache = { ...cache, checkedAt: Date.now(), error: error.message }; }
        try { await mkdir(directory, { recursive: true, mode: 0o700 }); const path = `${cachePath}.${randomUUID()}`; await writeFile(path, JSON.stringify(cache), { mode: 0o600 }); await rename(path, cachePath); } catch { /* A read-only cache never blocks startup. */ }
      })().finally(() => { pending = undefined; });
      await pending;
    }
    let release; try { if (cache.release) release = manifest(cache.release); } catch { /* Discard invalid cached metadata. */ }
    const available = Boolean(release && newer(release.version, version));
    let next; if (installation) { try { next = (await json(join(installation.home, 'current/release.json'))).version; } catch { /* The current running version remains usable. */ } }
    return { currentVersion: version, latestVersion: release?.version, available, packaged: Boolean(installation), installedVersion: next, restartRequired: Boolean(next && newer(next, version)), checkedAt: cache.checkedAt, error: cache.error, releaseUrl: release ? `${RELEASES}/tag/v${release.version}` : RELEASES, command: installation ? 'speedrail update' : 'Update your source checkout and rebuild, or install the macOS package.' };
  }
  async function install() {
    const installation = await installed(root);
    if (!installation) throw new Error('Automatic updates require the macOS package. Source checkouts are updated with Git.');
    if (updating) return updating;
    updating = (async () => {
      await status(true);
      if (!cache.release) throw new Error(cache.error || 'No release is available.');
      const release = manifest(cache.release);
      if (newer(release.version, version)) await installPackage({ home: installation.home, release });
      return status();
    })().finally(() => { updating = undefined; });
    return updating;
  }
  return { status, install };
}
