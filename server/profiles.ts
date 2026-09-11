import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readProfileSource } from './tools.js';
import type { ActiveProfile, PinnedSkill, ProfileCatalog, ProfileChoice, ProfileDiagnostic, ProfileSource } from '../shared/profiles.js';

export const PROFILE_LIMITS = { slug: 64, profiles: 32, skills: 64, activeSkills: 8, manifestBytes: 128 * 1024, profileBytes: 16 * 1024, skillBytes: 32 * 1024, activeBytes: 96 * 1024 } as const;
export const PROFILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'web_fetch', 'todo_read', 'todo_write'] as const;
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).refine(value => !/(?:^|[._-])private[._-]?key$/.test(value), 'Credential names are not profile identifiers.');
const label = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value));
const description = z.string().max(2000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const profileSchema = z.object({ id: slug, name: label, description: description.optional(), instructions: z.string().optional(), tools: z.array(z.enum(PROFILE_TOOLS)).max(PROFILE_TOOLS.length).refine(unique), defaultModel: z.object({ providerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), model: z.string().min(1).max(250).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)) }).strict().optional(), defaultMode: z.enum(['plan', 'build']).optional(), skills: z.array(slug).max(PROFILE_LIMITS.skills).refine(unique).optional() }).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= PROFILE_LIMITS.profileBytes);
const skillSchema = z.object({ id: slug, name: label, description: description.optional().default('') }).strict();
const manifestSchema = z.object({ version: z.literal(1), profiles: z.array(profileSchema).max(PROFILE_LIMITS.profiles), skills: z.array(skillSchema).max(PROFILE_LIMITS.skills) }).strict().refine(value => unique(value.profiles.map(profile => profile.id)) && unique(value.skills.map(skill => skill.id))).refine(value => value.profiles.every(profile => profile.skills?.every(id => value.skills.some(skill => skill.id === id)) ?? true));
export const profileChoiceSchema = z.object({ profileId: slug.nullable(), skillIds: z.array(slug).max(PROFILE_LIMITS.activeSkills).refine(unique), catalogRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const manifestPath = '.litespeed/profiles.json';
export const saveProjectProfileSchema = z.object({ workspace: z.string().max(4096).optional(), catalogRevision: z.string().regex(/^[a-f0-9]{64}$/), create: z.boolean(), profile: profileSchema }).strict();
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
const errorCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PROFILE_INVALID';
const diagnostic = (path: string, error: unknown): ProfileDiagnostic => {
  const code = errorCode(error);
  if (code === 'ENOENT') return { path, code: 'missing', message: 'Profile source is missing.' };
  if (code === 'PROFILE_SIZE') return { path, code: 'size', message: 'Profile source exceeds its byte limit.' };
  if (code === 'PROFILE_UTF8') return { path, code: 'utf8', message: 'Profile source must be complete UTF-8 text.' };
  if (['PROFILE_ALIAS', 'PROFILE_TYPE', 'PROFILE_PATH', 'ELOOP', 'ENOTDIR'].includes(code)) return { path, code: 'unsafe', message: 'Profile source is not a safe regular workspace file.' };
  if (code === 'PROFILE_CHANGED') return { path, code: 'changed', message: 'Profile source changed while being read. Try again.' };
  return { path, code: 'invalid', message: 'Profile source cannot be loaded safely.' };
};

/** Private durable data, never part of ordinary Session or message responses. */
export interface ProfileSnapshot { choice: ProfileChoice; active: ActiveProfile; instructions: string; skills: PinnedSkill[]; sources: ProfileSource[] }
export interface ResolvedProfile { workspace: string; catalogRevision: string; snapshot: ProfileSnapshot | null; defaults?: { model?: { providerId: string; model: string }; mode?: 'plan' | 'build' } }
const sourceSchema = z.object({ path: z.string().refine(value => value === manifestPath || /^\.litespeed\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/.test(value)), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const snapshotSchema = z.object({ choice: profileChoiceSchema, active: z.object({ profileId: slug.nullable(), name: label.optional(), skillIds: z.array(slug).max(PROFILE_LIMITS.activeSkills).refine(unique), revision: z.string().regex(/^[a-f0-9]{64}$/), tools: z.array(z.enum(PROFILE_TOOLS)).max(PROFILE_TOOLS.length).refine(unique).nullable() }).strict(), instructions: z.string().refine(value => Buffer.byteLength(value) <= PROFILE_LIMITS.profileBytes), skills: z.array(skillSchema.extend({ body: z.string().refine(value => Buffer.byteLength(value) <= PROFILE_LIMITS.skillBytes), path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(PROFILE_LIMITS.activeSkills), sources: z.array(sourceSchema).min(1).max(PROFILE_LIMITS.activeSkills + 1) }).strict();
export function validateProfileSnapshot(value: unknown): ProfileSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw conflict('The pinned profile snapshot is invalid. Review and explicitly replace or clear the profile.');
  const snapshot = parsed.data;
  if (snapshot.choice.profileId !== snapshot.active.profileId || snapshot.choice.catalogRevision !== snapshot.active.revision || JSON.stringify(snapshot.choice.skillIds) !== JSON.stringify(snapshot.active.skillIds) || JSON.stringify(snapshot.active.skillIds) !== JSON.stringify(snapshot.skills.map(skill => skill.id)) || snapshot.active.profileId === null && (snapshot.active.tools !== null || snapshot.instructions !== '') || snapshot.active.profileId !== null && snapshot.active.tools === null || snapshot.sources[0]?.path !== manifestPath || !unique(snapshot.sources.map(source => source.path)) || snapshot.sources.length !== snapshot.skills.length + 1 || snapshot.skills.some(skill => skill.path !== `.litespeed/skills/${skill.id}/SKILL.md` || hash(skill.body) !== skill.hash || !snapshot.sources.some(source => source.path === skill.path && source.hash === skill.hash)) || Buffer.byteLength(snapshot.instructions) + snapshot.skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.body), 0) > PROFILE_LIMITS.activeBytes) throw conflict('The pinned profile snapshot is inconsistent. Review and explicitly replace or clear the profile.');
  return snapshot;
}
type Loaded = { catalog: ProfileCatalog; profiles: Map<string, z.infer<typeof profileSchema>>; skills: Map<string, PinnedSkill>; sources: ProfileSource[] };

async function load(workspace: string, signal?: AbortSignal): Promise<Loaded> {
  signal?.throwIfAborted();
  const diagnostics: ProfileDiagnostic[] = [], observations: unknown[] = [], profiles: Loaded['profiles'] = new Map(), skills: Loaded['skills'] = new Map(), sources: ProfileSource[] = [];
  const finish = (): Loaded => ({ catalog: { revision: hash(JSON.stringify(observations)), profiles: [...profiles.values()].map(({ instructions: _instructions, ...profile }) => profile), skills: [...skills.values()].map(({ body: _body, path: _path, hash: _hash, ...skill }) => skill), diagnostics }, profiles, skills, sources });
  let text: string;
  try { text = await readProfileSource(workspace, manifestPath, PROFILE_LIMITS.manifestBytes, signal); }
  catch (error) { signal?.throwIfAborted(); const item = diagnostic(manifestPath, error); diagnostics.push(item); observations.push(item); return finish(); }
  const manifestHash = hash(text); sources.push({ path: manifestPath, hash: manifestHash }); observations.push({ path: manifestPath, hash: manifestHash });
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); }
  catch { diagnostics.push({ path: manifestPath, code: 'json', message: 'Profile manifest is not valid JSON.' }); return finish(); }
  const result = manifestSchema.safeParse(value);
  if (!result.success) { diagnostics.push({ path: manifestPath, code: 'schema', message: 'Profile manifest must match the strict version 1 schema and configured bounds.' }); return finish(); }
  for (const profile of result.data.profiles) profiles.set(profile.id, profile);
  for (const skill of result.data.skills) {
    signal?.throwIfAborted();
    const path = `.litespeed/skills/${skill.id}/SKILL.md`;
    try {
      const body = await readProfileSource(workspace, path, PROFILE_LIMITS.skillBytes, signal), source = { path, hash: hash(body) };
      skills.set(skill.id, { ...skill, body, ...source }); sources.push(source); observations.push(source);
    } catch (error) { signal?.throwIfAborted(); const item = diagnostic(path, error); diagnostics.push(item); observations.push(item); }
  }
  signal?.throwIfAborted(); return finish();
}

export async function readProfileCatalog(workspace: string, signal?: AbortSignal): Promise<ProfileCatalog> { return (await load(workspace, signal)).catalog; }

export async function readEditableProfile(workspace: string, id: string) {
  const loaded = await load(workspace), profile = loaded.profiles.get(id);
  if (!profile) throw invalid('This project profile is missing or invalid. Refresh the catalog.');
  return { profile, catalogRevision: loaded.catalog.revision };
}

const profileWrites = new Set<string>();
/** Shared lock over the project profile manifest. Both the profile editor and
 * the skill importer write through this lock so concurrent edits cannot lose
 * updates. `root` must already be a canonical (realpath) workspace. */
export async function withProfileWriteLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  if (profileWrites.has(root)) throw conflict('Another profile or skill write is in progress. Try again.');
  profileWrites.add(root);
  try { return await operation(); } finally { profileWrites.delete(root); }
}

/** Validated strict manifest shape; shared with the skill importer. */
export type StrictManifest = z.infer<typeof manifestSchema>;

/** Runtime schema validation (a `satisfies` is only a compile-time assertion).
 * Fails closed with the human-facing 400 used by both the editor and importer. */
export function validateStrictManifest(value: unknown): StrictManifest {
  try { return manifestSchema.parse(value); }
  catch { throw invalid('The project profiles are invalid. Fix .litespeed/profiles.json before saving here.'); }
}

/** Read the existing strict manifest verbatim (or an empty one when absent).
 * Never follows aliases. A malformed manifest fails closed with a 400. Exported
 * for the skill importer so both consumers read the same strict shape. */
export async function readStrictManifest(root: string): Promise<{ before: string | null; manifest: StrictManifest }> {
  let before: string | null = null;
  try { before = await readProfileSource(root, manifestPath, PROFILE_LIMITS.manifestBytes); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  let manifest: z.infer<typeof manifestSchema>;
  try { manifest = before === null ? { version: 1, profiles: [], skills: [] } : manifestSchema.parse(JSON.parse(before.replace(/^﻿/, ''))); }
  catch { throw invalid('Fix the invalid .litespeed/profiles.json file before editing profiles here.'); }
  return { before, manifest };
}

/** Atomically write `manifest` after verifying the on-disk file still equals
 * `before`. Exported for the skill importer so both consumers share the same
 * rollback-safe write path. `root` must already be canonical. The temporary
 * file is cleaned up on ANY error, and (when the profile editor supplies its
 * expected revision) the full catalog is re-verified right before commit so a
 * concurrent skill/manifest change cannot slide under an accepted save. */
export async function writeStrictManifest(root: string, manifest: z.infer<typeof manifestSchema>, before: string | null, expectedRevision?: string): Promise<string> {
  const valid = validateStrictManifest(manifest);
  const content = JSON.stringify(valid, null, 2) + '\n';
  if (Buffer.byteLength(content) > PROFILE_LIMITS.manifestBytes) throw invalid('The project profile catalog exceeds its size limit.');
  const directory = join(root, '.litespeed');
  await mkdir(directory, { recursive: true });
  const identity = await lstat(directory);
  const verifyDirectory = async () => {
    const now = await lstat(directory);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino || await realpath(directory) !== directory) throw conflict('The project configuration directory changed or uses an alias.');
  };
  await verifyDirectory();
  const temporary = join(directory, `.profiles-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await verifyDirectory();
    const target = join(root, manifestPath);
    if (before === null) {
      if (expectedRevision !== undefined && (await readProfileCatalog(root)).revision !== expectedRevision) throw conflict('Project profiles changed during the save. Refresh and try again.');
      await link(temporary, target);
      await unlink(temporary);
    } else {
      if (await readProfileSource(root, manifestPath, PROFILE_LIMITS.manifestBytes) !== before) throw conflict('The profile manifest changed during the save.');
      if (expectedRevision !== undefined && (await readProfileCatalog(root)).revision !== expectedRevision) throw conflict('Project profiles changed during the save. Refresh and try again.');
      await rename(temporary, target);
    }
    await verifyDirectory();
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => {});
  }
  return (await readProfileCatalog(root)).revision;
}

/** Settings-only editor. Preserve other profiles and all skill declarations;
 * never follow aliases or silently replace an invalid/newer manifest. */
export async function saveProjectProfile(workspace: string, input: z.infer<typeof saveProjectProfileSchema>) {
  const root = await realpath(workspace);
  return withProfileWriteLock(root, async () => {
    const loaded = await load(root);
    if (loaded.catalog.revision !== input.catalogRevision) throw conflict('Project profiles changed. Refresh the catalog before saving. Your draft has not been saved.');
    const { before, manifest } = await readStrictManifest(root);
    const index = manifest.profiles.findIndex(profile => profile.id === input.profile.id);
    if (input.create ? index !== -1 : index === -1) throw conflict(input.create ? 'That profile ID already exists. Choose another ID.' : 'This profile no longer exists. Refresh the catalog.');
    if (input.create) manifest.profiles.push(input.profile); else manifest.profiles[index] = input.profile;
    const next = validateStrictManifest(manifest);
    return { profile: input.profile, catalogRevision: await writeStrictManifest(root, next, before, input.catalogRevision) };
  });
}
export async function resolveProfileChoice(workspace: string, choice: ProfileChoice, signal?: AbortSignal): Promise<ResolvedProfile> {
  signal?.throwIfAborted();
  const parsed = profileChoiceSchema.safeParse(choice);
  if (!parsed.success) throw invalid('Invalid explicit profile or skill selection.');
  const selected = parsed.data, root = await realpath(workspace);
  signal?.throwIfAborted();
  if (selected.profileId === null && selected.skillIds.length === 0) return { workspace: root, catalogRevision: hash('inactive'), snapshot: null };
  const loaded = await load(root, signal), { catalog } = loaded;
  if (selected.catalogRevision !== undefined && selected.catalogRevision !== catalog.revision) throw conflict('Project profiles changed. Reload the catalog and review the selection.');
  const profile = selected.profileId === null ? undefined : loaded.profiles.get(selected.profileId);
  if (selected.profileId !== null && !profile) throw invalid('The selected profile is missing or invalid. No configuration was changed.');
  const skills = selected.skillIds.map(id => { const skill = loaded.skills.get(id); if (!skill) throw invalid('A selected skill is missing or invalid. No configuration was changed.'); return skill; });
  const instructions = profile?.instructions ?? '';
  if (Buffer.byteLength(instructions) + skills.reduce((total, skill) => total + Buffer.byteLength(skill.body), 0) > PROFILE_LIMITS.activeBytes) throw invalid('The selected profile and skills exceed the 96 KiB active instruction limit.');
  // Re-read the manifest and every selected source before returning a resolved
  // selection: never mix generations if files changed across asynchronous reads.
  const sources = loaded.sources.filter(source => source.path === manifestPath || skills.some(skill => skill.path === source.path));
  for (const source of sources) {
    let text: string;
    try { text = await readProfileSource(root, source.path, source.path === manifestPath ? PROFILE_LIMITS.manifestBytes : PROFILE_LIMITS.skillBytes, signal); }
    catch { signal?.throwIfAborted(); throw conflict('Selected profile sources changed while resolving. Reload and try again.'); }
    if (hash(text) !== source.hash) throw conflict('Selected profile sources changed while resolving. Reload and try again.');
  }
  signal?.throwIfAborted();
  const active: ActiveProfile = { profileId: selected.profileId, ...(profile ? { name: profile.name } : {}), skillIds: [...selected.skillIds], revision: catalog.revision, tools: profile ? [...profile.tools] : null };
  return { workspace: root, catalogRevision: catalog.revision, snapshot: { choice: { ...selected, catalogRevision: catalog.revision }, active, instructions, skills, sources }, ...(profile ? { defaults: { ...(profile.defaultModel ? { model: profile.defaultModel } : {}), ...(profile.defaultMode ? { mode: profile.defaultMode } : {}) } } : {}) };
}

export async function profileSourceStatus(workspace: string, snapshot: ProfileSnapshot, signal?: AbortSignal): Promise<{ status: 'current' | 'changed' | 'missing' | 'invalid'; diagnostics: ProfileDiagnostic[] }> {
  const diagnostics: ProfileDiagnostic[] = [];
  for (const source of snapshot.sources) {
    signal?.throwIfAborted();
    try {
      const content = await readProfileSource(workspace, source.path, source.path === manifestPath ? PROFILE_LIMITS.manifestBytes : PROFILE_LIMITS.skillBytes, signal);
      if (hash(content) !== source.hash) diagnostics.push({ path: source.path, code: 'changed', message: 'Source differs from the pinned session snapshot.' });
    } catch (error) { signal?.throwIfAborted(); diagnostics.push(diagnostic(source.path, error)); }
  }
  return { status: diagnostics.some(item => item.code === 'missing') ? 'missing' : diagnostics.some(item => item.code !== 'changed') ? 'invalid' : diagnostics.length ? 'changed' : 'current', diagnostics };
}
