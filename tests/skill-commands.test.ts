import { describe, expect, it } from 'vitest';
import { addSkill, checkSkillSource, skillCommand, skillCommands } from '../shared/skill-commands';
const skills = ['verify', 'models', 'review'].map(id => ({ id, name: id, description: '' }));
const catalog = { revision: 'new', profiles: [], skills, diagnostics: [] };
describe('skill slash commands', () => {
  it('reserves builtins and templates, accepts only exact ids, and leaves unknown text alone', () => {
    expect(skillCommands(skills, ['models', 'review', 'skill']).map(item => item.name)).toEqual(['verify']);
    expect(skillCommand(' /verify ', skills, [])).toBe('verify');
    for (const text of ['/models', '/review', '/skill', '/verify task', '/unknown', '/Verify']) expect(skillCommand(text, skills, ['models', 'review', 'skill'])).toBeUndefined();
  });
  it('adds without changing the profile or mutating selection and rejects unavailable/capped skills', () => {
    const choice = { profileId: 'review', skillIds: ['models'] };
    expect(addSkill(choice, 'verify', catalog)).toEqual({ profileId: 'review', skillIds: ['models', 'verify'], catalogRevision: 'new' });
    expect(choice.skillIds).toEqual(['models']);
    expect(addSkill(choice, 'models', catalog).skillIds).toEqual(['models']);
    expect(() => addSkill(null, 'missing', catalog)).toThrow('unavailable');
    expect(() => addSkill({ profileId: null, skillIds: Array.from({ length: 8 }, (_, i) => `s${i}`) }, 'verify', catalog)).toThrow('8');
    expect(() => checkSkillSource({ profileId: 'review', skillIds: [], tools: [], revision: 'old' }, 'new')).toThrow('changed');
    expect(() => checkSkillSource(null, 'new')).not.toThrow();
  });
});
