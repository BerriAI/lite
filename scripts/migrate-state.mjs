import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import '../bin/check-node.mjs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
const { DatabaseSync } = await import('node:sqlite');

const args = process.argv.slice(2), workspaces = [];
let root = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
  else if (!args[i].startsWith('-')) workspaces.push(resolve(args[i]));
  else throw new Error('Usage: npm run migrate -- [--root INSTALLATION] [WORKSPACE ...]');
}
const copyOnce = (source, destination, transform) => {
  if (!existsSync(source) || existsSync(destination)) return false;
  const staging = `${destination}.migrating-${process.pid}`;
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
    transform?.(staging);
    renameSync(staging, destination);
    console.log(`Migrated ${basename(source)} → ${basename(destination)}`);
    return true;
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
};
const relativePath = value => typeof value === 'string' ? value.replace(/^\.lite\//, '.speedrail/') : value;
function renameConfig(directory) {
  for (const suffix of ['json', 'jsonc']) {
    const source = join(directory, `lite-tui.${suffix}`), target = join(directory, `speedrail-tui.${suffix}`);
    if (existsSync(source) && !existsSync(target)) renameSync(source, target);
  }
}
function migrateDatabase(directory) {
  const source = join(directory, 'lite.db');
  if (!existsSync(source)) return;
  const db = new DatabaseSync(source);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    db.exec('BEGIN IMMEDIATE');
    if (tables.has('session_profiles')) for (const row of db.prepare('SELECT session_id,data FROM session_profiles').all()) {
      const snapshot = JSON.parse(row.data);
      for (const source of snapshot.sources ?? []) source.path = relativePath(source.path);
      for (const skill of snapshot.skills ?? []) skill.path = relativePath(skill.path);
      db.prepare('UPDATE session_profiles SET data=? WHERE session_id=?').run(JSON.stringify(snapshot), row.session_id);
    }
    if (tables.has('settings')) {
      const row = db.prepare('SELECT data FROM settings WHERE id=1').get();
      if (row) {
        const settings = JSON.parse(row.data);
        for (const plugin of Object.values(settings.plugins ?? {})) for (const item of plugin.items ?? []) item.target = relativePath(item.target);
        db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(settings));
      }
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  renameSync(source, join(directory, 'speedrail.db'));
  for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) renameSync(source + suffix, join(directory, 'speedrail.db') + suffix);
}
const envFile = join(root, '.env');
const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const port = process.env.SPEEDRAIL_PORT || process.env.LITE_PORT || envText.match(/^(?:SPEEDRAIL|LITE)_PORT\s*=\s*["']?(\d+)/m)?.[1] || '3210';
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
  if (response.ok) throw new Error('Stop the local agent server before migrating its state.');
} catch (error) { if (error.message === 'Stop the local agent server before migrating its state.') throw error; }
if (process.env.LITE_DATA_DIR || process.env.SPEEDRAIL_DATA_DIR || /^(?:LITE|SPEEDRAIL)_DATA_DIR\s*=\s*\S/m.test(envText)) throw new Error('Custom data directory detected. Follow docs/upgrading.md before migrating.');
copyOnce(join(root, '.lite'), join(root, '.speedrail'), directory => { renameConfig(directory); migrateDatabase(directory); });
for (const workspace of new Set([root, ...workspaces])) {
  copyOnce(join(workspace, '.lite'), join(workspace, '.speedrail'), renameConfig);
  copyOnce(join(workspace, 'LITE.md'), join(workspace, 'SPEEDRAIL.md'));
  for (const suffix of ['json', 'jsonc']) copyOnce(join(workspace, `lite-tui.${suffix}`), join(workspace, `speedrail-tui.${suffix}`));
}
copyOnce(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'lite'), join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'speedrail'), renameConfig);
copyOnce(join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'lite'), join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'speedrail'));
if (envText) {
  const next = envText.replace(/^(\s*(?:export\s+)?)(LITE_)(\w+\s*=)/gm, '$1SPEEDRAIL_$3');
  if (next !== envText) {
    copyOnce(envFile, envFile + '.before-speedrail');
    writeFileSync(envFile, next, { mode: 0o600 });
    console.log('Updated environment variable names.');
  }
}
console.log('Migration complete. Original data is retained; existing Speedrail data is never overwritten.');
