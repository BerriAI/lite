import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail, Settings } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Lite', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
let workspace: string, settings: Settings, sessions: Session[];
const manifest = () => ({ version: 1, profiles: [
  { id: 'inspector', name: 'Careful inspector', description: 'Inspect code without edits.', instructions: 'PROFILE_INSPECTOR_PINNED: Inspect actual files and report only verified facts.', tools: ['read_file', 'glob', 'grep', 'todo_read'], defaultModel: { providerId: 'fixture', model: 'test-fast' }, defaultMode: 'plan', skills: ['review'] },
  { id: 'builder', name: 'Focused builder', description: 'Implement small tested changes.', instructions: 'PROFILE_BUILDER_PINNED: Make a small complete change.', tools: ['read_file', 'write_file', 'edit_file', 'bash', 'todo_read', 'todo_write'], defaultModel: { providerId: 'fixture', model: 'test-fast' }, defaultMode: 'build' },
], skills: [{ id: 'review', name: 'Review checklist', description: 'A deliberate verification checklist.' }] });
test.beforeEach(async ({ request }) => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-profile-browser-'))); sessions = [];
  await mkdir(join(workspace, '.lite', 'skills', 'review'), { recursive: true });
  await writeFile(join(workspace, '.lite', 'profiles.json'), JSON.stringify(manifest()));
  await writeFile(join(workspace, '.lite', 'skills', 'review', 'SKILL.md'), 'SKILL_REVIEW_PINNED: Verify edge cases and do not invent test results.');
  await writeFile(join(workspace, 'README.md'), '# Profile fixture\n');
  settings = await (await request.get('/api/settings')).json();
  expect((await request.patch('/api/settings', { data: { workspace } })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session.id)).session.status).not.toMatch(/running|waiting/);
  }
  expect((await request.patch('/api/settings', { data: { workspace: settings.workspace } })).ok()).toBe(true);
  await rm(workspace, { recursive: true, force: true });
});
async function detail(request: APIRequestContext, id: string): Promise<SessionDetail> { const response = await request.get(`/api/sessions/${id}`); expect(response.ok()).toBe(true); return response.json(); }
async function catalog(request: APIRequestContext) { const response = await request.get('/api/profiles', { params: { workspace } }); expect(response.ok()).toBe(true); return response.json(); }
async function create(request: APIRequestContext, input: Record<string, unknown> = {}) {
  const response = await request.post('/api/sessions', { data: { title: 'Project profile workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask', ...input } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function open(page: Page, session: Session) { await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible(); await expect(page.getByText('Connecting to live updates…', { exact: true })).toHaveCount(0); }
async function picker(page: Page) { if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Project profiles', exact: true }).click(); await expect(dialog(page)).toBeVisible(); await expect(dialog(page).getByLabel('Profile', { exact: true })).toBeVisible(); return dialog(page); }
async function choose(page: Page, name = 'Careful inspector', skill = false) { const panel = await picker(page); await panel.getByLabel('Profile', { exact: true }).selectOption({ label: name }); if (skill) await panel.getByRole('checkbox', { name: 'Review checklist', exact: true }).check(); return panel; }
async function use(page: Page, name = 'Careful inspector', skill = false) { const panel = await choose(page, name, skill); await panel.getByRole('button', { name: 'Use profile', exact: true }).click(); await expect(panel).toHaveCount(0); }
async function send(page: Page, request: APIRequestContext, session: Session, prompt: string) {
  await composer(page).fill(prompt); const acceptance = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await acceptance).status()).toBe(202);
  await expect.poll(async () => (await detail(request, session.id)).session.status).not.toMatch(/running|waiting/);
  return detail(request, session.id);
}
async function profileCalls(request: APIRequestContext, prompt: string): Promise<{ model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }[]> {
  return (await (await request.get('/fixture/profiles')).json()).requests.filter((value: { messages: { content: unknown }[] }) => value.messages.some(message => message.content === prompt));
}
const systemText = (call: { messages: { role: string; content: unknown }[] }) => call.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');

test('project files do not activate a profile or recommended skill without explicit selection', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  expect((await detail(request, session.id)).session.profile).toBeUndefined();
  const panel = await choose(page); await expect(panel.getByRole('checkbox', { name: 'Review checklist', exact: true })).not.toBeChecked();
  await expect(panel).toContainText('Careful inspector'); await expect(panel).toContainText('test-fast');
  await panel.getByRole('button', { name: 'Use profile', exact: true }).click(); await expect(panel).toHaveCount(0);
  const saved = (await detail(request, session.id)).session;
  expect(saved.profile).toMatchObject({ profileId: 'inspector', skillIds: [] });
  expect(saved).toMatchObject({ mode: 'build', model: 'test-model', permissionMode: 'ask' });
  const prompt = 'PROFILE_BROWSER explicit profile with no skill'; await send(page, request, session, prompt);
  const calls = await profileCalls(request, prompt); expect(calls).toHaveLength(1);
  expect(systemText(calls[0])).toContain('PROFILE_INSPECTOR_PINNED'); expect(systemText(calls[0])).not.toContain('SKILL_REVIEW_PINNED');
});

test('explicit instruction skills reach the provider, survive reload, and preserve composer drafts', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await composer(page).fill('Do not lose my draft.');
  await use(page, 'Careful inspector', true); await expect(composer(page)).toHaveValue('Do not lose my draft.');
  const saved = (await detail(request, session.id)).session.profile; expect(saved).toMatchObject({ profileId: 'inspector', skillIds: ['review'] });
  await page.reload(); await expect(composer(page)).toHaveValue('Do not lose my draft.');
  expect((await detail(request, session.id)).session.profile).toEqual(saved);
  const prompt = 'PROFILE_BROWSER explicit instruction skill'; const completed = await send(page, request, session, prompt);
  const [call] = await profileCalls(request, prompt); expect(systemText(call)).toContain('SKILL_REVIEW_PINNED');
  expect(call.tools.map(tool => tool.function.name).sort()).toEqual(['ask_user', 'glob', 'grep', 'read_file', 'todo_read'].sort());
  expect(completed.messages.at(-1)?.context?.estimatedInputTokens).toBeGreaterThan(0);
});

