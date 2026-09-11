import type { ActiveProfile, ProfileCatalog, ProfileChoice, ProjectSkill } from './profiles.js';

/** Built-ins and project templates always own their names. */
export function skillCommands(skills: ProjectSkill[], reserved: string[]) {
  return skills.filter(skill => !reserved.includes(skill.id)).map(skill => ({ name: skill.id, description: `Use skill: ${skill.name}${skill.description ? ` — ${skill.description}` : ''}` }));
}
export function skillCommand(text: string, skills: ProjectSkill[], reserved: string[]): string | undefined {
  const match = text.trim().match(/^\/([a-z0-9][a-z0-9-]{0,63})$/);
  return match && skillCommands(skills, reserved).some(skill => skill.name === match[1]) ? match[1] : undefined;
}
export function addSkill(choice: ProfileChoice | null | undefined, id: string, catalog: ProfileCatalog): ProfileChoice {
  if (!catalog.skills.some(skill => skill.id === id)) throw new Error('Skill unavailable. Open /skills to refresh the catalog.');
  const ids = choice?.skillIds ?? [];
  if (!ids.includes(id) && ids.length >= 8) throw new Error('Choose up to 8 skills. Open /skills to remove one first.');
  return { profileId: choice?.profileId ?? null, skillIds: ids.includes(id) ? [...ids] : [...ids, id], catalogRevision: catalog.revision };
}
/** Direct activation must not silently reload an existing pinned configuration. */
export function checkSkillSource(active: ActiveProfile | null | undefined, revision: string) {
  if (active && active.revision !== revision) throw new Error('Project instructions changed. Open /skills to review and apply the updated snapshot.');
}
