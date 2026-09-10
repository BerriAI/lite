import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile as readNativeFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProfileCatalog, readEditableProfile, saveProjectProfile, resolveProfileChoice, profileSourceStatus, PROFILE_LIMITS } from '../server/profiles.js';
import { readFile, readProfileSource } from '../server/tools.js';

let directory: string;
const manifest = () => ({ version: 1, profiles: [{ id: 'review', name: 'Review', description: 'Read-only review', instructions: 'Follow the project review checklist.', tools: ['read_file', 'grep'], defaultModel: { providerId: 'test', model: 'review-model' }, defaultMode: 'plan', skills: ['testing'] }], skills: [{ id: 'testing', name: 'Testing', description: 'Useful tests' }] });
const save = async (value: unknown = manifest(), body: string | Buffer = 'Exact skill body\r\nno final newline') => { await mkdir(join(directory, '.lite/skills/testing'), { recursive: true }); await writeFile(join(directory, '.lite/profiles.json'), JSON.stringify(value)); await writeFile(join(directory, '.lite/skills/testing/SKILL.md'), body); };
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'lite-profiles-'))); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('explicit project profile catalog and safe sources', () => {
  it('creates and edits profiles without losing other profiles or skills, or changing pinned sessions', async () => {
    const initial = await readProfileCatalog(directory);
    const profile = { id: 'builder', name: 'Builder', instructions: 'Build carefully.', tools: ['read_file', 'write_file'] as const };
    await saveProjectProfile(directory, { create: true, catalogRevision: initial.revision, profile: { ...profile, tools: [...profile.tools] } });
    const saved = await readEditableProfile(directory, 'builder');
    expect(saved.profile.instructions).toBe('Build carefully.');
    await save();
    const catalog = await readProfileCatalog(directory), pinned = await resolveProfileChoice(directory, { profileId: 'review', skillIds: ['testing'] });
    await saveProjectProfile(directory, { create: true, catalogRevision: catalog.revision, profile: { ...profile, tools: [...profile.tools] } });
    const review = await readEditableProfile(directory, 'review');
    await saveProjectProfile(directory, { create: false, catalogRevision: review.catalogRevision, profile: { ...review.profile, instructions: 'New instructions.' } });
    const manifest = JSON.parse(await readNativeFile(join(directory, '.lite/profiles.json'), 'utf8'));
    expect(manifest.profiles).toHaveLength(2); expect(manifest.skills).toEqual([{ id: 'testing', name: 'Testing', description: 'Useful tests' }]);
    expect(pinned.snapshot?.instructions).toBe('Follow the project review checklist.');
    expect((await profileSourceStatus(directory, pinned.snapshot!)).status).toBe('changed');
    await expect(saveProjectProfile(directory, { create: false, catalogRevision: review.catalogRevision, profile: review.profile })).rejects.toThrow(/changed/);
  });

  it('profile editing refuses invalid manifests and redirected configuration directories', async () => {
    await save();
    const profile = (await readEditableProfile(directory, 'review')).profile;
    await writeFile(join(directory, '.lite/profiles.json'), '{ invalid');
    await expect(saveProjectProfile(directory, { create: true, catalogRevision: (await readProfileCatalog(directory)).revision, profile })).rejects.toThrow(/invalid/);
    await rm(join(directory, '.lite'), { recursive: true }); await mkdir(join(directory, 'elsewhere')); await symlink(join(directory, 'elsewhere'), join(directory, '.lite'));
    await expect(saveProjectProfile(directory, { create: true, catalogRevision: (await readProfileCatalog(directory)).revision, profile })).rejects.toThrow();
    await expect(readNativeFile(join(directory, 'elsewhere/profiles.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('exposes metadata without bodies, resolves explicit skills exactly, never activates recommendations', async () => {
    await save(); const catalog = await readProfileCatalog(directory);
    expect(catalog.diagnostics).toEqual([]); expect(catalog.profiles).toHaveLength(1); expect(catalog.skills).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain('Follow the project'); expect(JSON.stringify(catalog)).not.toContain('Exact skill');
    const profile = await resolveProfileChoice(directory, { profileId: 'review', skillIds: [], catalogRevision: catalog.revision });
    expect(profile.snapshot?.skills).toEqual([]); expect(profile.snapshot?.active).toMatchObject({ profileId: 'review', tools: ['read_file', 'grep'], skillIds: [] });
    expect(profile.defaults).toEqual({ model: { providerId: 'test', model: 'review-model' }, mode: 'plan' });
    const active = await resolveProfileChoice(directory, { profileId: 'review', skillIds: ['testing'] });
    expect(active.snapshot?.skills[0].body).toBe('Exact skill body\r\nno final newline'); expect(active.snapshot?.sources).toHaveLength(2);
    const skillsOnly = await resolveProfileChoice(directory, { profileId: null, skillIds: ['testing'] }); expect(skillsOnly.snapshot?.active.tools).toBeNull(); expect(skillsOnly.snapshot?.instructions).toBe('');
    expect((await resolveProfileChoice(directory, { profileId: null, skillIds: [] })).snapshot).toBeNull();
  });

  it('missing manifest is diagnostic only and explicit empty selection never needs a manifest', async () => {
    expect((await readProfileCatalog(directory)).diagnostics).toEqual([{ path: '.lite/profiles.json', code: 'missing', message: 'Profile source is missing.' }]);
    expect((await resolveProfileChoice(directory, { profileId: null, skillIds: [] })).snapshot).toBeNull();
    await expect(resolveProfileChoice(directory, { profileId: 'review', skillIds: [] })).rejects.toThrow(/missing or invalid/);
  });

  it.each(['version', 'unknown', 'tools-missing', 'mcp', 'ask-user', 'task', 'duplicates', 'uppercase', 'too-many', 'skill-reference', 'profile-size', 'injected-name'])('strict manifest rejects %s without exposing source excerpts', async kind => {
    const value: any = manifest();
    if (kind === 'version') value.version = 2;
    if (kind === 'unknown') value.include = '/forbidden-secret-file';
    if (kind === 'tools-missing') delete value.profiles[0].tools;
    if (['mcp', 'ask-user', 'task'].includes(kind)) value.profiles[0].tools = [kind === 'mcp' ? 'mcp_execute' : kind === 'ask-user' ? 'ask_user' : 'task'];
    if (kind === 'duplicates') value.profiles.push(value.profiles[0]);
    if (kind === 'uppercase') value.profiles[0].id = 'Review';
    if (kind === 'too-many') value.profiles = Array.from({ length: 33 }, (_, i) => ({ ...value.profiles[0], id: `profile-${i}` }));
    if (kind === 'skill-reference') value.profiles[0].skills = ['missing'];
    if (kind === 'profile-size') value.profiles[0].instructions = 'x'.repeat(PROFILE_LIMITS.profileBytes);
    if (kind === 'injected-name') value.profiles[0].name = '[31msecret';
    await save(value); const catalog = await readProfileCatalog(directory);
    expect(catalog.profiles).toEqual([]); expect(catalog.skills).toEqual([]); expect(catalog.diagnostics[0].code).toBe('schema');
    expect(JSON.stringify(catalog.diagnostics)).not.toContain('secret');
  });

  it('hash revision catches same-size skill and manifest edits, old snapshots stay pinned', async () => {
    await save(); const catalog = await readProfileCatalog(directory), resolved = await resolveProfileChoice(directory, { profileId: 'review', skillIds: ['testing'], catalogRevision: catalog.revision });
    await writeFile(join(directory, '.lite/skills/testing/SKILL.md'), 'Equal skill body\r\nno final newline');
    expect((await readProfileCatalog(directory)).revision).not.toBe(catalog.revision);
    await expect(resolveProfileChoice(directory, { profileId: 'review', skillIds: [], catalogRevision: catalog.revision })).rejects.toThrow(/changed/);
    expect((await profileSourceStatus(directory, resolved.snapshot!)).status).toBe('changed'); expect(resolved.snapshot?.skills[0].body).toContain('Exact');
    await rm(join(directory, '.lite/skills/testing/SKILL.md')); expect((await profileSourceStatus(directory, resolved.snapshot!)).status).toBe('missing');
    const value = manifest(); value.profiles[0].name = 'Rename'; await save(value); expect((await readProfileCatalog(directory)).revision).not.toBe(catalog.revision);
  });

  it('unavailable recommended skill does not disable the profile but explicit activation fails closed', async () => {
    await save(); await rm(join(directory, '.lite/skills/testing/SKILL.md'));
    const catalog = await readProfileCatalog(directory); expect(catalog.profiles).toHaveLength(1); expect(catalog.diagnostics[0].code).toBe('missing');
    expect((await resolveProfileChoice(directory, { profileId: 'review', skillIds: [] })).snapshot?.active.tools).toEqual(['read_file', 'grep']);
    await expect(resolveProfileChoice(directory, { profileId: 'review', skillIds: ['testing'] })).rejects.toThrow(/missing or invalid/);
  });

  it.each(['file-link', 'directory-link', 'hardlink', 'directory-file', 'escape', 'credential-alias'])('guarded config reader refuses %s without weakening regular tools', async kind => {
    await save(); const target = join(directory, '.lite/skills/testing/SKILL.md');
    if (kind === 'file-link') { await rm(target); await writeFile(join(directory, 'other.md'), 'Other'); await symlink(join(directory, 'other.md'), target); }
    if (kind === 'directory-link') { await rm(join(directory, '.lite/skills/testing'), { recursive: true }); await mkdir(join(directory, 'alias')); await writeFile(join(directory, 'alias/SKILL.md'), 'Other'); await symlink(join(directory, 'alias'), join(directory, '.lite/skills/testing')); }
    if (kind === 'hardlink') await link(target, join(directory, 'alias.md'));
    if (kind === 'directory-file') { await rm(target); await mkdir(target); }
    if (kind === 'credential-alias') { await rm(target); await writeFile(join(directory, '.env'), 'fixture-not-real-secret'); await symlink(join(directory, '.env'), target); }
    await expect(readProfileSource(directory, kind === 'escape' ? '../outside/SKILL.md' : '.lite/skills/testing/SKILL.md', 32768)).rejects.toThrow();
    await expect(readFile(directory, '.lite/profiles.json')).rejects.toThrow(/Protected/);
    await expect(readFile(directory, '.lite/skills/testing/SKILL.md')).rejects.toThrow();
  });

  it.each(['truncated-utf8', 'nul', 'oversized'])('rejects %s skill source, never silently truncates', async kind => {
    await save(manifest(), kind === 'truncated-utf8' ? Buffer.from([0x61, 0xf0, 0x9f]) : kind === 'nul' ? Buffer.from([0x61, 0]) : 'x'.repeat(32769));
    const catalog = await readProfileCatalog(directory); expect(catalog.skills).toEqual([]); expect(catalog.diagnostics[0].code).toBe(kind === 'oversized' ? 'size' : 'utf8');
    await expect(resolveProfileChoice(directory, { profileId: null, skillIds: ['testing'] })).rejects.toThrow();
  });

  it('preserves complete BOM and non-ASCII skill text at the exact byte boundary', async () => {
    const body = '﻿' + 'é'.repeat(16382) + 'x'; expect(Buffer.byteLength(body)).toBe(32768); await save(manifest(), body);
    expect((await resolveProfileChoice(directory, { profileId: null, skillIds: ['testing'] })).snapshot?.skills[0].body).toBe(body);
  });

  it('enforces explicit skill uniqueness, active count and aggregate instruction bounds', async () => {
    const value = manifest(); value.skills = Array.from({ length: 9 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}`, description: '' })); value.profiles[0].skills = [];
    await save(value); for (const skill of value.skills) { await mkdir(join(directory, `.lite/skills/${skill.id}`), { recursive: true }); await writeFile(join(directory, `.lite/skills/${skill.id}/SKILL.md`), 'x'.repeat(32768)); }
    await expect(resolveProfileChoice(directory, { profileId: null, skillIds: ['skill-0', 'skill-0'] })).rejects.toThrow(/Invalid/);
    await expect(resolveProfileChoice(directory, { profileId: null, skillIds: value.skills.map(skill => skill.id) })).rejects.toThrow(/Invalid/);
    await expect(resolveProfileChoice(directory, { profileId: null, skillIds: value.skills.slice(0, 4).map(skill => skill.id) })).rejects.toThrow(/96 KiB/);
    expect((await resolveProfileChoice(directory, { profileId: null, skillIds: value.skills.slice(0, 3).map(skill => skill.id) })).snapshot?.skills).toHaveLength(3);
  });

  it.each(['oversized', 'bad-json', 'manifest-link', 'state-directory-link'])('rejects %s manifest without expanding the config exception', async kind => {
    await save();
    if (kind === 'oversized') await writeFile(join(directory, '.lite/profiles.json'), ' '.repeat(128 * 1024 + 1));
    if (kind === 'bad-json') await writeFile(join(directory, '.lite/profiles.json'), '{invalid SECRET_EXCERPT');
    if (kind === 'manifest-link') { await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest())); await rm(join(directory, '.lite/profiles.json')); await symlink(join(directory, 'manifest.json'), join(directory, '.lite/profiles.json')); }
    if (kind === 'state-directory-link') { await rm(join(directory, '.lite'), { recursive: true }); await mkdir(join(directory, 'redirected')); await writeFile(join(directory, 'redirected/profiles.json'), JSON.stringify(manifest())); await symlink(join(directory, 'redirected'), join(directory, '.lite')); }
    const catalog = await readProfileCatalog(directory); expect(catalog.profiles).toEqual([]); expect(catalog.skills).toEqual([]); expect(catalog.diagnostics).toHaveLength(1); expect(JSON.stringify(catalog.diagnostics)).not.toContain('SECRET_EXCERPT');
    for (const path of ['.lite/lite.db', '.lite/other.json', '.lite/skills/testing/OTHER.md', '.lite/skills/../profiles.json', '.env']) await expect(readProfileSource(directory, path, 32768)).rejects.toThrow(/Invalid profile source path/);
  });

  it('propagates cancellation instead of converting it into catalog diagnostics', async () => {
    await save(); const signal = AbortSignal.abort();
    await expect(readProfileCatalog(directory, signal)).rejects.toThrow();
    await expect(resolveProfileChoice(directory, { profileId: null, skillIds: [] }, signal)).rejects.toThrow();
  });
});