test('applying a profile preserves Plan and permissions until its defaults are separately chosen', async ({ page, request }) => {
  const session = await create(request, { mode: 'plan', permissionMode: 'auto' }); await open(page, session); await use(page, 'Focused builder');
  expect((await detail(request, session.id)).session).toMatchObject({ mode: 'plan', model: 'test-model', permissionMode: 'auto' });
  const panel = await picker(page); await expect(panel).toContainText(/build/i); await expect(panel).toContainText('test-fast');
  await panel.getByRole('button', { name: 'Apply defaults', exact: true }).click(); await expect(panel).toHaveCount(0);
  expect((await detail(request, session.id)).session).toMatchObject({ mode: 'build', model: 'test-fast', providerId: 'fixture', permissionMode: 'auto' });
});

test('excluded tools cannot execute even when the provider emits them in automatic Build mode', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await use(page);
  const prompt = 'PROFILE_BROWSER forbidden write'; const completed = await send(page, request, session, prompt);
  await expect(readFile(join(workspace, 'profile-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const calls = await profileCalls(request, prompt); expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(call => !call.tools.some(tool => tool.function.name === 'write_file'))).toBe(true);
  const tool = completed.messages.flatMap(message => message.toolCalls ?? []).find(call => call.name === 'write_file');
  expect(tool).toBeTruthy(); expect(tool?.status).not.toBe('completed');
  expect(JSON.stringify(completed.messages)).toMatch(/profile|excluded|not allowed/i);
  expect(completed.permissions).toEqual([]);
});

test('edited and deleted source files never silently change the active pinned instructions', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await use(page, 'Careful inspector', true);
  const pinned = (await detail(request, session.id)).session.profile;
  await writeFile(join(workspace, '.lite', 'skills', 'review', 'SKILL.md'), 'SKILL_REVIEW_CHANGED: This is a different instruction.');
  let panel = await picker(page); await expect(panel).toContainText(/changed|reload/i);
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click();
  let prompt = 'PROFILE_BROWSER keep accepted snapshot'; await send(page, request, session, prompt);
  let [call] = await profileCalls(request, prompt); expect(systemText(call)).toContain('SKILL_REVIEW_PINNED'); expect(systemText(call)).not.toContain('SKILL_REVIEW_CHANGED');
  expect((await detail(request, session.id)).session.profile).toEqual(pinned);
  panel = await picker(page); await panel.getByRole('button', { name: 'Reload profile', exact: true }).click(); await expect(panel).toHaveCount(0);
  const reloaded = (await detail(request, session.id)).session.profile; expect(reloaded?.revision).not.toBe(pinned?.revision);
  await rm(join(workspace, '.lite', 'profiles.json'));
  prompt = 'PROFILE_BROWSER keep snapshot after source deletion'; await send(page, request, session, prompt);
  [call] = await profileCalls(request, prompt); expect(systemText(call)).toContain('SKILL_REVIEW_CHANGED');
  expect((await detail(request, session.id)).session.profile).toEqual(reloaded);
  panel = await picker(page); await expect(panel).toContainText(/unavailable|missing|not found/i);
  await panel.getByRole('button', { name: 'Use default', exact: true }).click(); await expect(panel).toHaveCount(0);
  expect((await detail(request, session.id)).session.profile).toBeUndefined();
});

test('profile changes hold queued work and preserve an independent unsent draft', async ({ page, request }) => {
  const session = await create(request); expect((await request.post(`/api/sessions/${session.id}/queue`, { data: { content: 'PROFILE_BROWSER queued with explicit profile' } })).status()).toBe(202);
  await open(page, session); await composer(page).fill('A different unsent thought.'); await use(page, 'Careful inspector', true);
  const state = await detail(request, session.id); expect(state.queue).toMatchObject({ paused: true, items: [{ content: 'PROFILE_BROWSER queued with explicit profile' }] });
  await expect(composer(page)).toHaveValue('A different unsent thought.'); await expect(page.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).queue?.items.length).toBe(0);
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  const [call] = await profileCalls(request, 'PROFILE_BROWSER queued with explicit profile'); expect(systemText(call)).toContain('SKILL_REVIEW_PINNED');
  await expect(composer(page)).toHaveValue('A different unsent thought.');
});

