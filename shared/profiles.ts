/** Profiles only restrict built-in tools. They never authorize tools or MCP. */
export type ProfileTool = 'read_file' | 'write_file' | 'edit_file' | 'glob' | 'grep' | 'bash' | 'web_fetch' | 'todo_read' | 'todo_write';
export interface ProfileChoice { profileId: string | null; skillIds: string[]; catalogRevision?: string }
export interface ActiveProfile { profileId: string | null; name?: string; skillIds: string[]; revision: string; tools: ProfileTool[] | null }
export interface ProjectProfile {
  id: string; name: string; description?: string; tools: ProfileTool[];
  defaultModel?: { providerId: string; model: string }; defaultMode?: 'plan' | 'build';
  /** Recommendations only. Never automatically selected. */
  skills?: string[];
}
export interface ProjectSkill { id: string; name: string; description: string }
export interface ProfileDiagnostic { path: string; code: string; message: string }
export interface ProfileCatalog { workspace?: string; revision: string; profiles: ProjectProfile[]; skills: ProjectSkill[]; diagnostics: ProfileDiagnostic[] }
export interface ApplyProfileRequest { expectedConfigRevision: number; choice: ProfileChoice; selection?: { providerId?: string; model?: string; mode?: 'plan' | 'build' } }
export interface ProfileSource { path: string; hash: string }
export interface PinnedSkill extends ProjectSkill { body: string; path: string; hash: string }
export interface ProfileDetail {
  active: ActiveProfile | null;
  pinned: { instructions: string; skills: PinnedSkill[]; sources: ProfileSource[] } | null;
  source: { status: 'current' | 'changed' | 'missing' | 'invalid' | 'inactive' };
  diagnostics: ProfileDiagnostic[];
}
