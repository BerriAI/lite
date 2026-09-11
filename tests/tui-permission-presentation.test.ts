import { expect, it } from 'vitest';
import type { PermissionRequest } from '../shared/types.js';
import { permissionPresentation } from '../tui/permissionPresentation.js';

const request = (tool: string, args: Record<string, unknown>, scopePath?: string) => ({ tool, args, scopePath }) as PermissionRequest;
it('shows the exact command, working directory, and requesting actor', () => {
  expect(permissionPresentation(request('bash', {command: 'git status --short\ncat "a b.txt"', cwd: '/project'}), 'Sidekick')).toEqual({title: 'Sidekick wants to run a command', target: 'In /project', body: 'git status --short\ncat "a b.txt"'});
});
it('shows the resolved outside-workspace approval target and unescaped file content', () => {
  expect(permissionPresentation(request('write_file', {path: '../note.txt', content: 'first line\nsecond line'}, '/actual/note.txt'), 'Worker 2')).toEqual({title: 'Worker 2 wants to write a file', target: '/actual/note.txt', body: 'first line\nsecond line'});
});
it('distinguishes replacing one match from replacing every match', () => {
  const args = {path: 'note.txt', old_string: 'old\ntext', new_string: 'new\ntext'};
  expect(permissionPresentation(request('edit_file', args), 'Driver').body).toBe('Replace:\nold\ntext\nWith:\nnew\ntext');
  expect(permissionPresentation(request('edit_file', {...args, replace_all: true}), 'Driver').body).toContain('Replace every match:');
});
it('presents the handoff assignment without serializing its prompt', () => {
  expect(permissionPresentation(request('sidekick', {description: 'Inspect the project', prompt: 'Read the sources.\nReport the findings.'}), 'Driver')).toEqual({title: 'Driver wants to ask Sidekick', target: 'Inspect the project', body: 'Read the sources.\nReport the findings.'});
});
it('renders task state as a checklist', () => {
  const body = permissionPresentation(request('todo_write', {todos: [{id: '1', content: 'Inspect', status: 'completed'}, {id: '2', content: 'Implement', status: 'in_progress'}, {id: '3', content: 'Verify', status: 'pending'}]}), 'Sidekick').body;
  expect(body).toBe('✓ Inspect\n● Implement\n○ Verify');
});