test('a stale profile dialog cannot overwrite a newer selection from another client', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await composer(page).fill('Cross-tab draft remains.');
  const panel = await choose(page); const current = (await detail(request, session.id)).session;
  expect((await request.patch(`/api/sessions/${session.id}`, { data: { model: 'test-fast', expectedConfigRevision: current.configRevision ?? 0 } })).status()).toBe(200);
  await panel.getByRole('button', { name: 'Use profile', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  expect((await detail(request, session.id)).session).toMatchObject({ model: 'test-fast' });
  expect((await detail(request, session.id)).session.profile).toBeUndefined(); await expect(composer(page)).toHaveValue('Cross-tab draft remains.');
});

test('forks retain the pinned configuration without source reads while imports remain unprofiled', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await use(page, 'Careful inspector', true); await send(page, request, session, 'PROFILE_BROWSER seed fork');
  const pinned = (await detail(request, session.id)).session.profile;
  await rm(join(workspace, '.lite', 'profiles.json')); await rm(join(workspace, '.lite', 'skills', 'review', 'SKILL.md'));
  const response = await request.post(`/api/sessions/${session.id}/fork`, { data: {} }); expect(response.status()).toBe(201); const fork: Session = await response.json(); sessions.push(fork);
  expect(fork.profile).toEqual(pinned); await open(page, fork); await send(page, request, fork, 'PROFILE_BROWSER fork without source');
  const [call] = await profileCalls(request, 'PROFILE_BROWSER fork without source'); expect(systemText(call)).toContain('SKILL_REVIEW_PINNED');
  const exported = await (await request.get(`/api/sessions/${session.id}/export`)).json(); expect(JSON.stringify(exported)).not.toContain('SKILL_REVIEW_PINNED');
  const importedResponse = await request.post('/api/sessions/import', { data: exported }); expect(importedResponse.status()).toBe(201); const imported: Session = await importedResponse.json(); sessions.push(imported);
  expect(imported.profile).toBeUndefined(); expect(imported.permissionMode).toBe('ask');
  await open(page, imported); await send(page, request, imported, 'PROFILE_BROWSER imported configuration is inert');
  const [importCall] = await profileCalls(request, 'PROFILE_BROWSER imported configuration is inert'); expect(systemText(importCall)).not.toContain('SKILL_REVIEW_PINNED');
});

