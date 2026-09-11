import { LEGACY_NAMES } from '../bin/legacy.mjs';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import '../bin/check-node.mjs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
const { DatabaseSync } = await import('node:sqlite');

const args = process.argv.slice(2), workspaces = [];
let root = process.cwd(), destination;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--destination' && args[i + 1]) destination = resolve(args[++i]);
  else if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
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
const relativePath = value => typeof value === 'string' ? LEGACY_NAMES.reduce((text, name) => text.startsWith(`.${name}/`) ? '.litespeed/' + text.slice(name.length + 2) : text, value) : value;
function renameConfig(directory) {
  for (const name of LEGACY_NAMES) for (const suffix of ['json', 'jsonc']) {
    const source = join(directory, `${name}-tui.${suffix}`), target = join(directory, `litespeed-tui.${suffix}`);
    if (existsSync(source) && !existsSync(target)) renameSync(source, target);
  }
}
function migrateDatabase(directory) {
  const candidates = LEGACY_NAMES.map(name => join(directory, `${name}.db`)).filter(existsSync);
  if (candidates.length > 1) throw new Error('Multiple legacy databases found. Choose the data directory to migrate; databases are never merged.');
  if (!candidates.length) return;
  const source = candidates[0];
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
  renameSync(source, join(directory, 'litespeed.db'));
  for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) renameSync(source + suffix, join(directory, 'litespeed.db') + suffix);
}
const envFile = join(root, '.env');
const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const prefixes = ['LITESPEED', ...LEGACY_NAMES.map(name => name.toUpperCase())];
const port = prefixes.map(prefix => process.env[`${prefix}_PORT`]).find(Boolean) || envText.match(new RegExp(`^(?:${prefixes.join('|')})_PORT\\s*=\\s*[\"']?(\\d+)`, 'm'))?.[1] || '3210';
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
  if (response.ok) throw new Error('Stop the local agent server before migrating its state.');
} catch (error) { if (error.message === 'Stop the local agent server before migrating its state.') throw error; }
if ((destination ? prefixes.slice(1) : prefixes).some(prefix => process.env[`${prefix}_DATA_DIR`]) || envText.match(new RegExp(`^(?:${prefixes.join('|')})_DATA_DIR\\s*=\\s*\\S`, 'm'))) throw new Error('Custom data directory detected. Follow docs/upgrading.md before migrating.');
const target = destination || join(root, '.litespeed');
for (const name of LEGACY_NAMES) copyOnce(join(root, `.${name}`), target, directory => { renameConfig(directory); migrateDatabase(directory); });
for (const workspace of new Set([root, ...workspaces])) {
  for (const name of LEGACY_NAMES) {
    copyOnce(join(workspace, `.${name}`), join(workspace, '.litespeed'), directory => { renameConfig(directory); migrateDatabase(directory); });
    copyOnce(join(workspace, `${name.toUpperCase()}.md`), join(workspace, 'LITESPEED.md'));
    for (const suffix of ['json', 'jsonc']) copyOnce(join(workspace, `${name}-tui.${suffix}`), join(workspace, `litespeed-tui.${suffix}`));
  }
}
for (const name of LEGACY_NAMES) {
  copyOnce(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name), join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'litespeed'), renameConfig);
  copyOnce(join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), name), join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'litespeed'));
}
if (envText) {
  const next = envText.replace(new RegExp(`^(\\s*(?:export\\s+)?)(?:${LEGACY_NAMES.map(name => name.toUpperCase()).join('|')})_(\\w+\\s*=)`, 'gm'), '$1LITESPEED_$2');
  if (next !== envText) {
    copyOnce(envFile, envFile + '.before-litespeed');
    writeFileSync(envFile, next, { mode: 0o600 });
    console.log('Updated environment variable names.');
  }
}
console.log('Migration complete. Original data is retained; existing Litespeed data is never overwritten.');
