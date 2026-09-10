import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { planInstall, applyInstall, uninstall } from '../server/plugins.js';
import type { HookConfig } from '../shared/hooks.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('plugin packages: plan, apply, uninstall', () => {
  let dir: string, workspace: string, pkg: string, store: Store;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-plugins-')));
    workspace = join(dir, 'workspace'); pkg = join(dir, 'pkg');
    await mkdir(workspace); await mkdir(pkg);
    store = new Store(join(dir, 'state'));
    store.saveSettings({ workspace });
  });
  afterEach(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  async function writeManifest(manifest: unknown, root = pkg) {
    await writeFile(join(root, 'speedrail-plugin.json'), JSON.stringify(manifest));
  }
  async function fullPackage() {
    await mkdir(join(pkg, 'skills'), { recursive: true });
    await writeFile(join(pkg, 'skills', 'review.md'), 'REVIEW SKILL BODY\n');
    await writeFile(join(pkg, 'deploy.md'), '# Deploy\nRun the deploy checklist.\n');
    await writeManifest({
      name: 'toolkit', version: '1.2.0', description: 'A test toolkit.',
      skills: [{ id: 'review', path: 'skills/review.md' }],
      commands: [{ name: 'deploy', path: 'deploy.md' }],
      mcpServers: { docs: { command: 'docs-server', args: ['--stdio'], env: { DOCS_TOKEN: 'value' } } },
      hooks: [{ event: 'PreToolUse', command: 'echo pre', matcher: 'bash' }],
    });
  }

  it('plans a full package with previews and no conflicts in a clean workspace', async () => {
    await fullPackage();
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.plugin).toEqual({ name: 'toolkit', version: '1.2.0', description: 'A test toolkit.' });
    expect(plan.warnings).toEqual([]);
    expect(plan.unmapped).toBeUndefined();
    expect(plan.actions.map(action => [action.kind, action.name, action.target, action.conflict])).toEqual([
      ['skill', 'review', '.speedrail/skills/review/SKILL.md', undefined],
      ['command', 'deploy', '.speedrail/commands/deploy.md', undefined],
      ['mcp', 'docs', 'mcpServers.docs', undefined],
      ['hook', 'PreToolUse', expect.stringMatching(/^hooks#[a-f0-9]{16}$/), undefined],
    ]);
    expect(plan.actions[0].preview).toBe('REVIEW SKILL BODY\n');
    // The MCP plan preview shows enabled:false explicitly — the reviewed plan
    // IS what lands, not a hidden apply-time patch.
    expect(plan.actions[2].preview).toContain('"enabled":false');
  });

  it('bounds every plan preview to 500 characters', async () => {
    await writeFile(join(pkg, 'big.md'), 'x'.repeat(5000));
    await writeManifest({ name: 'big', version: '1', commands: [{ name: 'big', path: 'big.md' }] });
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.actions[0].preview).toHaveLength(500);
  });

  it.each([
    { name: 'missing manifest', setup: async () => {}, message: /No plugin manifest found/ },
    { name: 'invalid JSON', setup: async () => writeFile(join(pkg, 'speedrail-plugin.json'), '{nope'), message: /not valid JSON/ },
    { name: 'bad name', setup: async () => writeManifest({ name: 'Bad Name', version: '1' }), message: /Invalid speedrail-plugin\.json/ },
    { name: 'unknown key', setup: async () => writeManifest({ name: 'x', version: '1', extra: true }), message: /Invalid speedrail-plugin\.json/ },
    { name: 'duplicate skill ids', setup: async () => writeManifest({ name: 'x', version: '1', skills: [{ id: 'a', path: 'a.md' }, { id: 'a', path: 'b.md' }] }), message: /Invalid speedrail-plugin\.json/ },
    { name: 'mcp with both command and url', setup: async () => writeManifest({ name: 'x', version: '1', mcpServers: { s: { command: 'c', url: 'https://example.com' } } }), message: /Invalid speedrail-plugin\.json/ },
    { name: 'mcp choosing its own enabled', setup: async () => writeManifest({ name: 'x', version: '1', mcpServers: { s: { command: 'c', enabled: true } } }), message: /Invalid speedrail-plugin\.json/ },
    { name: 'oversized version', setup: async () => writeManifest({ name: 'x', version: 'v'.repeat(40) }), message: /Invalid speedrail-plugin\.json/ },
    { name: 'credential-name skill id', setup: async () => writeManifest({ name: 'x', version: '1', skills: [{ id: 'private-key', path: 'a.md' }] }), message: /Invalid speedrail-plugin\.json/ },
  ])('rejects invalid manifests: $name', async ({ setup, message }) => {
    await setup();
    await expect(planInstall(pkg, workspace, store)).rejects.toThrow(message);
  });

  it('rejects path traversal out of the package directory', async () => {
    await writeFile(join(dir, 'outside.md'), 'ESCAPED CONTENT');
    for (const escape of ['../outside.md', 'nested/../../outside.md', '/etc/hosts']) {
      await writeManifest({ name: 'hostile', version: '1', commands: [{ name: 'steal', path: escape }] });
      await expect(planInstall(pkg, workspace, store)).rejects.toThrow(/must stay inside the package directory|not a safe relative path/);
    }
  });

  it('rejects symlinks that point out of the package, on any path component', async () => {
    await writeFile(join(dir, 'secret.md'), 'OUTSIDE SECRET');
    await symlink(join(dir, 'secret.md'), join(pkg, 'linked.md'));
    await writeManifest({ name: 'hostile', version: '1', commands: [{ name: 'steal', path: 'linked.md' }] });
    await expect(planInstall(pkg, workspace, store)).rejects.toThrow(/symbolic link/);
    // Directory symlink: an in-bounds-looking relative path through a linked dir.
    await symlink(dir, join(pkg, 'linkdir'));
    await writeManifest({ name: 'hostile', version: '1', commands: [{ name: 'steal', path: 'linkdir/secret.md' }] });
    await expect(planInstall(pkg, workspace, store)).rejects.toThrow(/symbolic link/);
  });

  it('rejects a package directory that is or contains the workspace', async () => {
    await writeManifest({ name: 'x', version: '1' }, workspace);
    await expect(planInstall(workspace, workspace, store)).rejects.toThrow(/cannot be the workspace/);
    await writeManifest({ name: 'x', version: '1' }, dir);
    await expect(planInstall(dir, workspace, store)).rejects.toThrow(/cannot be the workspace/);
  });

  it('rejects a missing source directory with the clone-first guidance', async () => {
    await expect(planInstall('https://github.com/example/plugin.git', workspace, store)).rejects.toThrow(/Git URLs are not supported: clone the package locally first/);
  });

  it('marks foreign existing files and settings keys as exists-conflicts with warnings', async () => {
    await fullPackage();
    await mkdir(join(workspace, '.speedrail', 'skills', 'review'), { recursive: true });
    await writeFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'), 'USER OWNED SKILL');
    store.saveSettings({ mcpServers: { docs: { url: 'https://user-configured.example/mcp' } }, hooks: [{ event: 'PreToolUse', command: 'echo pre', matcher: 'bash' }] });
    const plan = await planInstall(pkg, workspace, store);
    const byKind = Object.fromEntries(plan.actions.map(action => [action.kind, action.conflict]));
    expect(byKind).toEqual({ skill: 'exists', command: undefined, mcp: 'exists', hook: 'exists' });
    expect(plan.warnings.join(' ')).toMatch(/Skill "review" conflicts/);
    expect(plan.warnings.join(' ')).toMatch(/MCP server "docs" conflicts/);
    expect(plan.warnings.join(' ')).toMatch(/Hook "PreToolUse: echo pre" already exists/);
  });

  it('applies a plan: files land, MCP lands disabled, hooks appended, provenance recorded with hashes', async () => {
    await fullPackage();
    const plan = await planInstall(pkg, workspace, store);
    const result = await applyInstall(plan, workspace, store);
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('REVIEW SKILL BODY\n');
    expect(await readFile(join(workspace, '.speedrail', 'commands', 'deploy.md'), 'utf8')).toBe('# Deploy\nRun the deploy checklist.\n');
    const settings = store.settings();
    expect(settings.mcpServers.docs).toEqual({ command: 'docs-server', args: ['--stdio'], env: { DOCS_TOKEN: 'value' }, enabled: false });
    expect(settings.hooks).toEqual([{ event: 'PreToolUse', command: 'echo pre', matcher: 'bash' }]);
    const entry = settings.plugins?.toolkit;
    expect(entry).toMatchObject({ version: '1.2.0', workspace });
    expect(entry?.items).toHaveLength(4);
    expect(entry?.items.find(item => item.kind === 'skill')).toEqual({ kind: 'skill', target: '.speedrail/skills/review/SKILL.md', hash: sha256('REVIEW SKILL BODY\n') });
    for (const item of entry?.items ?? []) expect(item.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.entry).toEqual(entry);
  });

  it('skips exists-conflicted actions at apply: the foreign file and settings key survive untouched', async () => {
    await fullPackage();
    await mkdir(join(workspace, '.speedrail', 'skills', 'review'), { recursive: true });
    await writeFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'), 'USER OWNED SKILL');
    store.saveSettings({ mcpServers: { docs: { url: 'https://user-configured.example/mcp' } } });
    const plan = await planInstall(pkg, workspace, store);
    await applyInstall(plan, workspace, store);
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('USER OWNED SKILL');
    expect(store.settings().mcpServers.docs).toEqual({ url: 'https://user-configured.example/mcp' });
    // Provenance records only what actually landed.
    expect(store.settings().plugins?.toolkit?.items.map(item => item.kind).sort()).toEqual(['command', 'hook']);
  });

  it('reinstall of the same plugin is an update: owned files overwritten, provenance replaced, no duplicate hooks', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    await writeFile(join(pkg, 'skills', 'review.md'), 'REVIEW SKILL BODY v2\n');
    await writeManifest({
      name: 'toolkit', version: '1.3.0',
      skills: [{ id: 'review', path: 'skills/review.md' }],
      commands: [{ name: 'deploy', path: 'deploy.md' }],
      mcpServers: { docs: { command: 'docs-server', args: ['--stdio'], env: { DOCS_TOKEN: 'value' } } },
      hooks: [{ event: 'PreToolUse', command: 'echo pre', matcher: 'bash' }],
    });
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.actions.map(action => action.conflict)).toEqual(['same-plugin-update', 'same-plugin-update', 'same-plugin-update', 'same-plugin-update']);
    await applyInstall(plan, workspace, store);
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('REVIEW SKILL BODY v2\n');
    const settings = store.settings();
    expect(settings.hooks).toHaveLength(1);
    expect(settings.plugins?.toolkit?.version).toBe('1.3.0');
  });

  it('rolls back files written before a mid-apply failure (read-only target directory)', async () => {
    await writeFile(join(pkg, 'one.md'), 'FIRST COMMAND');
    await mkdir(join(pkg, 'skills', 'later'), { recursive: true });
    await writeFile(join(pkg, 'skills', 'later', 'SKILL.md'), 'LATER SKILL');
    await writeManifest({ name: 'partial', version: '1', skills: [{ id: 'later', path: 'skills/later/SKILL.md' }], commands: [{ name: 'one', path: 'one.md' }] });
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.actions.map(action => action.target)).toEqual(['.speedrail/skills/later/SKILL.md', '.speedrail/commands/one.md']);
    // Skill lands first; make the commands directory unwritable so the SECOND write fails.
    await mkdir(join(workspace, '.speedrail', 'commands'), { recursive: true });
    await chmod(join(workspace, '.speedrail', 'commands'), 0o500);
    try { await expect(applyInstall(plan, workspace, store)).rejects.toThrow(); }
    finally { await chmod(join(workspace, '.speedrail', 'commands'), 0o700); }
    // The already-written skill was rolled back and nothing was persisted.
    await expect(readFile(join(workspace, '.speedrail', 'skills', 'later', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.settings().plugins?.partial).toBeUndefined();
  });

  it('rollback restores the PRIOR content of an owned file, not deletion', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    await writeFile(join(pkg, 'skills', 'review.md'), 'REVIEW SKILL BODY v2\n');
    const plan = await planInstall(pkg, workspace, store);
    // A read-only owned command file makes the SECOND write fail after the
    // skill (first action) was already updated on disk.
    await chmod(join(workspace, '.speedrail', 'commands', 'deploy.md'), 0o400);
    try { await expect(applyInstall(plan, workspace, store)).rejects.toThrow(); }
    finally { await chmod(join(workspace, '.speedrail', 'commands', 'deploy.md'), 0o600); }
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('REVIEW SKILL BODY\n');
    expect(store.settings().plugins?.toolkit?.version).toBe('1.2.0');
  });

  it('uninstall removes exactly the owned items and the registry entry', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    const result = await uninstall('toolkit', workspace, store);
    expect(result.removed.map(item => item.kind).sort()).toEqual(['command', 'hook', 'mcp', 'skill']);
    expect(result.warnings).toEqual([]);
    await expect(readFile(join(workspace, '.speedrail', 'skills', 'review', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspace, '.speedrail', 'commands', 'deploy.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const settings = store.settings();
    expect(settings.mcpServers.docs).toBeUndefined();
    expect(settings.hooks).toEqual([]);
    expect(settings.plugins?.toolkit).toBeUndefined();
  });

  it('uninstall leaves a user-modified file with a warning, never deleting it', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    await writeFile(join(workspace, '.speedrail', 'commands', 'deploy.md'), 'USER EDITED THIS');
    const result = await uninstall('toolkit', workspace, store);
    expect(result.warnings.join(' ')).toContain('.speedrail/commands/deploy.md was modified after installation; it was left in place');
    expect(result.removed.map(item => item.target)).not.toContain('.speedrail/commands/deploy.md');
    expect(await readFile(join(workspace, '.speedrail', 'commands', 'deploy.md'), 'utf8')).toBe('USER EDITED THIS');
    expect(store.settings().plugins?.toolkit).toBeUndefined(); // Registry entry still removed.
  });

  it('uninstall leaves a user-modified MCP entry but removes a merely-connected one (enabled excluded from the hash)', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    // Connecting the server (enabled:true) must NOT strand the entry.
    const settings = store.settings();
    store.saveSettings({ mcpServers: { ...settings.mcpServers, docs: { ...settings.mcpServers.docs, enabled: true } } });
    const result = await uninstall('toolkit', workspace, store);
    expect(result.removed.some(item => item.kind === 'mcp')).toBe(true);
    expect(store.settings().mcpServers.docs).toBeUndefined();
  });

  it('uninstall skips an MCP entry the user rewrote', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    const settings = store.settings();
    store.saveSettings({ mcpServers: { ...settings.mcpServers, docs: { command: 'user-replacement' } } });
    const result = await uninstall('toolkit', workspace, store);
    expect(result.warnings.join(' ')).toContain('MCP server "docs" was modified after installation');
    expect(store.settings().mcpServers.docs).toEqual({ command: 'user-replacement' });
  });

  it('uninstall leaves foreign files sharing the skills directory intact', async () => {
    await fullPackage();
    await applyInstall(await planInstall(pkg, workspace, store), workspace, store);
    await writeFile(join(workspace, '.speedrail', 'skills', 'review', 'NOTES.md'), 'user notes');
    await uninstall('toolkit', workspace, store);
    // SKILL.md removed, but the user's extra file (and thus the directory) survives.
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'review', 'NOTES.md'), 'utf8')).toBe('user notes');
  });

  it('uninstall of an unknown plugin is a 404', async () => {
    await expect(uninstall('ghost', workspace, store)).rejects.toMatchObject({ status: 404 });
  });

  it('maps a compatible .claude-plugin/plugin.json and reports unmapped keys', async () => {
    await mkdir(join(pkg, '.claude-plugin'), { recursive: true });
    await mkdir(join(pkg, 'commands'), { recursive: true });
    await mkdir(join(pkg, 'skills', 'lint'), { recursive: true });
    await writeFile(join(pkg, 'commands', 'ship.md'), '# Ship it\n');
    await writeFile(join(pkg, 'skills', 'lint', 'SKILL.md'), 'LINT SKILL\n');
    await writeFile(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'compat-pack', version: '2.0.1', description: 'Ported package.',
      commands: ['./commands/ship.md'], skills: ['./skills/lint'],
      author: { name: 'Someone' }, homepage: 'https://example.com', mcpServers: {}, agents: ['./agents/x.md'],
    }));
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.plugin).toEqual({ name: 'compat-pack', version: '2.0.1', description: 'Ported package.' });
    expect(plan.unmapped).toEqual(['agents', 'author', 'homepage', 'mcpServers']);
    expect(plan.actions.map(action => [action.kind, action.name])).toEqual([['skill', 'lint'], ['command', 'ship']]);
    await applyInstall(plan, workspace, store);
    expect(await readFile(join(workspace, '.speedrail', 'commands', 'ship.md'), 'utf8')).toBe('# Ship it\n');
    expect(await readFile(join(workspace, '.speedrail', 'skills', 'lint', 'SKILL.md'), 'utf8')).toBe('LINT SKILL\n');
  });

  it('prefers speedrail-plugin.json when both manifests exist', async () => {
    await fullPackage();
    await mkdir(join(pkg, '.claude-plugin'), { recursive: true });
    await writeFile(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'other-name' }));
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.plugin.name).toBe('toolkit');
  });

  it('compat manifest entries that cannot map become warnings, not silent drops', async () => {
    await mkdir(join(pkg, '.claude-plugin'), { recursive: true });
    await mkdir(join(pkg, 'commands'), { recursive: true });
    await writeFile(join(pkg, 'commands', 'good.md'), 'GOOD\n');
    await writeFile(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'partial-compat', commands: ['./commands/good.md', './commands/Bad Name.md', 42],
    }));
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.plugin.version).toBe('0.0.0'); // Missing version defaults.
    expect(plan.actions.map(action => action.name)).toEqual(['good']);
    expect(plan.warnings.filter(warning => warning.includes('does not map'))).toHaveLength(2);
  });

  it('applyInstall refuses a plan computed for a different workspace', async () => {
    await fullPackage();
    const other = join(dir, 'other'); await mkdir(other);
    const plan = await planInstall(pkg, workspace, store);
    await expect(applyInstall(plan, other, store)).rejects.toMatchObject({ status: 409 });
  });

  it('hooks past the 20-hook settings limit are skipped with a warning instead of invalidating all hooks', async () => {
    const existing: HookConfig[] = Array.from({ length: 19 }, (_, index) => ({ event: 'Stop' as const, command: `echo ${index}` }));
    store.saveSettings({ hooks: existing });
    await writeManifest({ name: 'hooky', version: '1', hooks: [{ event: 'Stop', command: 'echo fits' }, { event: 'Stop', command: 'echo overflow' }] });
    const plan = await planInstall(pkg, workspace, store);
    expect(plan.actions.map(action => action.conflict)).toEqual([undefined, 'exists']);
    expect(plan.warnings.join(' ')).toContain('would exceed the 20-hook limit');
    await applyInstall(plan, workspace, store);
    expect(store.settings().hooks).toHaveLength(20);
  });
});
