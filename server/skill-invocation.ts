import { z } from 'zod';
import type { SkillInvocation } from '../shared/skill-commands.js';
import type { Attachment } from '../shared/types.js';
import { resolveProfileChoice } from './profiles.js';

export const skillInvocationSchema = z.object({
  skillIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).min(1).max(8).refine(ids => new Set(ids).size === ids.length),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Use the existing bounded source reader, without changing session configuration. */
export async function snapshotSkillInvocation(workspace: string, invocation?: SkillInvocation): Promise<Attachment[]> {
  if (!invocation) return [];
  const { snapshot } = await resolveProfileChoice(workspace, { profileId: null, ...invocation });
  return snapshot!.skills.map(skill => ({
    name: `Skill: ${skill.id}`, skillId: skill.id, mimeType: 'text/markdown',
    content: `The user explicitly invoked the ${skill.id} skill for this request. Follow these instructions. Resolve relative paths against ${skill.path.slice(0, -'/SKILL.md'.length)} in the workspace.\n\n${skill.body}`,
  }));
}
