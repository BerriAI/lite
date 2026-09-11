// Plugin packages (design note 4.4): install-time trust. The installer takes a
// LOCAL directory only — git URLs are out of scope in v1 (users clone first),
// which keeps the network entirely out of the install path. Flow: planInstall
// produces an exact dry-run plan (every file that would land, every settings
// key that would change, with bounded previews and per-item conflicts), then
// applyInstall executes exactly the plan's non-conflicted actions and records
// per-item provenance (kind + exact target + sha256 of installed content) under
// Settings.plugins so uninstall is exact. Trust posture: MCP servers land
// DISABLED (connecting stays the explicit act it is today) and hooks land in
// Settings.hooks behind the existing workspace-trust gate at capture time.
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hooksArraySchema } from './hooks.js';
import { HOOK_LIMITS, type HookConfig } from '../shared/hooks.js';
import { PLUGIN_LIMITS, type InstallAction, type InstallPlan, type PluginItem, type PluginRegistryEntry, type UninstallResult } from '../shared/plugins.js';
import type { McpServerConfig, Settings } from '../shared/types.js';
import type { Store } from './store.js';

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
// Key-sorted JSON so settings-entry hashes are stable across property order.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const preview = (value: string) => value.length > PLUGIN_LIMITS.previewChars ? value.slice(0, PLUGIN_LIMITS.previewChars) : value;
const hasCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

