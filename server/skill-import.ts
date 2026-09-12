/** Skill import engine (copy-only, opt-in). Copies a Claude/Codex skill
 * directory -- a folder containing a valid SKILL.md plus any bounded support
 * files -- into `.litespeed/skills/<id>/` and registers it in the existing
 * strict profile manifest, preserving all profiles and currently declared
 * skills. It NEVER mutates the source tree and NEVER runs anything (an
 * executable bit is preserved on copied scripts, not executed).
 *
 * Discovery is only performed when the user explicitly opens the importer.
 * Roots are FIXED identifiers resolved server-side (never arbitrary client
 * paths): Claude home + project, Codex home/modern-home + project (+ optional
 * legacy project). Selection binds to a source hash that is revalidated before
 * apply so a plan cannot silently land on changed content.
 *
 * Safety posture: source and destination components are walked with `lstat`
 * and rejected if they are symbolic links or otherwise aliased, so a project
 * `.claude/skills` link (or a `.litespeed/skills` link) cannot escape the
 * workspace. Every destination mkdir/open is preceded and followed by canonical
 * identity checks of the created chain, and rollback only removes identities
 * this pass created -- never a replaced, modified, or preexisting path. Bounds
 * (entry count, depth, per-file and total bytes) are enforced incrementally
 * BEFORE allocating buffers. Support files may be binary; only SKILL.md must be
 * valid UTF-8 without NUL bytes.
 */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  PROFILE_LIMITS,
  readStrictManifest,
  validateStrictManifest,
  withProfileWriteLock,
  writeStrictManifest,
} from './profiles.js';
import {
  SKILL_IMPORT_LIMITS,
  type SkillCandidate,
  type SkillImportFile,
  type SkillImportPlan,
  type SkillImportResult,
  type SkillRootId,
  type SkillRootSummary,
  type SkillScope,
} from '../shared/skill-import.js';

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const invalid = (message: string) => httpError(400, message);
const conflict = (message: string) => httpError(409, message);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const slug = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const validSkillId = (value: string) => slug(value) && !/(?:^|[._-])private[._-]?key$/.test(value);
const hasCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

interface RootDef { rootId: SkillRootId; rootName: string; scope: SkillScope }
const ROOT_DEFS: RootDef[] = [
  { rootId: 'claude:home', rootName: '~/.claude/skills', scope: 'home' },
  { rootId: 'claude:project', rootName: '.claude/skills (project)', scope: 'project' },
  { rootId: 'codex:home', rootName: '$CODEX_HOME/skills (or ~/.codex/skills)', scope: 'home' },
  { rootId: 'codex:agents-home', rootName: '~/.agents/skills', scope: 'home' },
  { rootId: 'codex:project', rootName: '.agents/skills (project)', scope: 'project' },
  { rootId: 'codex:legacy-project', rootName: '.codex/skills (project)', scope: 'project' },
];

/** Canonical base + workspace-relative path to a fixed skill root, or null when
 * the root is not configured (its base directory is absent). */