test('compaction archives copy the pinned configuration and undo does not reconfigure the session', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await use(page, 'Careful inspector', true);
  await send(page, request, session, 'PROFILE_BROWSER older material for archive');
  const completed = await send(page, request, session, 'PROFILE_BROWSER newer material for archive'); const pinned = completed.session.profile;
  const compacted = await request.post(`/api/sessions/${session.id}/compact`, { data: {} });
  expect(compacted.status(), await compacted.text()).toBe(200);
  const archives: Session[] = (await (await request.get('/api/sessions?archived=true')).json()).sessions;
  const archive = archives.find(value => value.parentId === session.id); expect(archive?.profile).toEqual(pinned);
  const state = await detail(request, session.id); expect((await request.post(`/api/sessions/${session.id}/history/undo`, { data: { checkpointId: state.history?.undoId } })).ok()).toBe(true);
  expect((await detail(request, session.id)).session.profile).toEqual(pinned);
  await page.reload(); await expect(composer(page)).toBeVisible();
});

test('invalid project configuration is visible and cannot replace an active profile', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await use(page); const pinned = (await detail(request, session.id)).session.profile;
  await writeFile(join(workspace, '.lite', 'profiles.json'), '{"version":1,"profiles":[{"id":"bad","name":"Unsafe","tools":["task"]}],"skills":[]}');
  const panel = await picker(page); await expect(panel).toContainText(/invalid|unsupported|not allowed|strict version 1 schema/i);
  expect((await detail(request, session.id)).session.profile).toEqual(pinned); await expect(panel.getByRole('button', { name: 'Use default', exact: true })).toBeEnabled();
});

test('new-session defaults are applied only to explicitly selected profiles and skills remain opt-in', async ({ page, request }) => {
  const choices = await catalog(request); const response = await request.post('/api/sessions', { data: { workspace, title: 'Explicit profile defaults', profile: { profileId: 'inspector', skillIds: [], catalogRevision: choices.revision } } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session);
  expect(session).toMatchObject({ providerId: 'fixture', model: 'test-fast', mode: 'plan', permissionMode: 'ask', profile: { profileId: 'inspector', skillIds: [] } });
  await open(page, session); await expect(composer(page)).toBeVisible(); const panel = await picker(page);
  await expect(panel.getByLabel('Profile', { exact: true })).toHaveValue('inspector'); await expect(panel.getByRole('checkbox', { name: 'Review checklist', exact: true })).not.toBeChecked();
});

test('welcome profile selection is explicit and travels with the first accepted message', async ({ page, request }) => {
  await page.goto('/'); await expect(composer(page)).toBeVisible(); await composer(page).fill('PROFILE_BROWSER welcome activation');
  await use(page, 'Careful inspector', true); await expect(composer(page)).toHaveValue('PROFILE_BROWSER welcome activation');
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); const response = await created; expect(response.status()).toBe(201);
  const session: Session = await response.json(); sessions.push(session);
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect.poll(async () => (await profileCalls(request, 'PROFILE_BROWSER welcome activation')).length).toBe(1);
  expect((await detail(request, session.id)).session.profile).toMatchObject({ profileId: 'inspector', skillIds: ['review'] });
  const [call] = await profileCalls(request, 'PROFILE_BROWSER welcome activation'); expect(systemText(call)).toContain('SKILL_REVIEW_PINNED');
});