// Same slug posture as profiles/skills; the slug grammar (no dots, no slashes)
// makes traversal impossible by construction, and the credential-name
// refinement mirrors profiles so an installed skill is always loadable
// (readProfileSource rejects protectedPath skill ids).
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).refine(value => !/(?:^|[._-])private[._-]?key$/.test(value), 'Credential names are not plugin identifiers.');
const mcpName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const relPath = z.string().min(1).max(PLUGIN_LIMITS.relPath);
const version = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/); // "semverish": bounded, printable, no spaces.
const description = z.string().max(PLUGIN_LIMITS.description).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
// Mirrors the app-level mcpSchema shape minus `enabled`: a plugin can never
// choose its own enablement — applyInstall forces enabled:false.
const mcpEntrySchema = z.object({ command: z.string().min(1).max(1000).optional(), args: z.array(z.string().max(4000)).max(100).optional(), env: z.record(z.string().max(64), z.string().max(8192)).optional(), url: z.url().optional() }).strict().refine(value => Boolean(value.command) !== Boolean(value.url), 'Specify either a command or URL');
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const manifestSchema = z.object({
  name: slug,
  version,
  description: description.optional(),
  skills: z.array(z.object({ id: slug, path: relPath }).strict()).max(PLUGIN_LIMITS.skills).refine(value => unique(value.map(item => item.id)), 'Skill ids must be unique.').optional(),
  commands: z.array(z.object({ name: slug, path: relPath }).strict()).max(PLUGIN_LIMITS.commands).refine(value => unique(value.map(item => item.name)), 'Command names must be unique.').optional(),
  mcpServers: z.record(mcpName, mcpEntrySchema).refine(value => Object.keys(value).length <= 30, 'At most 30 MCP servers per plugin.').optional(),
  hooks: hooksArraySchema.optional(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

// Registry rows are durable state: revalidate defensively (like captureHooks
// does for Settings.hooks) so a hand-edited database cannot corrupt uninstall.
const itemSchema = z.object({ kind: z.enum(['skill', 'command', 'mcp', 'hook']), target: z.string().min(1).max(256), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const registryEntrySchema = z.object({ version, description: description.optional(), installedAt: z.number().int().min(0), workspace: z.string().min(1).max(4096), items: z.array(itemSchema).max(256) }).strict();

const SKILL_TARGET = /^\.litespeed\/skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/;
const COMMAND_TARGET = /^\.litespeed\/commands\/([a-z0-9][a-z0-9-]{0,63})\.md$/;
const MCP_TARGET = /^mcpServers\.([a-zA-Z0-9_-]{1,64})$/;
const HOOK_TARGET = /^hooks#([a-f0-9]{16})$/;

/** Server-internal plan: carries the full content to install per action so
 * apply never re-reads the package (the API strips it via publicPlan). */
export interface PlannedAction extends InstallAction { content: string }
export interface PluginPlan extends Omit<InstallPlan, 'actions'> { actions: PlannedAction[]; workspace: string }
export function publicPlan(plan: PluginPlan): InstallPlan {
  return { plugin: plan.plugin, actions: plan.actions.map(({ content: _content, ...action }) => action), warnings: plan.warnings, ...(plan.unmapped ? { unmapped: plan.unmapped } : {}) };
}

/** Guarded bounded read INSIDE the package directory, mirroring the
 * profile-source safety posture: no absolute or traversal segments, no
 * symlinks anywhere on the path (a link cannot smuggle content from outside
 * the package), regular single-link files only, hard byte bound, complete
 * UTF-8 without NUL. */
async function readPackageFile(root: string, relative: string, maxBytes: number): Promise<string> {
  if (relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) throw httpError(400, `Plugin path "${relative.slice(0, 200)}" is not a safe relative path.`);
  const parts = relative.split('/').filter(part => part !== '' && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) throw httpError(400, `Plugin path "${relative.slice(0, 200)}" must stay inside the package directory.`);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); } catch { throw httpError(400, `Plugin file "${relative.slice(0, 200)}" is missing.`); }
    if (stat.isSymbolicLink()) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" uses a symbolic link; links are not allowed in packages.`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !(stat.isFile() && stat.nlink === 1)) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" is not a regular package file.`);
    if (index === parts.length - 1 && stat.size > maxBytes) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" exceeds its ${maxBytes} byte limit.`);
  }
  // Whole-path recheck: catches a component swapped for a link mid-walk.
  if (await fs.realpath(current) !== current) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" resolves outside the package directory.`);
  const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" changed while being read.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" exceeds its ${maxBytes} byte limit.`);
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw httpError(400, `Plugin file "${relative.slice(0, 200)}" must be UTF-8 text.`);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw httpError(400, `Plugin file "${relative.slice(0, 200)}" must be UTF-8 text.`); }
  } finally { await handle.close(); }
}

/** Compat mapping for .claude-plugin/plugin.json: only name/version/description
 * /commands/skills map (per the design note); every other top-level key is
 * reported in `unmapped`, and entries whose shape cannot map become warnings —
 * never silent drops, never partial guesses. */
function mapCompatManifest(value: Record<string, unknown>, warnings: string[]): { manifest: Manifest; unmapped: string[] } {
  const mapped = new Set(['name', 'version', 'description', 'commands', 'skills']);
  const unmapped = Object.keys(value).filter(key => !mapped.has(key)).sort();
  const name = slug.safeParse(value.name);
  if (!name.success) throw httpError(400, 'Compatible manifest name must be a lowercase slug of 1-64 letters, digits, or hyphens.');
  const parsedVersion = version.safeParse(value.version ?? '0.0.0');
  if (!parsedVersion.success) throw httpError(400, 'Compatible manifest version must be a bounded version string.');
  let about: string | undefined;
  if (typeof value.description === 'string') {
    about = value.description.slice(0, PLUGIN_LIMITS.description);
    if (about.length < value.description.length) warnings.push('Compatible manifest description was truncated to 200 characters.');
    if (!description.safeParse(about).success) { about = undefined; warnings.push('Compatible manifest description contains control characters and was dropped.'); }
  }
  const commands: NonNullable<Manifest['commands']> = [];
  const commandPaths = typeof value.commands === 'string' ? [value.commands] : Array.isArray(value.commands) ? value.commands : value.commands === undefined ? [] : null;
  if (commandPaths === null) warnings.push('Compatible manifest commands must be a path or an array of paths; the key was ignored.');
  for (const entry of (commandPaths ?? []).slice(0, PLUGIN_LIMITS.commands)) {
    // Claude command files are markdown; the command name is the file basename.
    const relative = typeof entry === 'string' ? entry.replace(/^\.\//, '') : '';
    const parsedName = slug.safeParse(path.posix.basename(relative).replace(/\.md$/, ''));
    if (!relative.endsWith('.md') || !parsedName.success || !relPath.safeParse(relative).success) { warnings.push(`Compatible manifest command entry ${JSON.stringify(String(entry).slice(0, 120))} does not map to a named .md command and was skipped.`); continue; }
    commands.push({ name: parsedName.data, path: relative });
  }
  const skills: NonNullable<Manifest['skills']> = [];
  const skillPaths = Array.isArray(value.skills) ? value.skills : value.skills === undefined ? [] : null;
  if (skillPaths === null) warnings.push('Compatible manifest skills must be an array of paths; the key was ignored.');
  for (const entry of (skillPaths ?? []).slice(0, PLUGIN_LIMITS.skills)) {
    // A skill entry is a directory containing SKILL.md (or that file directly);
    // the skill id is the directory name — same layout skills use in .litespeed/.
    const raw = typeof entry === 'string' ? entry.replace(/^\.\//, '').replace(/\/$/, '') : '';
    const relative = raw.endsWith('/SKILL.md') ? raw : raw ? `${raw}/SKILL.md` : '';
    const parsedId = slug.safeParse(path.posix.basename(path.posix.dirname(relative)));
    if (!relative || !parsedId.success || !relPath.safeParse(relative).success) { warnings.push(`Compatible manifest skill entry ${JSON.stringify(String(entry).slice(0, 120))} does not map to a SKILL.md directory and was skipped.`); continue; }
    skills.push({ id: parsedId.data, path: relative });
  }
  if (!unique(commands.map(item => item.name)) || !unique(skills.map(item => item.id))) throw httpError(400, 'Compatible manifest maps to duplicate command or skill names.');
  return { manifest: { name: name.data, version: parsedVersion.data, ...(about ? { description: about } : {}), ...(skills.length ? { skills } : {}), ...(commands.length ? { commands } : {}) }, unmapped };
}

function registryEntry(settings: Settings, name: string): PluginRegistryEntry | undefined {
  const raw = settings.plugins?.[name];
  if (raw === undefined) return undefined;
  const parsed = registryEntrySchema.safeParse(raw);
  if (!parsed.success) throw httpError(409, `The recorded provenance for plugin "${name}" is invalid. Repair Settings.plugins before continuing.`);
  return parsed.data;
}

/** Hash of an MCP settings entry EXCLUDING `enabled`: the user connecting a
 * plugin server later must not strand the entry at uninstall time. */
const mcpHash = (config: McpServerConfig) => { const { enabled: _enabled, ...rest } = config; return hash(canonical(rest)); };
const hookHash = (hook: HookConfig) => hash(canonical(hook));

/** Existence probe for a plan target under the workspace. Any unsafe state
 * (symlink on the path, non-file) reports "exists" so the plan CONFLICTS
 * instead of apply clobbering something surprising. */
async function targetState(workspace: string, target: string): Promise<{ exists: boolean; content?: string }> {
  let current = workspace;
  for (const part of target.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (hasCode(error, 'ENOENT')) return { exists: false }; throw error; }
    if (stat.isSymbolicLink()) return { exists: true };
  }
  try { return { exists: true, content: await fs.readFile(current, 'utf8') }; } catch { return { exists: true }; }
}

export async function planInstall(source: string, workspace: string, store: Store): Promise<PluginPlan> {
  if (typeof source !== 'string' || !source.trim() || source.length > PLUGIN_LIMITS.sourcePath) throw httpError(400, 'source must be a local plugin directory path.');
  let root: string;
  try { root = await fs.realpath(path.resolve(source)); } catch { throw httpError(400, 'Plugin source directory was not found. Git URLs are not supported: clone the package locally first.'); }
  if (!(await fs.stat(root)).isDirectory()) throw httpError(400, 'Plugin source must be a directory containing litespeed-plugin.json.');
  const canonicalWorkspace = await fs.realpath(path.resolve(workspace));
  // The package must never be the workspace itself or a parent of it: install
  // targets would then alias package files and provenance would lie.
  const relation = path.relative(root, canonicalWorkspace);
  if (relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))) throw httpError(400, 'Plugin source cannot be the workspace or contain it.');
  const warnings: string[] = [];
  let manifest: Manifest, unmapped: string[] | undefined;
  let text: string | undefined;
  try { text = await readPackageFile(root, 'litespeed-plugin.json', PLUGIN_LIMITS.manifestBytes); }
  catch (error) { if (!(error instanceof Error && error.message.includes('is missing'))) throw error; }
  if (text !== undefined) {
    let value: unknown;
    try { value = JSON.parse(text.replace(/^﻿/, '')); } catch { throw httpError(400, 'litespeed-plugin.json is not valid JSON.'); }
    const parsed = manifestSchema.safeParse(value);
    if (!parsed.success) throw httpError(400, `Invalid litespeed-plugin.json: ${parsed.error.issues[0]?.message ?? 'schema error'} at ${parsed.error.issues[0]?.path.join('.') || 'root'}.`);
    manifest = parsed.data;
  } else {
    let compat: string;
    try { compat = await readPackageFile(root, '.claude-plugin/plugin.json', PLUGIN_LIMITS.manifestBytes); }
    catch { throw httpError(400, 'No plugin manifest found: expected litespeed-plugin.json (or a compatible .claude-plugin/plugin.json) at the package root.'); }
    let value: unknown;
    try { value = JSON.parse(compat.replace(/^﻿/, '')); } catch { throw httpError(400, '.claude-plugin/plugin.json is not valid JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '.claude-plugin/plugin.json must be a JSON object.');
    ({ manifest, unmapped } = mapCompatManifest(value as Record<string, unknown>, warnings));
  }
  const settings = store.settings();
  const existing = registryEntry(settings, manifest.name);
  // File ownership is per-workspace: an entry recorded for another workspace
  // cannot claim files here, and installing here will re-point the provenance.
  const sameWorkspace = existing?.workspace === canonicalWorkspace;
  if (existing && !sameWorkspace) warnings.push(`Plugin "${manifest.name}" was previously installed into ${existing.workspace}; installing here replaces its recorded provenance (files there will no longer be tracked).`);
  const ownedTargets = new Set((existing?.items ?? []).filter(item => sameWorkspace || item.kind === 'mcp' || item.kind === 'hook').map(item => item.target));
  const actions: PlannedAction[] = [];
  for (const skill of manifest.skills ?? []) {
    const content = await readPackageFile(root, skill.path, PLUGIN_LIMITS.skillBytes);
    const target = `.litespeed/skills/${skill.id}/SKILL.md`;
    const state = await targetState(canonicalWorkspace, target);
    const conflict = state.exists ? (ownedTargets.has(target) ? 'same-plugin-update' as const : 'exists' as const) : undefined;
    if (conflict === 'exists') warnings.push(`Skill "${skill.id}" conflicts with an existing ${target} not owned by this plugin; it will be skipped.`);
    actions.push({ kind: 'skill', name: skill.id, target, preview: preview(content), ...(conflict ? { conflict } : {}), content });
  }
  for (const command of manifest.commands ?? []) {
    const content = await readPackageFile(root, command.path, PLUGIN_LIMITS.commandBytes);
    const target = `.litespeed/commands/${command.name}.md`;
    const state = await targetState(canonicalWorkspace, target);
    const conflict = state.exists ? (ownedTargets.has(target) ? 'same-plugin-update' as const : 'exists' as const) : undefined;
    if (conflict === 'exists') warnings.push(`Command "${command.name}" conflicts with an existing ${target} not owned by this plugin; it will be skipped.`);
    actions.push({ kind: 'command', name: command.name, target, preview: preview(content), ...(conflict ? { conflict } : {}), content });
  }
  for (const [name, entry] of Object.entries(manifest.mcpServers ?? {})) {
    // enabled:false is part of the plan content, not a hidden apply-time patch:
    // the user reviews exactly what will be written.
    const config: McpServerConfig = { ...entry, enabled: false };
    const target = `mcpServers.${name}`;
    const conflict = settings.mcpServers[name] !== undefined ? (ownedTargets.has(target) ? 'same-plugin-update' as const : 'exists' as const) : undefined;
    if (conflict === 'exists') warnings.push(`MCP server "${name}" conflicts with an existing configured server not owned by this plugin; it will be skipped.`);
    actions.push({ kind: 'mcp', name, target, preview: preview(canonical(config)), ...(conflict ? { conflict } : {}), content: canonical(config) });
  }
  const currentHooks = hooksArraySchema.safeParse(settings.hooks ?? []);
  const currentHookHashes = (currentHooks.success ? currentHooks.data : []).map(hookHash);
  const seenHookHashes = new Set<string>();
  let plannedNewHooks = 0;
  for (const hookConfig of manifest.hooks ?? []) {
    const content = canonical(hookConfig), identity = hookHash(hookConfig);
    if (seenHookHashes.has(identity)) { warnings.push('Duplicate hook in the manifest was skipped.'); continue; }
    seenHookHashes.add(identity);
    const target = `hooks#${identity.slice(0, 16)}`;
    const present = currentHookHashes.includes(identity);
    let conflict: InstallAction['conflict'] = undefined;
    if (present) conflict = ownedTargets.has(target) ? 'same-plugin-update' : 'exists';
    // A hook set past HOOK_LIMITS.hooks would invalidate ALL app hooks at
    // capture time, so overflow hooks are skipped ('exists') with a warning
    // rather than poisoning the whole array.
    else if (currentHookHashes.length + ++plannedNewHooks > HOOK_LIMITS.hooks) { conflict = 'exists'; warnings.push(`Hook "${hookConfig.event}: ${hookConfig.command.slice(0, 80)}" would exceed the ${HOOK_LIMITS.hooks}-hook limit and will be skipped.`); }
    if (conflict === 'exists' && present) warnings.push(`Hook "${hookConfig.event}: ${hookConfig.command.slice(0, 80)}" already exists in Settings and is not owned by this plugin; it will be skipped.`);
    actions.push({ kind: 'hook', name: hookConfig.event, target, preview: preview(content), ...(conflict ? { conflict } : {}), content });
  }
  return { plugin: { name: manifest.name, version: manifest.version, ...(manifest.description ? { description: manifest.description } : {}) }, actions, warnings, ...(unmapped?.length ? { unmapped } : {}), workspace: canonicalWorkspace };
}

