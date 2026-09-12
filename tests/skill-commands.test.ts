import { describe, expect, it } from 'vitest';
import { skillCommand, skillCommands, skillInvocation } from '../shared/skill-commands';
const skills = ['verify', 'models', 'review'].map(id => ({ id, name: id, description: '' }));
const catalog = { revision: 'new', profiles: [], skills, diagnostics: [] };
describe('skill prompt references', () => {
  it('reserves builtins and templates while accepting bare skills and arguments', () => {
    expect(skillCommands(skills, ['models', 'review', 'skill']).map(item => item.name)).toEqual(['verify']);
    for (const text of [' /verify ', '/verify task', '/verify\ncheck tests', '$verify task']) expect(skillCommand(text, skills, [])).toBe('verify');
    for (const text of ['/models', '/review', '/skill', '/unknown', '/Verify', '/verify/path', '/verify-extra', 'mention /verify']) expect(skillCommand(text, skills, ['models', 'review', 'skill'])).toBeUndefined();
    expect(skillCommand('$review task', skills, ['review'])).toBe('review');
  });
  it('captures the visible catalog revision, deduplicates recalled references, and leaves ordinary text alone', () => {
    expect(skillInvocation('/verify first\n/review second\n/verify again', catalog, [])).toEqual({skillIds:['verify','review'],catalogRevision:'new'});
    expect(skillInvocation('ordinary text', catalog, [])).toBeUndefined();
    expect(() => skillInvocation('/verify', null, [])).toThrow('catalog is not loaded');
    expect(skillInvocation('ordinary text', null, [])).toBeUndefined();
    expect(skillInvocation('Example:\n```text\n/verify\n```\n/review the code', catalog, [])).toEqual({skillIds:['review'],catalogRevision:'new'});
  });
});
