import { appendFile, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export async function configurePath({ bin, userHome, shell, zdotdir, skip = false }) {
  const line = `export PATH=${shellQuote(bin)}:"$PATH"`;
  if (skip) return { configured: false, line, files: [] };
  let files;
  switch (basename(shell || '/bin/zsh')) {
    case 'zsh': files = [join(zdotdir || userHome, '.zshrc')]; break;
    case 'bash': {
      let profile = join(userHome, '.bash_profile');
      for (const name of ['.bash_profile', '.bash_login', '.profile']) {
        const candidate = join(userHome, name);
        try { await readFile(candidate); profile = candidate; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      files = [profile, join(userHome, '.bashrc')]; break;
    }
    case 'sh': files = [join(userHome, '.profile')]; break;
    default: return { configured: false, line, files: [] };
  }
  for (const file of files) {
    let existing = '';
    try { existing = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing.split('\n').includes(line)) await appendFile(file, `${existing.endsWith('\n') || !existing ? '' : '\n'}\n# Litespeed\n${line}\n`, { mode: 0o600 });
  }
  return { configured: true, line, files };
}
