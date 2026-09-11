import { mkdir, readFile, writeFile, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installPackage } from './updates.mjs';
const [archive, metadata] = process.argv.slice(2);
if (!archive || !metadata) throw new Error('Run the Litespeed installer to install a package.');
const home = resolve(process.env.LITESPEED_INSTALL_DIR || join(homedir(), '.local/share/litespeed'));
const bin = resolve(process.env.LITESPEED_BIN_DIR || join(homedir(), '.local/bin'));
const launcher = join(bin, 'litespeed'), marker = '# Litespeed packaged launcher';
try {
  const info = await lstat(launcher);
  if (!info.isFile() || info.isSymbolicLink() || !(await readFile(launcher, 'utf8')).includes(marker)) throw new Error(`An existing command is at ${launcher}. Move it aside or choose LITESPEED_BIN_DIR; it was left unchanged.`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const release = JSON.parse(await readFile(metadata, 'utf8'));
await installPackage({ home, release, archive: resolve(archive) });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
await mkdir(bin, { recursive: true });
const temporary = `${launcher}.${randomUUID()}`;
await writeFile(temporary, `#!/bin/sh\n${marker}\nLITESPEED_INSTALL_DIR=${quote(home)}\nexport LITESPEED_INSTALL_DIR\n: "\${LITESPEED_DATA_DIR:=$HOME/.local/share/litespeed-data}"\nexport LITESPEED_DATA_DIR\nexec "$LITESPEED_INSTALL_DIR/current/runtime/node" "$LITESPEED_INSTALL_DIR/current/bin/litespeed.mjs" "$@"\n`, { mode: 0o755 });
try { await rename(temporary, launcher); } finally { await rm(temporary, { force: true }); }
console.log(`Installed Litespeed ${release.version}.\n\nIn your project, run:\n  ${launcher}\n\nUpdate any time with:\n  ${launcher} update\n`);
if (!process.env.PATH?.split(':').includes(bin)) {
  console.log(`Add this to your shell configuration so you can type litespeed:\n  export PATH=${quote(bin)}:"$PATH"\n`);
}