test('skills can be selected independently without restricting ordinary tools', async ({ page, request }) => {
  const session = await create(request); await open(page, session); const panel = await picker(page);
  await panel.getByRole('checkbox', { name: 'Review checklist', exact: true }).check();
  await panel.getByRole('button', { name: 'Use profile', exact: true }).click(); await expect(panel).toHaveCount(0);
  expect((await detail(request, session.id)).session.profile).toMatchObject({ profileId: null, skillIds: ['review'], tools: null });
  const prompt = 'PROFILE_BROWSER explicit skills only'; await send(page, request, session, prompt);
  const [call] = await profileCalls(request, prompt); expect(systemText(call)).toContain('SKILL_REVIEW_PINNED');
  expect(call.tools.some(tool => tool.function.name === 'write_file')).toBe(true);
  expect(call.tools.some(tool => tool.function.name === 'bash')).toBe(true);
});

test('an unanswered agent question cannot be bypassed by changing the profile', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await use(page);
  await composer(page).fill('PROFILE_BROWSER ask fixture question'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).questions?.length).toBe(1);
  await expect(page.locator('.composer [aria-label="Project profiles"]')).toHaveCount(0);
  const current = (await detail(request, session.id)).session;
  const rejected = await request.post(`/api/sessions/${session.id}/profile`, { data: { expectedConfigRevision: current.configRevision ?? 0, choice: { profileId: null, skillIds: [] } } });
  expect(rejected.status()).toBe(409); expect((await detail(request, session.id)).session.profile).toEqual(current.profile);
  await composer(page).fill('Preserve draft while the question waits.'); await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect(page.locator('.composer [aria-label="Project profiles"]')).toHaveCount(0);
  await expect(composer(page)).toHaveValue('Preserve draft while the question waits.');
});

test('mobile profile selection fits the viewport and leaves the composer usable', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const session = await create(request); await open(page, session); await composer(page).fill('Mobile draft remains.');
  const panel = await choose(page, 'Careful inspector', true); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/profiles-mobile-dialog.png', fullPage: true, animations: 'disabled' });
  await panel.getByRole('button', { name: 'Use profile', exact: true }).click(); await expect(panel).toHaveCount(0); await expect(composer(page)).toHaveValue('Mobile draft remains.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/profiles-mobile.png', fullPage: true, animations: 'disabled' });
});

test('profiles use the Settings layout and can be created, edited, and deliberately applied', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  const panel = await picker(page);
  await expect(panel.locator('.settings-nav')).toBeVisible();
  await expect(panel).toContainText('Reusable instructions and tool limits');
  await panel.getByRole('button', { name: 'New profile', exact: true }).click();
  await panel.getByLabel('Profile name', { exact: true }).fill('Release reviewer');
  await panel.getByLabel('Profile description', { exact: true }).fill('Review changes before release.');
  await panel.getByLabel('Profile instructions', { exact: true }).fill('PROFILE_RELEASE_PINNED: Check compatibility and document verification.');
  await panel.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(panel.getByLabel('Profile instructions', { exact: true })).toBeHidden();
  await panel.getByRole('button', { name: 'Project profiles', exact: true }).click();
  await expect(panel.getByLabel('Profile instructions', { exact: true })).toHaveValue('PROFILE_RELEASE_PINNED: Check compatibility and document verification.');
  await page.screenshot({ path: '/tmp/lite-profile-editor-desktop.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Profile saved');
  expect((await detail(request, session.id)).session.profile).toBeUndefined();
  const manifestOnDisk = JSON.parse(await readFile(join(workspace, '.lite/profiles.json'), 'utf8'));
  expect(manifestOnDisk.profiles).toHaveLength(3); expect(manifestOnDisk.skills).toHaveLength(1);
  await page.screenshot({ path: '/tmp/lite-profiles-desktop.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await panel.getByLabel('Profile instructions', { exact: true }).fill('PROFILE_RELEASE_EDITED: Check compatibility and verify examples.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/lite-profile-editor-mobile.png', animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByRole('button', { name: 'Save profile', exact: true }).click();
  await panel.getByRole('button', { name: 'Use profile', exact: true }).click();
  const prompt = 'PROFILE_BROWSER use newly edited profile'; await send(page, request, session, prompt);
  expect(systemText((await profileCalls(request, prompt))[0])).toContain('PROFILE_RELEASE_EDITED');
});
