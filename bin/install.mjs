import { mkdir, readFile, writeFile, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installPackage } from './updates.mjs';
import { configurePath, shellQuote } from './install-path.mjs';
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
const quote = shellQuote;
await mkdir(bin, { recursive: true });
const temporary = `${launcher}.${randomUUID()}`;
await writeFile(temporary, `#!/bin/sh\n${marker}\nLITESPEED_INSTALL_DIR=${quote(home)}\nexport LITESPEED_INSTALL_DIR\n: "\${LITESPEED_DATA_DIR:=$HOME/.local/share/litespeed-data}"\nexport LITESPEED_DATA_DIR\nexec "$LITESPEED_INSTALL_DIR/current/runtime/node" "$LITESPEED_INSTALL_DIR/current/bin/litespeed.mjs" "$@"\n`, { mode: 0o755 });
try { await rename(temporary, launcher); } finally { await rm(temporary, { force: true }); }
let pathSetup;
try { pathSetup = await configurePath({bin,userHome:homedir(),shell:process.env.SHELL,zdotdir:process.env.ZDOTDIR,skip:process.env.LITESPEED_NO_MODIFY_PATH==='1'}); }
catch(error) { console.log(`Installed successfully, but could not update your shell configuration: ${error.message}`); }
console.log(`Installed Litespeed ${release.version}.\n`);
if(pathSetup?.configured)console.log(`Shell setup saved in ${pathSetup.files.join(', ')}. Open a new terminal, then run litespeed from your project.\n`);
if(!process.env.PATH?.split(':').includes(bin))console.log(`To use this terminal now, run:\n  export PATH=${quote(bin)}:"$PATH"\n  litespeed\n`);
else console.log('In your project, run:\n  litespeed\n');
if(!pathSetup?.configured)console.log(`To keep the command available, add your bin directory to your shell's PATH: ${bin}\n`);
console.log(`Update any time with: litespeed update\nDirect launcher: ${launcher}`);
