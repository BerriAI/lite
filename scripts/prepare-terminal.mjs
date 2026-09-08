import { chmod, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Some published Darwin prebuilds lose the executable bit on this helper.
// Repair only the package-owned binary; never change a user's shell permissions.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds');
  const entries = await readdir(root).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries.filter(name => name.startsWith('darwin-'))) {
    const helper = join(root, entry, 'spawn-helper');
    const info = await stat(helper).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isFile()) await chmod(helper, info.mode | 0o111);
  }
}