/** Validate a file target and return its safe absolute path: fixed shapes
 * only, and no symlink on any existing component (a linked .litespeed/ must never
 * redirect an install outside the workspace). */
async function safeFileTarget(workspace: string, kind: 'skill' | 'command', target: string): Promise<string> {
  if (!(kind === 'skill' ? SKILL_TARGET : COMMAND_TARGET).test(target)) throw httpError(400, `Invalid ${kind} target path.`);
  let current = workspace;
  for (const part of target.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw httpError(409, `Install target ${target} crosses a symbolic link.`); }
    catch (error) { if (hasCode(error, 'ENOENT')) break; throw error; }
  }
  return path.join(workspace, ...target.split('/'));
}

export interface ApplyResult { name: string; entry: PluginRegistryEntry; warnings: string[] }

/** Execute exactly the plan's non-'exists' actions. Atomic-ish, documented:
 * files are written first (snapshotting prior content of owned updates), then
 * ONE settings save covers mcp + hooks + provenance. On any file error every
 * file written so far is rolled back best-effort (prior content restored, new
 * files unlinked) and nothing is persisted to settings. A crash between the
 * last file write and the settings save can leave untracked files — the plan
 * lists their exact paths, so recovery is manual but fully visible. */
export async function applyInstall(plan: PluginPlan, workspace: string, store: Store): Promise<ApplyResult> {
  const canonicalWorkspace = await fs.realpath(path.resolve(workspace));
  if (canonicalWorkspace !== plan.workspace) throw httpError(409, 'The plan was computed for a different workspace. Re-plan and retry.');
  const apply = plan.actions.filter(action => action.conflict !== 'exists');
  const warnings = [...plan.warnings];
  const written: { absolute: string; prior: string | null }[] = [];
  try {
    for (const action of apply) {
      if (action.kind !== 'skill' && action.kind !== 'command') continue;
      const absolute = await safeFileTarget(canonicalWorkspace, action.kind, action.target);
      let prior: string | null = null;
      try { prior = await fs.readFile(absolute, 'utf8'); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, action.content, 'utf8');
      written.push({ absolute, prior });
    }
  } catch (error) {
    // Best-effort rollback: restore what was overwritten, unlink what was new.
    // Rollback failures are swallowed — the original error is the actionable one.
    for (const file of written.reverse()) {
      try { if (file.prior === null) await fs.unlink(file.absolute); else await fs.writeFile(file.absolute, file.prior, 'utf8'); } catch { /* best effort */ }
    }
    throw error;
  }
  // One settings save: mcp entries (enabled:false already baked into content),
  // appended hooks, and the provenance registry move together or not at all.
  // The patch stays MINIMAL: hooks/mcpServers are only touched when the plugin
  // actually ships such items, so an install can never clobber unrelated state.
  const settings = store.settings();
  const patch: Partial<Settings> = {};
  const mcpActions = apply.filter(action => action.kind === 'mcp');
  if (mcpActions.length) {
    const mcpServers = { ...settings.mcpServers };
    for (const action of mcpActions) {
      const name = MCP_TARGET.exec(action.target)?.[1];
      if (!name) throw httpError(400, 'Invalid MCP target key.');
      mcpServers[name] = { ...(JSON.parse(action.content) as McpServerConfig), enabled: false }; // Forced regardless of plan content.
    }
    patch.mcpServers = mcpServers;
  }
  const hookActions = apply.filter(action => action.kind === 'hook');
  if (hookActions.length) {
    const parsedHooks = hooksArraySchema.safeParse(settings.hooks ?? []);
    const hooks: HookConfig[] = parsedHooks.success ? [...parsedHooks.data] : [];
    if (!parsedHooks.success) warnings.push('Existing Settings.hooks were invalid and were replaced by the plugin hooks.');
    const presentHashes = new Set(hooks.map(hookHash));
    for (const action of hookActions) {
      const hookConfig = JSON.parse(action.content) as HookConfig;
      if (!presentHashes.has(hookHash(hookConfig))) { hooks.push(hookConfig); presentHashes.add(hookHash(hookConfig)); }
    }
    patch.hooks = hooks;
  }
  // MCP provenance hashes exclude `enabled` (see mcpHash): connecting the
  // server later must still uninstall cleanly. Files and hooks hash verbatim.
  const items: PluginItem[] = apply.map(action => ({ kind: action.kind, target: action.target, hash: action.kind === 'mcp' ? mcpHash(JSON.parse(action.content) as McpServerConfig) : hash(action.content) }));
  const previous = settings.plugins?.[plan.plugin.name];
  const previousParsed = previous ? registryEntrySchema.safeParse(previous) : undefined;
  // A version that stops shipping an item never silently orphans it: the old
  // file/entry stays (user may rely on it) but the drop is reported.
  if (previousParsed?.success) {
    const kept = new Set(items.map(item => `${item.kind}:${item.target}`));
    for (const item of previousParsed.data.items) if (!kept.has(`${item.kind}:${item.target}`)) warnings.push(`Previously installed ${item.kind} ${item.target} is no longer provided by this version; it was left in place and is no longer tracked.`);
  }
  const entry: PluginRegistryEntry = { version: plan.plugin.version, ...(plan.plugin.description ? { description: plan.plugin.description } : {}), installedAt: Date.now(), workspace: canonicalWorkspace, items };
  store.saveSettings({ ...patch, plugins: { ...settings.plugins, [plan.plugin.name]: entry } });
  return { name: plan.plugin.name, entry, warnings };
}