async function rootBase(def: RootDef, workspaceCanonical: string): Promise<{ base: string; relative: string } | null> {
  try {
    switch (def.rootId) {
      case 'claude:home': return { base: await fs.realpath(homedir()), relative: '.claude/skills' };
      case 'claude:project': return { base: workspaceCanonical, relative: '.claude/skills' };
      case 'codex:home': {
        const env = process.env.CODEX_HOME;
        if (env) return { base: await fs.realpath(env), relative: 'skills' };
        return { base: await fs.realpath(homedir()), relative: '.codex/skills' };
      }
      case 'codex:agents-home': return { base: await fs.realpath(homedir()), relative: '.agents/skills' };
      case 'codex:project': return { base: workspaceCanonical, relative: '.agents/skills' };
      case 'codex:legacy-project': return { base: workspaceCanonical, relative: '.codex/skills' };
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** Walk `relative` from the canonical `base`, rejecting any symbolic link or
 * non-directory component and returning the resolved real directory path, or
 * null when the root does not exist. A canonical base plus a strict lstat walk
 * guarantees the returned root is a real subdirectory of `base` (no escape). */
async function safeResolve(base: string, relative: string): Promise<string | null> {
  let current = base;
  const parts = relative.split('/').filter(Boolean);
  if (!parts.length) return base;
  for (const part of parts) {
    const next = join(current, part);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try { st = await fs.lstat(next); }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
    if (st.isSymbolicLink()) throw invalid('The skill source root uses a symbolic link.');
    if (!st.isDirectory()) return null;
    current = next;
  }
  return current;
}

/** Refuse credential-sensitive or private filenames anywhere in a skill folder
 * (mirrors the profile read posture); any matching component is rejected. */
const SECRET_SEGMENT = /(?:^|[._-])private[._-]?key(?:\.(?:pem|key))?$|\.(?:pem|p12|pfx)$/;
const refusedSegment = (segment: string): boolean => {
  const name = segment.toLowerCase();
  return ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', '.netrc', '.git-credentials', '.ssh', '.git', '.litespeed', '.env'].includes(name) ||
    (name.startsWith('.env.') && name !== '.env.example') || SECRET_SEGMENT.test(name);
};

/** Reject unexpected control characters or OS separator tricks in a single
 * path component; attribute delimiters (U+FF0E etc.) are treated as content. */
const WEIRD_NAME = /[\x00-\x1f\x7f]/;
const validComponent = (segment: string): boolean => segment.length > 0 && segment.length <= 128 && !WEIRD_NAME.test(segment) && segment !== '.' && segment !== '..' && !/[\\/\u0000]/.test(segment);

/** Safe bounded read of a single file under a canonical `dir`. Walks every
 * component with lstat refusing symlinks, then verifies path identity via
 * realpath BEFORE and AFTER the bounded read plus a final stat so a file that
 * grows/changes/gets replaced mid-read is caught (plugin/tools precedent). */
async function readStrictFile(dir: string, relparts: string[], maxBytes: number, needUtf8: boolean): Promise<{ bytes: Buffer; executable: boolean }> {
  let current = dir;
  const identities: { value: string; stat: Awaited<ReturnType<typeof fs.lstat>> }[] = [];
  for (let index = 0; index < relparts.length; index++) {
    current = join(current, relparts[index]);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try { st = await fs.lstat(current); }
    catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) throw invalid('Skill source file is missing.'); throw error; }
    if (st.isSymbolicLink()) throw invalid('Skill source may not use symbolic links.');
    if (index < relparts.length - 1 && !st.isDirectory()) throw invalid('Skill source path is not a directory.');
    if (index === relparts.length - 1 && !st.isFile()) throw invalid('Skill source file is not a regular file.');
    if (index === relparts.length - 1 && st.nlink !== 1) throw invalid('Skill source file may not be a hard link.');
    identities.push({ value: current, stat: st });
  }
  const expected = identities.at(-1)!.stat;
  if (expected.size > maxBytes) throw invalid(`Skill source file exceeds its ${maxBytes} byte limit.`);
  const verify = async () => {
    for (const entry of identities) {
      const now = await fs.lstat(entry.value);
      if (now.isSymbolicLink() || now.dev !== entry.stat.dev || now.ino !== entry.stat.ino || now.isDirectory() !== entry.stat.isDirectory()) throw invalid('Skill source changed while being read.');
    }
    if (await fs.realpath(current) !== current) throw invalid('Skill source may not be reached through an alias.');
  };
  await verify();
  const handle = await fs.open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs || opened.ctimeMs !== expected.ctimeMs) throw invalid('Skill source changed while being read.');
    await verify();
    const buffer = Buffer.alloc(opened.size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== opened.size) throw invalid('Skill source changed while being read.');
    const after = await handle.stat();
    if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || length !== opened.size) throw invalid('Skill source changed while being read.');
    // SKILL.md must be valid UTF-8 without NUL; support files may be binary.
    if (needUtf8) {
      if (buffer.includes(0)) throw invalid('Skill source SKILL.md may not contain NUL bytes.');
      try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
      catch { throw invalid('Skill source SKILL.md must be valid UTF-8 text.'); }
    }
    await verify();
    return { bytes: buffer, executable: (opened.mode & 0o111) !== 0 };
  } finally { await handle.close(); }
}

