import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
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
const manifestPath = '.lite/profiles.json';
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
const sourceSchema = z.object({ path: z.string().refine(value => value === manifestPath || /^\.lite\/skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/.test(value)), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const snapshotSchema = z.object({ choice: profileChoiceSchema, active: z.object({ profileId: slug.nullable(), name: label.optional(), skillIds: z.array(slug).max(PROFILE_LIMITS.activeSkills).refine(unique), revision: z.string().regex(/^[a-f0-9]{64}$/), tools: z.array(z.enum(PROFILE_TOOLS)).max(PROFILE_TOOLS.length).refine(unique).nullable() }).strict(), instructions: z.string().refine(value => Buffer.byteLength(value) <= PROFILE_LIMITS.profileBytes), skills: z.array(skillSchema.extend({ body: z.string().refine(value => Buffer.byteLength(value) <= PROFILE_LIMITS.skillBytes), path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(PROFILE_LIMITS.activeSkills), sources: z.array(sourceSchema).min(1).max(PROFILE_LIMITS.activeSkills + 1) }).strict();
export function validateProfileSnapshot(value: unknown): ProfileSnapshot {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw conflict('The pinned profile snapshot is invalid. Review and explicitly replace or clear the profile.');
  const snapshot = parsed.data;
  if (snapshot.choice.profileId !== snapshot.active.profileId || snapshot.choice.catalogRevision !== snapshot.active.revision || JSON.stringify(snapshot.choice.skillIds) !== JSON.stringify(snapshot.active.skillIds) || JSON.stringify(snapshot.active.skillIds) !== JSON.stringify(snapshot.skills.map(skill => skill.id)) || snapshot.active.profileId === null && (snapshot.active.tools !== null || snapshot.instructions !== '') || snapshot.active.profileId !== null && snapshot.active.tools === null || snapshot.sources[0]?.path !== manifestPath || !unique(snapshot.sources.map(source => source.path)) || snapshot.sources.length !== snapshot.skills.length + 1 || snapshot.skills.some(skill => skill.path !== `.lite/skills/${skill.id}/SKILL.md` || hash(skill.body) !== skill.hash || !snapshot.sources.some(source => source.path === skill.path && source.hash === skill.hash)) || Buffer.byteLength(snapshot.instructions) + snapshot.skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.body), 0) > PROFILE_LIMITS.activeBytes) throw conflict('The pinned profile snapshot is inconsistent. Review and explicitly replace or clear the profile.');
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
    const path = `.lite/skills/${skill.id}/SKILL.md`;
    try {
      const body = await readProfileSource(workspace, path, PROFILE_LIMITS.skillBytes, signal), source = { path, hash: hash(body) };
      skills.set(skill.id, { ...skill, body, ...source }); sources.push(source); observations.push(source);
    } catch (error) { signal?.throwIfAborted(); const item = diagnostic(path, error); diagnostics.push(item); observations.push(item); }
  }
  signal?.throwIfAborted(); return finish();
}

export async function readProfileCatalog(workspace: string, signal?: AbortSignal): Promise<ProfileCatalog> { return (await load(workspace, signal)).catalog; }
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