/** Remove exactly the provenance-recorded items. A file whose current content
 * hash differs from the recorded install hash was modified by the user: it is
 * LEFT in place with a warning, never deleted. Settings entries are removed
 * only when they still match the recorded hash (mcp compares without
 * `enabled`, so a server the user merely connected still uninstalls). */
export async function uninstall(name: string, workspace: string, store: Store): Promise<UninstallResult> {
  const parsedName = slug.safeParse(name);
  if (!parsedName.success) throw httpError(400, 'Plugin name must be a lowercase slug.');
  const settings = store.settings();
  const entry = registryEntry(settings, parsedName.data);
  if (!entry) throw httpError(404, `Plugin "${parsedName.data}" is not installed.`);
  const removed: UninstallResult['removed'] = [];
  const warnings: string[] = [];
  let requested: string | undefined;
  try { requested = await fs.realpath(path.resolve(workspace)); } catch { /* informational only */ }
  // Files are removed from the workspace RECORDED at install time — that is
  // where the provenance points; a different --workspace only earns a note.
  if (requested && requested !== entry.workspace) warnings.push(`Plugin files were installed into ${entry.workspace}; removing them there.`);
  const mcpServers = { ...settings.mcpServers };
  const parsedHooks = hooksArraySchema.safeParse(settings.hooks ?? []);
  const hooks: HookConfig[] = parsedHooks.success ? [...parsedHooks.data] : [];
  for (const item of entry.items) {
    if (item.kind === 'skill' || item.kind === 'command') {
      let absolute: string;
      try { absolute = await safeFileTarget(entry.workspace, item.kind, item.target); }
      catch { warnings.push(`${item.target} is no longer a safe target; it was left in place.`); continue; }
      let content: string;
      try { content = await fs.readFile(absolute, 'utf8'); }
      catch (error) { if (!hasCode(error, 'ENOENT')) warnings.push(`${item.target} could not be read; it was left in place.`); continue; }
      if (hash(content) !== item.hash) { warnings.push(`${item.target} was modified after installation; it was left in place.`); continue; }
      await fs.unlink(absolute);
      // A skill's directory is plugin-created; remove it when now empty.
      if (item.kind === 'skill') await fs.rmdir(path.dirname(absolute)).catch(() => { /* user files remain */ });
      removed.push({ kind: item.kind, target: item.target });
    } else if (item.kind === 'mcp') {
      const key = MCP_TARGET.exec(item.target)?.[1];
      if (!key) { warnings.push(`${item.target} is not a valid MCP target; it was left in place.`); continue; }
      const config = mcpServers[key];
      if (config === undefined) continue; // Already gone: nothing to remove.
      if (mcpHash(config) !== item.hash) { warnings.push(`MCP server "${key}" was modified after installation; it was left in place.`); continue; }
      delete mcpServers[key];
      removed.push({ kind: 'mcp', target: item.target });
    } else {
      const identity = HOOK_TARGET.exec(item.target)?.[1];
      const index = hooks.findIndex(hookConfig => { const value = hookHash(hookConfig); return value === item.hash && value.slice(0, 16) === identity; });
      if (index < 0) continue; // Removed or edited by the user: settings entries only uninstall when they still match.
      hooks.splice(index, 1);
      removed.push({ kind: 'hook', target: item.target });
    }
  }
  const plugins = { ...settings.plugins };
  delete plugins[parsedName.data];
  // Only patch the settings sections this plugin actually recorded items in;
  // an uninstall of a files-only plugin never rewrites mcpServers or hooks.
  store.saveSettings({ ...(entry.items.some(item => item.kind === 'mcp') ? { mcpServers } : {}), ...(entry.items.some(item => item.kind === 'hook') ? { hooks } : {}), plugins });
  return { removed, warnings };
}