interface WalkedFile { rel: string; bytes: Buffer; executable: boolean }

/** Walk a skill folder, returning every regular file with metadata. Enforces a
 * GLOBAL entry budget that counts EVERY entry (files and directories) while
 * reading a directory incrementally, plus depth, per-file size, and a running
 * total-byte budget BEFORE buffering so an unbounded or huge-empty tree cannot
 * exhaust memory. Each file read is capped to the smaller of its own limit and
 * the remaining total budget, so a changed size cannot outrun the bound.
 * Refuses symlinks, secret/weird filenames, and non-regular files. */
async function walkSkill(root: string): Promise<WalkedFile[]> {
  if (await fs.realpath(root) !== root) throw invalid('Skill directory may not be reached through a link.');
  const files: WalkedFile[] = [];
  let entries = 0;
  let totalBytes = 0;
  const visit = async (dir: string, depth: number) => {
    if (depth > SKILL_IMPORT_LIMITS.depth) throw invalid('Skill folder exceeds its depth limit.');
    let handle;
    try { handle = await fs.opendir(dir); }
    catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) throw invalid('Skill source directory is missing.'); throw error; }
    const names: string[] = [];
    try {
      for await (const entry of handle) {
        entries++;
        if (entries > SKILL_IMPORT_LIMITS.files) throw invalid('Skill folder has too many files.');
        names.push(entry.name);
      }
    } finally { await handle.close().catch(() => {}); }
    names.sort();
    for (const name of names) {
      if (refusedSegment(name)) throw invalid(`Skill folder contains a protected path: ${name}`);
      if (!validComponent(name)) throw invalid(`Skill folder contains an unsupported file name: ${name}`);
      const absolute = join(dir, name);
      const st = await fs.lstat(absolute);
      if (st.isSymbolicLink()) throw invalid('Skill folder may not contain symbolic links.');
      if (st.isDirectory()) { await visit(absolute, depth + 1); continue; }
      if (!st.isFile() || st.nlink !== 1) throw invalid('Skill folder may only contain regular files.');
      if (entries + 1 > SKILL_IMPORT_LIMITS.files) throw invalid('Skill folder has too many files.');
      const rel = relative(root, absolute).replace(/\\/g, '/');
      const isSkill = rel === 'SKILL.md';
      const fileLimit = isSkill ? SKILL_IMPORT_LIMITS.skillBytes : SKILL_IMPORT_LIMITS.supportFileBytes;
      const remaining = SKILL_IMPORT_LIMITS.totalBytes - totalBytes;
      if (remaining <= 0) throw invalid(`Skill folder exceeds its total byte limit of ${SKILL_IMPORT_LIMITS.totalBytes}.`);
      const read = await readStrictFile(root, rel.split('/'), Math.min(fileLimit, remaining), isSkill);
      totalBytes += read.bytes.length;
      files.push({ rel, bytes: read.bytes, executable: read.executable });
    }
  };
  await visit(root, 0);
  return files;
}

