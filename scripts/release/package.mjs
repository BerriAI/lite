import { cp, mkdir, mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const source = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const version = pkg.version, platform = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'darwin-x64'].includes(platform)) throw new Error('Build each package on its target Mac architecture.');
const nodeVersion = '26.8.1';
const output = resolve(process.argv[2] || join(source, 'release-artifacts'));
const temporary = await mkdtemp(join(tmpdir(), 'litespeed-package-')), root = join(temporary, 'litespeed');
const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  await mkdir(root); await mkdir(output, { recursive: true });
  for (const file of ['bin', 'tui', 'shared', 'dist', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    try { await cp(join(source, file), join(root, file), { recursive: true }); } catch (error) { if (file !== 'NOTICE' || error.code !== 'ENOENT') throw error; }
  }
  await mkdir(join(root,'research/shunt'),{recursive:true});
  await cp(join(source,'research/shunt/UPSTREAM-LICENSE'),join(root,'research/shunt/UPSTREAM-LICENSE'));
  await mkdir(join(root, 'scripts')); for (const file of ['prepare-terminal.mjs', 'migrate-state.mjs']) await cp(join(source, 'scripts', file), join(root, 'scripts', file));
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], root);
  const distribution = `node-v${nodeVersion}-${platform}`;
  for (const file of [`${distribution}.tar.gz`, 'SHASUMS256.txt']) run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--max-time', '300', `https://nodejs.org/dist/v${nodeVersion}/${file}`, '-o', join(temporary, file)]);
  const archive = await readFile(join(temporary, `${distribution}.tar.gz`));
  const expected = (await readFile(join(temporary, 'SHASUMS256.txt'), 'utf8')).split('\n').find(line => line.endsWith(`  ${distribution}.tar.gz`))?.split(' ')[0];
  if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Node runtime checksum mismatch.');
  run('/usr/bin/tar', ['-xzf', join(temporary, `${distribution}.tar.gz`), '-C', temporary]);
  await mkdir(join(root, 'runtime'));
  await cp(join(temporary, distribution, 'bin/node'), join(root, 'runtime/node'));
  await cp(join(temporary, distribution, 'LICENSE'), join(root, 'runtime/NODE-LICENSE'));
  const bunVersion = JSON.parse(await readFile(join(root, 'node_modules/bun/package.json'), 'utf8')).version;
  run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2', '--max-time', '30', `https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`, '-o', join(root, 'runtime/BUN-LICENSE.md')]);
  await writeFile(join(root, 'release.json'), JSON.stringify({ schema: 1, version, platform, nodeVersion }) + '\n');
  const dependencies = [];
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.')) continue;
      const location = join(directory, item.name);
      if (item.name.startsWith('@')) { await visit(location); continue; }
      try { const value = JSON.parse(await readFile(join(location, 'package.json'), 'utf8')); dependencies.push(`${value.name}@${value.version}: ${typeof value.license === 'string' ? value.license : JSON.stringify(value.license) || 'See package license files'}`); } catch {}
      try { await visit(join(location, 'node_modules')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await visit(join(root, 'node_modules'));
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.txt'), `Litespeed bundles Node.js and Bun with their third-party components.\nNode notices: runtime/NODE-LICENSE. Bun notices and relinking instructions: runtime/BUN-LICENSE.md. Dependency licenses are retained in node_modules.\n\n${dependencies.sort().join('\n')}\n`);
  run(join(root, 'runtime/node'), [join(root, 'bin/litespeed.mjs'), '--version'], root);
  const file = `litespeed-${version}-${platform}.tar.gz`, path = join(output, file);
  run('/usr/bin/tar', ['-czf', path, '-C', temporary, 'litespeed']);
  const asset = { file, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), size: (await stat(path)).size };
  await writeFile(join(output, `manifest-${platform}.json`), JSON.stringify({ schema: 1, version, assets: { [platform]: asset } }, null, 2) + '\n');
  console.log(`Packaged ${file} (${Math.round(asset.size / 1024 ** 2)} MiB)`);
} finally { await rm(temporary, { recursive: true, force: true }); }
