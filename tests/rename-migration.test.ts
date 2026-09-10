import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'speedrail-migration-')); roots.push(root);
  const env: NodeJS.ProcessEnv & { XDG_CONFIG_HOME: string; XDG_STATE_HOME: string } = { ...process.env, SPEEDRAIL_PORT: '1', XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') };
  delete env.SPEEDRAIL_DATA_DIR; delete env.LITE_DATA_DIR;
  const run = () => execFileSync(process.execPath, [resolve('scripts/migrate-state.mjs'), '--root', root], { env, encoding: 'utf8' });
  return { root, env, run };
}
it('migrates saved data, pinned paths and client preferences without rewriting user content or overwriting newer data', () => {
  const { root, env, run } = fixture(), old = join(root, '.lite');
  const store = new Store(old), session = store.createSession({ workspace: root, model: 'chosen-model' });
  store.saveSettings({ providers: [{ id: 'gateway', name: 'Gateway', kind: 'openai', baseUrl: 'https://gateway.example.com', apiKey: 'synthetic-private-key' }] });
  store.saveMessage({ id: 'original', sessionId: session.id, role: 'user', content: 'Keep the word Lite in this original message.', createdAt: 1 });
  store.db.prepare('INSERT INTO session_profiles(session_id,data) VALUES(?,?)').run(session.id, JSON.stringify({ instructions: 'Read .lite as written.', sources: [{ path: '.lite/profiles.json' }], skills: [{ path: '.lite/skills/review/SKILL.md', body: 'Keep Lite in this body.' }] }));
  store.close(); renameSync(join(old, 'speedrail.db'), join(old, 'lite.db'));
  writeFileSync(join(old, 'lite-tui.jsonc'), '{"theme":"rose-pine"}');
  mkdirSync(join(env.XDG_STATE_HOME, 'lite', 'tui'), { recursive: true });
  writeFileSync(join(env.XDG_STATE_HOME, 'lite', 'tui', 'history.json'), '["a saved draft"]');
  writeFileSync(join(root, '.env'), 'LITE_MODEL=chosen-model\nLITELLM_API_KEY=synthetic-env-key\n');
  expect(() => new Store(join(root, '.speedrail'))).toThrow('npm run migrate');
  const output = run(); expect(output).not.toContain('synthetic');
  const migrated = new Store(join(root, '.speedrail'));
  expect(migrated.session(session.id).model).toBe('chosen-model');
  expect(migrated.messages(session.id)[0].content).toBe('Keep the word Lite in this original message.');
  expect(migrated.settings().providers[0].apiKey).toBe('synthetic-private-key');
  const snapshot = JSON.parse((migrated.db.prepare('SELECT data FROM session_profiles').get() as { data: string }).data);
  expect(snapshot.sources[0].path).toBe('.speedrail/profiles.json'); expect(snapshot.skills[0].path).toBe('.speedrail/skills/review/SKILL.md'); expect(snapshot.instructions).toBe('Read .lite as written.');
  migrated.updateSession(session.id, { model: 'new-choice' }); migrated.close();
  expect(readFileSync(join(root, '.speedrail', 'speedrail-tui.jsonc'), 'utf8')).toContain('rose-pine');
  expect(readFileSync(join(env.XDG_STATE_HOME, 'speedrail', 'tui', 'history.json'), 'utf8')).toContain('a saved draft');
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SPEEDRAIL_MODEL=chosen-model\nLITELLM_API_KEY=synthetic-env-key\n');
  run(); const again = new Store(join(root, '.speedrail')); expect(again.session(session.id).model).toBe('new-choice'); again.close();
  const original = new DatabaseSync(join(old, 'lite.db'), { readOnly: true }); expect(JSON.parse((original.prepare('SELECT data FROM sessions').get() as { data: string }).data).model).toBe('chosen-model'); original.close();
});