/** Minimal YAML-ish front matter: `name:` / `description:` between `---` fences. */
function parseMeta(body: string): { name?: string; description?: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(body.replace(/^\uFEFF/, ''));
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const name = /^name:\s*(.*)$/.exec(line), desc = /^description:\s*(.*)$/.exec(line);
    const value = name?.[1] ?? desc?.[1];
    if (value === undefined) continue;
    const clean = value.replace(/^["']|["']$/g, '').trim();
    if (name) out.name = clean; else out.description = clean;
  }
  return out;
}
const printable = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
const boundedName = (id: string, value: string) => printable(value).slice(0, SKILL_IMPORT_LIMITS.nameLength) || id;
const boundedDescription = (value: string) => printable(value).slice(0, SKILL_IMPORT_LIMITS.descriptionLength);

interface ResolvedCandidate extends SkillCandidate { files: WalkedFile[] }

/** True when a fixed source hash covers the tree's structure and executable
 * mode, so a chmod-only change is also detected between plan and apply. */
function treeHash(files: WalkedFile[]): string {
  return sha256(files.map(file => `${file.rel}\u0000${file.executable ? '1' : '0'}\u0000${sha256(file.bytes.toString('base64'))}`).sort().join('\n'));
}

/** Destination conflict: an existing `.litespeed/skills/<id>` directory, any
 * dangling/invalid link at that path (lstat -- never follows), or a non-dir
 * blocking it. */
async function destinationConflict(root: string, id: string): Promise<{ conflict: boolean; reason: string }> {
  const dest = join(root, '.litespeed', 'skills', id);
  let st;
  try { st = await fs.lstat(dest); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return { conflict: false, reason: '' };
    if (hasCode(error, 'ENOTDIR')) return { conflict: true, reason: 'A file blocks this skill destination.' };
    throw error;
  }
  if (st.isSymbolicLink()) return { conflict: true, reason: 'A link already exists at this skill destination. Remove it before importing.' };
  if (!st.isDirectory()) return { conflict: true, reason: 'A file already exists at this skill destination. Remove it before importing.' };
  return { conflict: true, reason: 'Already imported into this project.' };
}

/** Resolve and deepen one candidate skill by name under an already canonical
 * root. Shared by scanRoot (discovery) and the targeted plan/apply paths. */
async function resolveOne(def: RootDef, skillRoot: string, workspaceCanonical: string, name: string): Promise<ResolvedCandidate | null> {
  if (!validSkillId(name) || refusedSegment(name)) return null;
  const dir = join(skillRoot, name);
  // Project roots must not alias out of the (already canonical) workspace.
  if (def.scope === 'project') {
    let real: string;
    try { real = await fs.realpath(dir); } catch { return null; }
    const rel = relative(workspaceCanonical, real);
    if (rel === '..' || rel.startsWith('..') || rel.includes('..' + '\\')) return null;
  }
  const files = await walkSkill(dir);
  const skillFile = files.find(file => file.rel === 'SKILL.md');
  if (!skillFile) return null;
  const meta = parseMeta(skillFile.bytes.toString('utf8'));
  return {
    source: def.rootId.startsWith('claude') ? 'claude' : 'codex',
    scope: def.scope, rootId: def.rootId, rootName: def.rootName,
    root: dir, id: name, name: boundedName(name, meta.name ?? ''), description: boundedDescription(meta.description ?? ''),
    fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), sourceHash: treeHash(files),
    conflict: false, conflictReason: '', files,
  };
}

/** Scan one fixed root for discovery, streaming entries with `opendir` so no
 * sibling buffer is retained beyond its candidate. At most
 * SKILL_IMPORT_LIMITS.candidates skill directories are deepened (with a
 * truncation warning); every candidate buffer is released before the next one.
 * When `target` is given (plan/apply), only that exact skill is lstat'd and
 * walked -- no sibling listing is performed at all. */
