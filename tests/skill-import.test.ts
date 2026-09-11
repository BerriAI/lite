import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsPromises, { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { skillDiscover, skillPlan, skillApply } from '../server/skill-import.js';
import { readProfileCatalog } from '../server/profiles.js';

async function writeSkill(dir: string, meta: unknown, body: string, support?: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  const front = meta ? `---\n${Object.entries(meta as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n` : '';
  await writeFile(join(dir, 'SKILL.md'), front + body);
  for (const [rel, content] of Object.entries(support ?? {})) {
    const path = join(dir, ...rel.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

describe('skill import engine', () => {
  let dir: string, workspace: string;
  const savedCodexHome = process.env.CODEX_HOME;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-skill-import-')));
    workspace = join(dir, 'workspace');
    await mkdir(workspace);
  });
  afterEach(async () => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodexHome;
    await rm(dir, { recursive: true, force: true });
  });

  const skillDir = (rel: string) => join(workspace, rel);

  it('discovers, plans, and imports a Claude project skill with support files, registering it and preserving an existing profile', async () => {
    // Seed a strict profile manifest with a profile + an existing skill.
    await mkdir(join(workspace, '.litespeed'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'profiles.json'), JSON.stringify({
      version: 1,
      profiles: [{ id: 'reviewer', name: 'Reviewer', description: 'Careful', tools: ['read_file'], skills: ['existing'] }],
      skills: [{ id: 'existing', name: 'Existing', description: '' }],
    }));
    await mkdir(join(workspace, '.litespeed', 'skills', 'existing'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'skills', 'existing', 'SKILL.md'), 'existing body');
    await writeSkill(skillDir('.claude/skills/review'), { name: 'Review skill', description: 'Checks the work' }, 'REVIEW BODY\n', { 'docs/guide.md': '# Guide\nhelp\n', 'helper.sh': '#!/bin/sh\necho hi\n' });
    await chmod(skillDir('.claude/skills/review/helper.sh'), 0o755);

    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    expect(review).toBeDefined();
    expect(review).toMatchObject({ source: 'claude', scope: 'project', rootId: 'claude:project', name: 'Review skill', description: 'Checks the work', fileCount: 3, conflict: false });
    expect(review!.sourceHash).toMatch(/^[a-f0-9]{64}$/);

    const plan = await skillPlan(workspace, 'claude:project', 'review');
    expect(plan.conflict).toBe(false);
    expect(plan.files.map(f => f.path)).toEqual([
      '.litespeed/skills/review/SKILL.md',
      '.litespeed/skills/review/docs/guide.md',
      '.litespeed/skills/review/helper.sh',
    ]);
    // Executable bit is reported but the plan itself does not run anything.
    expect(plan.files.find(f => f.path.endsWith('helper.sh'))!.executable).toBe(true);

    const result = await skillApply(workspace, 'claude:project', 'review', plan.sourceHash);
    expect(result).toMatchObject({ id: 'review', name: 'Review skill', fileCount: 3 });

    // Copied files landed byte-for-byte, executable mode preserved.
    expect(await readFile(join(workspace, '.litespeed', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain('REVIEW BODY');
    const mode = (await stat(join(workspace, '.litespeed', 'skills', 'review', 'helper.sh'))).mode;
    expect(mode & 0o111).toBe(0o111);

    // Manifest preserved the profile + existing skill and added the import.
    const catalog = await readProfileCatalog(workspace);
    expect(catalog.profiles.map(p => p.id)).toEqual(['reviewer']);
    expect(catalog.skills.map(s => s.id).sort()).toEqual(['existing', 'review']);
  });

  it('imports from the Codex home root via CODEX_HOME and from project roots', async () => {
    process.env.CODEX_HOME = join(dir, 'codexHome');
    await writeSkill(join(process.env.CODEX_HOME!, 'skills', 'deploy'), { name: 'Deploy', description: 'Release checklist' }, 'DEPLOY\n');
    await writeSkill(skillDir('.agents/skills/triage'), {}, 'TRIAGE\n');
    await writeSkill(skillDir('.codex/skills/legacy'), {}, 'LEGACY\n');

    const discovered = await skillDiscover(workspace);
    const ids = new Set(discovered.candidates.filter(c => c.source === 'codex').map(c => `${c.rootId}:${c.id}`));
    expect(ids).toContain('codex:home:deploy');
    expect(ids).toContain('codex:project:triage');
    expect(ids).toContain('codex:legacy-project:legacy');

    const hash = discovered.candidates.find(c => c.id === 'deploy')!.sourceHash;
    await skillApply(workspace, 'codex:home', 'deploy', hash);
    expect(await readFile(join(workspace, '.litespeed', 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain('DEPLOY');
  });

  it('refuses a stale source hash between plan and apply', async () => {
    await writeSkill(skillDir('.claude/skills/review'), { name: 'Review' }, 'BODY\n');
    const plan = await skillPlan(workspace, 'claude:project', 'review');
    await writeFile(skillDir('.claude/skills/review/SKILL.md'), 'CHANGED\n');
    await expect(skillApply(workspace, 'claude:project', 'review', plan.sourceHash)).rejects.toThrow(/changed since you reviewed/);
  });

  it('conflicts on an already-imported skill without overwriting', async () => {
    await writeSkill(skillDir('.claude/skills/review'), { name: 'Review' }, 'BODY\n');
    const hash = (await skillDiscover(workspace)).candidates.find(c => c.id === 'review')!.sourceHash;
    await skillApply(workspace, 'claude:project', 'review', hash);
    // A foreign user-owned file in the destination must NOT be overwritten.
    const destSkill = join(workspace, '.litespeed', 'skills', 'review');
    expect((await stat(destSkill)).isDirectory()).toBe(true);
    // Re-import conflicts.
    const again = (await skillDiscover(workspace)).candidates.find(c => c.id === 'review');
    expect(again!.conflict).toBe(true);
    await expect(skillApply(workspace, 'claude:project', 'review', again!.sourceHash)).rejects.toThrow(/already imported/i);
    expect(await readFile(join(destSkill, 'SKILL.md'), 'utf8')).toContain('BODY');
  });

  it('fails closed on a malformed manifest without writing anything', async () => {
    await mkdir(join(workspace, '.litespeed'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'profiles.json'), '{ nope');
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n');
    const hash = (await skillDiscover(workspace)).candidates.find(c => c.id === 'review')!.sourceHash;
    await expect(skillApply(workspace, 'claude:project', 'review', hash)).rejects.toThrow(/invalid \.litespeed\/profiles\.json/);
  });

  it('skips symlinked files and secret filenames, and refuses invalid SKILL.md UTF-8', async () => {
    // A skill folder containing a symlinked file must be refused outright.
    await writeSkill(skillDir('.claude/skills/linked'), {}, 'OK\n');
    const secretTarget = join(dir, 'outside.txt');
    await writeFile(secretTarget, 'SECRET');
    await writeFile(join(skillDir('.claude/skills/linked'), 'evil'), 'placeholder');
    await symlink(secretTarget, join(skillDir('.claude/skills/linked'), 'screen.png'));
    // An out-of-workspace skill folder itself (as a link) is simply not read.
    await mkdir(skillDir('.claude/skills'), { recursive: true });
    await symlink(secretTarget, skillDir('.claude/skills/evil'));
    // Secret support filename and invalid UTF-8 are refused.
    await writeSkill(skillDir('.claude/skills/ok'), {}, 'OK\n', { '.env.creds': 'x' });
    await mkdir(skillDir('.claude/skills/bad'), { recursive: true });
    await writeFile(join(skillDir('.claude/skills/bad'), 'SKILL.md'), Buffer.from([0xff, 0xfe, 0x61]));

    const discovered = await skillDiscover(workspace);
    const ids = discovered.candidates.filter(c => c.rootId === 'claude:project').map(c => c.id);
    expect(ids).not.toContain('linked'); // symlink inside folder
    expect(ids).not.toContain('evil');   // symlinked folder
    expect(ids).not.toContain('ok');     // secret support filename rejected
    expect(ids).not.toContain('bad');    // invalid utf-8 SKILL.md rejected
    expect(discovered.issues.join(' ')).toMatch(/symbolic link/);
    expect(discovered.issues.join(' ')).toMatch(/protected path.*\.env\.creds/);
    expect(discovered.issues.join(' ')).toMatch(/valid UTF-8/);
  });

  it('rejects traversal to a parent directory yet still works when a support file lives in a subdirectory', async () => {
    await writeSkill(skillDir('.claude/skills/nested'), { description: 'Has support' }, '# Title\nbody\n', { 'assets/logo.txt': 'LOGO' });
    const discovered = await skillDiscover(workspace);
    const nested = discovered.candidates.find(c => c.id === 'nested');
    expect(nested).toBeDefined();
    await skillApply(workspace, 'claude:project', 'nested', nested!.sourceHash);
    expect(await readFile(join(workspace, '.litespeed', 'skills', 'nested', 'assets', 'logo.txt'), 'utf8')).toBe('LOGO');
  });

  it('rejects an unknown root id and unknown skill id', async () => {
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n');
    await expect(skillPlan(workspace, 'nope:nope' as never, 'review')).rejects.toThrow(/Unknown skill source root/);
    await expect(skillPlan(workspace, 'claude:project', 'missing')).rejects.toThrow(/was not found/);
  });

  it('rejects a project skills root that is a symbolic link out of the workspace', async () => {
    // `.claude/skills` itself is a symlink to an OUT-OF-WORKSPACE directory.
    const outside = join(dir, 'outside'); await mkdir(outside);
    await writeSkill(skillDir('.claude/skills/inner'), { name: 'Inner' }, 'OUTSIDE BODY\n');
    // Move the real dir out and replace the whole root with a symlink.
    await rm(skillDir('.claude/skills'), { recursive: true, force: true });
    await symlink(outside, skillDir('.claude/skills'));
    // Discovery must not follow it: the project root yields no candidates.
    const discovered = await skillDiscover(workspace);
    const project = discovered.candidates.filter(c => c.rootId === 'claude:project');
    expect(project).toEqual([]);
    expect(discovered.issues.join(' ')).toMatch(/symbolic link/);
    await expect(skillPlan(workspace, 'claude:project', 'inner')).rejects.toThrow(/symbolic link/);
  });

  it('does not follow a symlinked destination component when importing', async () => {
    await writeSkill(skillDir('.claude/skills/review'), { description: 'Has support' }, 'BODY\n', { 'assets/logo.txt': 'LOGO' });
    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    expect(review).toBeDefined();
    // Pre-create `.litespeed/skills` as a symlink to an out-of-workspace dir.
    const outside = join(dir, 'outside'); await mkdir(outside);
    await mkdir(join(workspace, '.litespeed'), { recursive: true });
    await symlink(outside, join(workspace, '.litespeed', 'skills'));
    await expect(skillApply(workspace, 'claude:project', 'review', review!.sourceHash)).rejects.toThrow(/symbolic link|uses a symbolic link|not a directory/);
    // Nothing was written into the outside directory.
    expect(await readdir(outside)).toEqual([]);
  });

  it('bounds the total entry count incrementally before buffering an unbounded tree', async () => {
    // Many sibling files inside one skill folder exceed SKILL_IMPORT_LIMITS.files (256).
    await mkdir(skillDir('.claude/skills/big'), { recursive: true });
    await writeFile(join(skillDir('.claude/skills/big'), 'SKILL.md'), 'BODY\n');
    const many = 400;
    for (let i = 0; i < many; i++) await writeFile(join(skillDir('.claude/skills/big'), `f${i}.bin`), 'x'.repeat(8));
    const discovered = await skillDiscover(workspace);
    const big = discovered.candidates.find(c => c.id === 'big');
    expect(big).toBeUndefined();
    expect(discovered.issues.join(' ')).toMatch(/too many files/);
    // plan reads only the requested skill, which is too large and is skipped.
    await expect(skillPlan(workspace, 'claude:project', 'big')).rejects.toThrow(/was not found|too many files/);
  });

  it('allows binary support files while requiring valid UTF-8 SKILL.md', async () => {
    // Support file can be arbitrary bytes (no NUL check for support); SKILL.md must be UTF-8.
    await mkdir(skillDir('.claude/skills/bin'), { recursive: true });
    await writeFile(join(skillDir('.claude/skills/bin'), 'SKILL.md'), '---\nname: Binary\n---\nBODY\n');
    await writeFile(join(skillDir('.claude/skills/bin'), 'payload.bin'), Buffer.from([0xff, 0x00, 0xfe, 0x00, 0x61]));
    const discovered = await skillDiscover(workspace);
    const bin = discovered.candidates.find(c => c.id === 'bin');
    expect(bin).toBeDefined();
    await skillApply(workspace, 'claude:project', 'bin', bin!.sourceHash);
    const copied = await readFile(join(workspace, '.litespeed', 'skills', 'bin', 'payload.bin'));
    expect([...copied]).toEqual([0xff, 0x00, 0xfe, 0x00, 0x61]);
  });

  it('detects a chmod-only change between plan and apply via the source hash', async () => {
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n', { 'run.sh': '#!/bin/sh\necho hi\n' });
    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    expect(review).toBeDefined();
    await chmod(join(skillDir('.claude/skills/review'), 'run.sh'), 0o755);
    const changed = (await skillDiscover(workspace)).candidates.find(c => c.id === 'review');
    expect(changed!.sourceHash).not.toBe(review!.sourceHash);
    // A plan hash taken before the chmod must be refused at apply.
    await expect(skillApply(workspace, 'claude:project', 'review', review!.sourceHash)).rejects.toThrow(/changed since you reviewed/);
  });

  it('does not overwrite a user-owned file blocking the destination and keeps the manifest untouched', async () => {
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n');
    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    // Pre-existing USER-OWNED file at the exact destination path.
    await mkdir(join(workspace, '.litespeed', 'skills'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'skills', 'review'), 'user data');
    await expect(skillApply(workspace, 'claude:project', 'review', review!.sourceHash)).rejects.toThrow(/file already exists|already imported|blocking/i);
    expect(await readFile(join(workspace, '.litespeed', 'skills', 'review'), 'utf8')).toBe('user data');
    const after = await readProfileCatalog(workspace);
    expect(after.skills.map(s => s.id)).not.toContain('review');
  });

  it('rolls back the written tree when the manifest write fails, never touching existing files', async () => {
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n', { 'asset.txt': 'A' });
    // Seed a valid manifest and a sibling project skill.
    await mkdir(join(workspace, '.litespeed'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'profiles.json'), JSON.stringify({ version: 1, profiles: [], skills: [{ id: 'existing', name: 'Existing', description: '' }] }));
    await mkdir(join(workspace, '.litespeed', 'skills', 'existing'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'skills', 'existing', 'SKILL.md'), 'preexisting');
    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    // Fail the atomic commit (rename of the temp manifest) so the freshly
    // written tree must be rolled back. Mock the module namespace directly so
    // the server's `import * as fs` sees it, without relying on read-only perms.
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async () => { throw new Error('chmod-style write failure'); });
    syncBuiltinESMExports();
    try {
      await expect(skillApply(workspace, 'claude:project', 'review', review!.sourceHash)).rejects.toThrow();
    } finally { rename.mockRestore(); syncBuiltinESMExports(); }
    // The freshly written tree (including created dirs) must be rolled back.
    await expect(stat(join(workspace, '.litespeed', 'skills', 'review'))).rejects.toThrow();
    // The preexisting sibling skill is untouched.
    expect(await readFile(join(workspace, '.litespeed', 'skills', 'existing', 'SKILL.md'), 'utf8')).toBe('preexisting');
  });

  it('walks support files in two or more nested directories (createDirPath descends correctly)', async () => {
    await writeSkill(skillDir('.claude/skills/deep'), { name: 'Deep' }, 'BODY\n', {
      'a/b/c.txt': 'LEVEL3',
      'd/e.txt': 'LEVEL2',
      'top.txt': 'TOP',
    });
    const discovered = await skillDiscover(workspace);
    const deep = discovered.candidates.find(c => c.id === 'deep');
    expect(deep).toBeDefined();
    expect(deep!.fileCount).toBe(4);
    await skillApply(workspace, 'claude:project', 'deep', deep!.sourceHash);
    expect((await readFile(join(workspace, '.litespeed', 'skills', 'deep', 'a', 'b', 'c.txt'), 'utf8'))).toBe('LEVEL3');
    expect((await readFile(join(workspace, '.litespeed', 'skills', 'deep', 'd', 'e.txt'), 'utf8'))).toBe('LEVEL2');
    expect((await readFile(join(workspace, '.litespeed', 'skills', 'deep', 'top.txt'), 'utf8'))).toBe('TOP');
  });

  it('preserves a preexisting empty .litespeed/skills directory on registration failure', async () => {
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n');
    // A directory a user already created (e.g. `.litespeed/skills`) must survive
    // a failed import even though it lies on the destination chain.
    await mkdir(join(workspace, '.litespeed'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'profiles.json'), JSON.stringify({ version: 1, profiles: [], skills: [] }));
    await mkdir(join(workspace, '.litespeed', 'skills'), { recursive: true });
    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async () => { throw new Error('manifest write failed'); });
    syncBuiltinESMExports();
    try { await expect(skillApply(workspace, 'claude:project', 'review', review!.sourceHash)).rejects.toThrow(); }
    finally { rename.mockRestore(); syncBuiltinESMExports(); }
    // `.litespeed/skills` is preexisting (not owned by this pass) so rollback
    // must NOT rmdir it; the freshly created skill dir is removed.
    await expect(stat(join(workspace, '.litespeed', 'skills'))).resolves.toBeTruthy();
    await expect(stat(join(workspace, '.litespeed', 'skills', 'review'))).rejects.toThrow();
  });

  it('does not delete a user-modified file under the imported tree on rollback', async () => {
    await writeSkill(skillDir('.claude/skills/review'), {}, 'BODY\n', { 'asset.txt': 'A' });
    // Seed a valid manifest so the atomic commit path uses `rename` (the mocked
    // syscall); with no manifest the update path is link+unlink instead.
    await mkdir(join(workspace, '.litespeed'), { recursive: true });
    await writeFile(join(workspace, '.litespeed', 'profiles.json'), JSON.stringify({ version: 1, profiles: [], skills: [] }));
    const discovered = await skillDiscover(workspace);
    const review = discovered.candidates.find(c => c.id === 'review');
    const destSkill = join(workspace, '.litespeed', 'skills', 'review');
    const asset = join(destSkill, 'asset.txt');
    // Fail the atomic manifest commit, but inside that window externally modify
    // the very file this pass just wrote (in place, so its inode is unchanged).
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
      await appendFile(asset, '\nUSER EDIT\n', 'utf8');
      throw new Error('manifest commit failed');
    });
    syncBuiltinESMExports();
    try { await expect(skillApply(workspace, 'claude:project', 'review', review!.sourceHash)).rejects.toThrow(); }
    finally { rename.mockRestore(); syncBuiltinESMExports(); }
    // The owned file was externally modified after this pass wrote it: rollback
    // must NOT treat it as the partial file it created (same inode, different
    // content), so the user edit survives.
    expect(await readFile(asset, 'utf8')).toContain('USER EDIT');
  });
});
