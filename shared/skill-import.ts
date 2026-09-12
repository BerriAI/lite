/** Skill import: copy a Claude/Codex skill directory (a folder with a
 * SKILL.md and any bounded support files it needs) into the project under
 * `.litespeed/skills/<id>/` and register it in the existing strict manifest.
 * This is an explicit, opt-in copy -- it never mutates the source tree and it
 * never auto-activates anything. Selection binds to a source hash that is
 * revalidated before apply so a plan cannot silently land on changed content.
 */

export type SkillSourceKind = 'claude' | 'codex';
export type SkillScope = 'home' | 'project';

/** Fixed, server-resolved source root identifiers. Clients reference these --
// never arbitrary paths -- so a request can only address a known source root.
 */
export type SkillRootId =
  | 'claude:home' | 'claude:project'
  | 'codex:home' | 'codex:agents-home'
  | 'codex:project' | 'codex:legacy-project';

/** One root's discovery summary returned from /api/skills/discover. */
export interface SkillRootSummary { rootId: SkillRootId; rootName: string; count: number }

/** One discovered, importable skill directory. */
export interface SkillCandidate {
  source: SkillSourceKind;
  scope: SkillScope;
  /** Fixed root identifier this skill came from. */
  rootId: SkillRootId;
  /** Stable root name for display, e.g. `~/.claude/skills`. */
  rootName: string;
  /** Absolute server-derived root path (never a client-supplied path). */
  root: string;
  /** Validated slug directory name; also the destination skill id. */
  id: string;
  name: string;
  description: string;
  fileCount: number;
  totalBytes: number;
  /** Tree hash binding this discovery to preview/apply. */
  sourceHash: string;
  /** True when the destination `.litespeed/skills/<id>` already exists. */
  conflict: boolean;
  conflictReason: string;
}

/** A single file planned to land in the destination skill folder. */
export interface SkillImportFile {
  /** Workspace-relative destination path, e.g. `.litespeed/skills/<id>/SKILL.md`. */
  path: string;
  bytes: number;
  /** True when the source file has any executable bit set (preserved, never run). */
  executable: boolean;
}

export interface SkillImportPlan {
  candidate: SkillCandidate;
  files: SkillImportFile[];
  /** Destination `.litespeed/skills/<id>` already exists or is registered. */
  conflict: boolean;
  conflictReason: string;
  warnings: string[];
  sourceHash: string;
  destinationRoot: string;
}

export interface SkillImportResult {
  id: string;
  name: string;
  description: string;
  fileCount: number;
  catalogRevision: string;
  warnings: string[];
}

export const SKILL_IMPORT_LIMITS = {
  roots: 8,             // Fixed home/project roots scanned per source+scope.
  candidates: 200,      // Max skill directories listed per discovery call.
  listingEntries: 500,  // Max entries enumerated per root (valid or invalid).
  files: 256,           // Max files (SKILL.md + support) in one skill folder.
  depth: 8,             // Max directory depth inside a skill folder.
  skillBytes: 32 * 1024,      // SKILL.md mirrors PROFILE_LIMITS.skillBytes.
  supportFileBytes: 1024 * 1024, // Per support file bound.
  totalBytes: 8 * 1024 * 1024,   // Whole-folder bound.
  nameLength: 200,
  descriptionLength: 2000,
} as const;