async function scanRoot(def: RootDef, skillRoot: string, workspaceCanonical: string, declaredIds: Set<string>, target?: string): Promise<{ candidates: ResolvedCandidate[]; issues: string[] }> {
  const candidates: ResolvedCandidate[] = [], issues: string[] = [];
  if (target !== undefined) {
    const dir = join(skillRoot, target);
    let st;
    try { st = await fs.lstat(dir); }
    catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) { issues.push(`Skipped ${target}: no such skill directory.`); return { candidates, issues }; }
      throw error;
    }
    if (st.isSymbolicLink()) { issues.push(`Skipped ${target}: the source directory is a symbolic link.`); return { candidates, issues }; }
    if (!st.isDirectory()) { issues.push(`Skipped ${target}: not a directory.`); return { candidates, issues }; }
    const candidate = await resolveOne(def, skillRoot, workspaceCanonical, target);
    if (!candidate) { issues.push(`Skipped ${target}: not an importable skill.`); return { candidates, issues }; }
    const dest = await destinationConflict(workspaceCanonical, target);
    const conflictFlag = dest.conflict || declaredIds.has(target);
    candidate.conflict = conflictFlag;
    candidate.conflictReason = dest.conflict ? dest.reason : declaredIds.has(target) ? 'Already registered in .litespeed/profiles.json.' : '';
    candidates.push(candidate);
    return { candidates, issues };
  }

  let handle;
  try {
    handle = await fs.opendir(skillRoot);
    let deepened = 0;
    let enumerated = 0;
    for await (const entry of handle) {
      if (++enumerated > SKILL_IMPORT_LIMITS.listingEntries) {
        issues.push(`Skill root has too many entries; showing the first ${SKILL_IMPORT_LIMITS.listingEntries} only.`);
        break;
      }
      if (entry.isSymbolicLink()) { issues.push(`Skipped unsupported directory name: ${entry.name}`); continue; }
      if (!entry.isDirectory()) continue;
      if (!validSkillId(entry.name) || refusedSegment(entry.name)) { issues.push(`Skipped unsupported directory name: ${entry.name}`); continue; }
      if (deepened >= SKILL_IMPORT_LIMITS.candidates) {
        issues.push(`Skill root has more than ${SKILL_IMPORT_LIMITS.candidates} skills; showing the first batch only.`);
        break;
      }
      deepened++;
      const candidate = await resolveOne(def, skillRoot, workspaceCanonical, entry.name).catch((error: unknown) => {
        issues.push(`Skipped ${entry.name}: ${error instanceof Error ? error.message : 'invalid skill folder'}.`);
        return null;
      });
      if (!candidate) continue; // walkSkill already pushed a reason for validation failures
      const dest = await destinationConflict(workspaceCanonical, candidate.id);
      const conflictFlag = dest.conflict || declaredIds.has(candidate.id);
      candidate.conflict = conflictFlag;
      candidate.conflictReason = dest.conflict ? dest.reason : declaredIds.has(candidate.id) ? 'Already registered in .litespeed/profiles.json.' : '';
      // Discovery only needs metadata + hash; drop the walked buffers now so at
      // most one candidate's bytes are live at a time (never up to roots*candidates).
      candidate.files = [];
      candidates.push(candidate);
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return { candidates, issues };
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return { candidates, issues };
}

/** Discover importable skills across the fixed Claude/Codex home and project
 * roots. Called only when the user explicitly opens the importer. */
export async function skillDiscover(workspace: string): Promise<{ roots: SkillRootSummary[]; candidates: SkillCandidate[]; issues: string[] }> {
  const root = await fs.realpath(workspace);
  let declaredIds = new Set<string>();
  try { declaredIds = new Set((await readStrictManifest(root)).manifest.skills.map(skill => skill.id)); }
  catch (error) { /* report alongside scanning; apply will surface it */ void error; }
  const candidates: ResolvedCandidate[] = [], issues: string[] = [], roots: SkillRootSummary[] = [];
  for (const def of ROOT_DEFS) {
    const base = await rootBase(def, root);
    let fromRoot: ResolvedCandidate[] = [], fromIssues: string[] = [];
    if (base) {
      try {
        const skillRoot = await safeResolve(base.base, base.relative);
        if (skillRoot) ({ candidates: fromRoot, issues: fromIssues } = await scanRoot(def, skillRoot, root, declaredIds));
      } catch (error) {
        // A linked/invalid root is skipped for discovery (other roots stay
        // usable); plan/apply still reject the affected root directly.
        fromIssues.push(`${def.rootName}: ${error instanceof Error ? error.message : 'source not available'}.`);
      }
    }
    roots.push({ rootId: def.rootId, rootName: def.rootName, count: fromRoot.length });
    candidates.push(...fromRoot); issues.push(...fromIssues);
  }
  return {
    roots,
    candidates: candidates.map(({ files: _files, ...candidate }) => candidate),
    issues,
  };
}

/** Dry-run plan for importing one skill by fixed root id + id. Reads only the
 * requested skill tree; lists the destination file set and conflict state. */
export async function skillPlan(workspace: string, rootId: SkillRootId, id: string): Promise<SkillImportPlan> {
  const root = await fs.realpath(workspace);
  const def = ROOT_DEFS.find(item => item.rootId === rootId);
  if (!def) throw invalid('Unknown skill source root.');
  if (!validSkillId(id)) throw invalid('Invalid skill id.');
  const { manifest } = await readStrictManifest(root);
  const declaredIds = new Set(manifest.skills.map(skill => skill.id));
  const base = await rootBase(def, root);
  if (!base) throw invalid('That skill source is not configured.');
  const skillRoot = await safeResolve(base.base, base.relative);
  const { candidates } = skillRoot ? await scanRoot(def, skillRoot, root, declaredIds, id) : { candidates: [] };
  const candidate = candidates.find(item => item.id === id);
  if (!candidate) throw invalid('That skill was not found in the selected source. Refresh discovery and try again.');
  return buildPlan(root, candidate);
}

function buildPlan(workspace: string, candidate: ResolvedCandidate): SkillImportPlan {
  const files: SkillImportFile[] = candidate.files.map(file => ({
    path: `.litespeed/skills/${candidate.id}/${file.rel}`, bytes: file.bytes.length, executable: file.executable,
  }));
  const { files: _files, ...candidateMeta } = candidate;
  return {
    candidate: candidateMeta, files, conflict: candidate.conflict, conflictReason: candidate.conflictReason,
    warnings: [], sourceHash: candidate.sourceHash,
    destinationRoot: join(workspace, '.litespeed', 'skills', candidate.id),
  };
}

/** Track a directory either created by this pass (with its identity) or a
 * preexisting canonical directory we may create children under. */
interface CreatedDir { value: string; identity: { dev: number; ino: number }; owned?: boolean }
/** A file this pass wrote exclusively (never a preexisting user file).
 * `stat` holds the state we actually wrote (filled after a successful write),
 * so a later external edit that keeps the same inode is never treated as ours. */
interface WrittenFile { value: string; identity: { dev: number; ino: number }; stat?: { size: number; mtimeMs: number; ctimeMs: number } }

/** Verify a canonical-identity record (dev/ino) still resolves to that same
 * directory and was reached through a non-aliased chain ending at this path. */
async function verifyCanonicalDir(record: CreatedDir): Promise<void> {
  const now = await fs.lstat(record.value);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== record.identity.dev || now.ino !== record.identity.ino) throw invalid('The skill destination changed while it was written.');
  if (await fs.realpath(record.value) !== record.value) throw invalid('The skill destination may not be reached through an alias.');
}

