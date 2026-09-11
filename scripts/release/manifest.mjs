import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { manifest } from '../../bin/updates.mjs';
const platforms = ['darwin-arm64', 'darwin-x64'];
const versions = await Promise.all(platforms.map(async platform => manifest(JSON.parse(await readFile(`release-artifacts/manifest-${platform}.json`, 'utf8')))));
if (versions.some(value => value.version !== versions[0].version)) throw new Error('Package versions do not match.');
const release = manifest({ schema: 1, version: versions[0].version, assets: Object.assign({}, ...versions.map(value => value.assets)) });
for (const asset of Object.values(release.assets)) {
  const data = await readFile(`release-artifacts/${asset.file}`);
  if (data.length !== asset.size || createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.file}`);
}
await writeFile('release-artifacts/manifest.json', JSON.stringify(release, null, 2) + '\n');
