import type { ProfileCatalog, ProjectSkill } from './profiles.js';

export interface SkillInvocation { skillIds: string[]; catalogRevision: string }

/** Built-ins and project templates always own their slash names. */
export function skillCommands(skills: ProjectSkill[], reserved: string[]) {
  return skills.filter(skill => !reserved.includes(skill.id)).map(skill => ({ name: skill.id, description: `Use skill: ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`, skill: true }));
}

/** A leading skill reference stays in the user's message; its arguments are unchanged. */
export function skillCommand(text: string, skills: ProjectSkill[], reserved: string[]): string | undefined {
  const match = text.trimStart().match(/^([/$])([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/);
  return match && (match[1] === '$' || !reserved.includes(match[2])) && skills.some(skill => skill.id === match[2]) ? match[2] : undefined;
}

export function skillInvocation(text: string, catalog: ProfileCatalog | null, reserved: string[]): SkillInvocation | undefined {
  const skillIds = new Set<string>();
  let fence = '';
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''; continue; }
    if (marker) { fence = marker[1]; continue; }
    const reference = line.trimStart().match(/^([/$])([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/);
    if (!catalog && reference && (reference[1] === '$' || !reserved.includes(reference[2]))) throw new Error('Skill catalog is not loaded. Open /skills to refresh before sending a skill reference.');
    const id = skillCommand(line, catalog?.skills ?? [], reserved);
    if (id) skillIds.add(id);
  }
  return skillIds.size && catalog ? { skillIds: [...skillIds], catalogRevision: catalog.revision } : undefined;
}