/** Verify a created directory's full ancestor chain is still the same set of
 * canonical identities we created/validated -- a substituted parent link at any
 * level is caught BEFORE the next mkdir/open. `records` must contain every
 * created target directory plus the base (`.litespeed`/`skills`/`<id>`). */
async function verifyCanonicalChain(records: CreatedDir[]): Promise<void> {
  for (const record of records) await verifyCanonicalDir(record);
}

/** Alias-safe directory creation relative to an already canonical parent
 * directory. mkdirs one level at a time (never `recursive`, which could follow
 * an injected link), verifying each existing component is the same canonical
 * directory before descending, and records exactly the directories it creates
 * so rollback only ever removes identities this pass created. `records` must
 * include the starting `start` record so the full chain is verifiable. */
async function createDirPath(start: CreatedDir, rel: string, records: CreatedDir[]): Promise<void> {
  let current = start;
  for (const part of rel.split('/')) {
    if (!part) continue;
    const next = join(current.value, part);
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try { st = await fs.lstat(next); }
    catch (error) {
      if (hasCode(error, 'ENOENT')) {
        await verifyCanonicalChain(records); // parent chain still identical before mkdir
        await fs.mkdir(next); // plain mkdir: no recursive-follow of a substituted parent
        const fresh = await fs.lstat(next);
        current = { value: next, identity: { dev: fresh.dev, ino: fresh.ino }, owned: true };
        records.push(current);
        continue;
      }
      throw error;
    }
    if (st.isSymbolicLink()) throw invalid('The skill destination uses a symbolic link.');
    if (!st.isDirectory()) throw invalid('The skill destination path is not a directory.');
    // Existing component: must be a canonical directory we already validated or
    // created in this pass (dev/ino match), then verify the chain and descend.
    await verifyCanonicalChain([...records, { value: next, identity: { dev: st.dev, ino: st.ino } }]);
    current = { value: next, identity: { dev: st.dev, ino: st.ino } };
  }
}

/** Result of a tree write: deletes only identities this pass created and only
 * after re-verifying their canonical parent chain -- never a substituted link,
 * never a replaced/modified file, never a preexisting or user-owned directory.
 * No recursive deletion (only empty created dirs and the exact written files).
 * Safe after a manifest registration failure; a no-op when nothing was written. */
interface TreeWrite { rollback: () => Promise<void> }

/** Write a skill's bounded tree into `.litespeed/skills/<id>/` under a freshly
 * `wx`-created directory. Every mkdir/open is preceded and followed by canonical
 * identity checks of the full created chain, so a substituted parent symlink is
 * caught regardless of when it appears. ALL creation happens inside the `try`
 * whose catch runs rollback; the returned `rollback` additionally covers a later
 * manifest-write failure without touching preexisting/user-owned paths. */
async function writeSkillTree(root: string, id: string, files: WalkedFile[]): Promise<TreeWrite> {
  const records: CreatedDir[] = [];
  const written: WrittenFile[] = [];
  const rollback = async () => {
    // A substituted parent link at any level invalidates every file: refuse to
    // delete anything rather than remove a file that now aliases elsewhere.
    let chainOk = true;
    try { await verifyCanonicalChain(records); } catch { chainOk = false; }
    for (const file of written.slice().reverse()) {
      if (!chainOk) continue;
      let st;
      try { st = await fs.lstat(file.value); } catch { continue; }
      // Only unlink an unchanged file this pass wrote; never a modified/replaced one.
      if (st.isSymbolicLink() || !st.isFile() || st.dev !== file.identity.dev || st.ino !== file.identity.ino) continue;
      // A same-inode external edit must not be deleted: require the exact byte
      // state this pass wrote (captured after a completed write).
      if (file.stat && (st.size !== file.stat.size || st.mtimeMs !== file.stat.mtimeMs || st.ctimeMs !== file.stat.ctimeMs)) continue;
      await fs.unlink(file.value).catch(() => {});
    }
    for (const record of records.slice().reverse()) {
      if (!record.owned) continue;
      let st;
      try { st = await fs.lstat(record.value); } catch { continue; }
      if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== record.identity.dev || st.ino !== record.identity.ino) continue;
      // Only a created directory with a canonical parent may be removed; rmdir
      // fails on non-empty, so this never deletes a user's later-added content.
      let parentSt;
      try {
        parentSt = await fs.lstat(dirname(record.value));
        if (parentSt.isSymbolicLink() || !parentSt.isDirectory()) continue;
      } catch { continue; }
      await fs.rmdir(record.value).catch(() => {});
    }
  };

  try {
    // Root is part of the canonical chain (so a substituted workspace link is
    // caught) but is never owned, so rollback never attempts to remove it.
    const rootSt = await fs.lstat(root);
    records.push({ value: root, identity: { dev: rootSt.dev, ino: rootSt.ino } });
    let current: CreatedDir | null = null;
    for (const part of ['.litespeed', 'skills', id]) {
      const next = join(part === '.litespeed' ? root : (current as CreatedDir).value, part);
      let st;
      try { st = await fs.lstat(next); }
      catch (error) {
        if (hasCode(error, 'ENOENT')) {
          await verifyCanonicalChain(records); // everything we made so far still identical
          await fs.mkdir(next);
          const fresh = await fs.lstat(next);
          const record = { value: next, identity: { dev: fresh.dev, ino: fresh.ino }, owned: true };
          records.push(record);
          current = record;
          continue;
        }
        throw error;
      }
      if (st.isSymbolicLink()) throw invalid('The skill destination uses a symbolic link.');
      if (!st.isDirectory()) throw invalid('The skill destination path is not a directory.');
      if (part === id) throw conflict('This skill destination already exists.');
      const record = { value: next, identity: { dev: st.dev, ino: st.ino } };
      if (records.length) await verifyCanonicalChain(records);
      records.push(record);
      current = record;
    }
    const skillDir = current as CreatedDir;

    for (const file of files) {
      const relDir = dirname(file.rel);
      if (relDir !== '.') await createDirPath(skillDir, relDir, records);
      const absolute = join(skillDir.value, ...file.rel.split('/'));
      await verifyCanonicalChain(records); // canonical chain before open
      const handle = await fs.open(absolute, 'wx', file.executable ? 0o755 : 0o644);
      // Record ownership immediately after open (not after an awaited write) so
      // a write/sync failure still cleans up the exact `wx`-owned inode below.
      const opened = await handle.stat();
      const owned: WrittenFile = { value: absolute, identity: { dev: opened.dev, ino: opened.ino } };
      written.push(owned);
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
        // Capture the exact state actually written so rollback never mistakes a
        // later same-inode external edit for our own partial file.
        owned.stat = await handle.stat();
        await verifyCanonicalChain(records); // chain still identical after write
      } finally { await handle.close(); }
    }
    return { rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}

/** Execute an import: read ONLY the requested skill by fixed root id + id,
 * revalidate the source hash, alias-check and exclusively write the bounded
 * tree (rollback on any error including a manifest write failure), then
 * register in the strict manifest under the shared profile write lock --
 * preserving every existing profile and skill. */
export async function skillApply(workspace: string, rootId: SkillRootId, id: string, sourceHash: string): Promise<SkillImportResult> {
  const root = await fs.realpath(workspace);
  const def = ROOT_DEFS.find(item => item.rootId === rootId);
  if (!def) throw invalid('Unknown skill source root.');
  if (!validSkillId(id)) throw invalid('Invalid skill id.');
  const base = await rootBase(def, root);
  if (!base) throw invalid('That skill source is not configured.');
  const skillRoot = await safeResolve(base.base, base.relative);
  const scan = skillRoot ? await scanRoot(def, skillRoot, root, new Set(), id) : { candidates: [] };
  const candidate = scan.candidates.find(item => item.id === id);
  if (!candidate) throw invalid('That skill is no longer present in the selected source. Refresh discovery.');
  if (candidate.sourceHash !== sourceHash) throw conflict('The skill source changed since you reviewed it. Refresh discovery and confirm again.');

  return withProfileWriteLock(root, async () => {
    const { before, manifest } = await readStrictManifest(root);
    if (manifest.skills.length >= PROFILE_LIMITS.skills) throw conflict(`This project already has ${PROFILE_LIMITS.skills} skills. Remove one before importing another.`);
    if (manifest.skills.some(skill => skill.id === id)) throw conflict('This skill is already imported into the project.');
    const dest = await destinationConflict(root, id);
    if (dest.conflict) throw conflict(dest.reason);
    // Write the tree BEFORE touching the manifest so a failed manifest write can
    // be rolled back without losing the fresh, exclusively-owned directory.
    const tree = await writeSkillTree(root, id, candidate.files);
    try {
      manifest.skills.push({ id: candidate.id, name: candidate.name, description: candidate.description });
      const next = validateStrictManifest(manifest);
      const catalogRevision = await writeStrictManifest(root, next, before);
      return {
        id: candidate.id, name: candidate.name, description: candidate.description,
        fileCount: candidate.files.length, catalogRevision, warnings: [],
      };
    } catch (error) {
      await tree.rollback();
      throw error;
    }
  });
}
