import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail, Settings } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Litespeed', exact: true });
const permission = (page: Page) => page.getByRole('region', { name: 'Permission requested', exact: true });
let workspace: string, sessions: Session[], browserErrors: string[], baseline: Settings;

test.beforeEach(async ({ page, request }) => {
  browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-permissions-browser-'))); sessions = [];
  await writeFile(join(workspace, 'notes.txt'), 'Rule fixture file.\n');
  baseline = await (await request.get('/api/settings')).json();
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/);
  }
  expect((await request.patch('/api/settings', { data: { permissionRules: baseline.permissionRules ?? { version: 1, rules: [] } } })).ok()).toBe(true);
  await rm(workspace, { recursive: true, force: true });
  expect(browserErrors).toEqual([]);
});
async function create(request: APIRequestContext, options: Record<string, unknown> = {}) {
  const response = await request.post('/api/sessions', { data: { title: 'Rules workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask', ...options } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function detail(request: APIRequestContext, session: Session): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${session.id}`); expect(response.ok()).toBe(true); return response.json();
}
async function done(request: APIRequestContext, session: Session) {
  await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/); return detail(request, session);
}
async function open(page: Page, session: Session) { await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible(); }
async function send(page: Page, session: Session, text: string) {
  await composer(page).fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await accepted).status()).toBe(202);
}
const rules = (request: APIRequestContext, rules: unknown[]) => request.patch('/api/settings', { data: { permissionRules: { version: 1, rules } } });
const toolResults = (result: SessionDetail) => result.messages.filter(message => message.role === 'tool').map(message => message.content);

test('an allow rule runs a matching command without any prompt in ask mode', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'bash', decision: 'allow', patterns: ['echo *'] }])).ok()).toBe(true);
  const session = await create(request); await open(page, session);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[echo rule-allowed]');
  const result = await done(request, session);
  expect(await permission(page).count()).toBe(0);
  expect(toolResults(result).join('\n')).toContain('rule-allowed');
  expect(result.messages.at(-1)?.content).toContain('Rules outcome');
});

test('a deny rule blocks even automatic approval, with an honest result and no prompt', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'write_file', decision: 'deny', patterns: ['**/*.secret'] }])).ok()).toBe(true);
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session);
  await send(page, session, 'RULES_BROWSER WRITE_PATH[config/api.secret]');
  const result = await done(request, session);
  expect(await permission(page).count()).toBe(0);
  expect(toolResults(result).join('\n')).toMatch(/denied by an explicit app permission rule for "write_file" \(pattern "\*\*\/\*\.secret"\)/i);
  await expect(readFile(join(workspace, 'config/api.secret'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an ask rule forces a prompt in automatic mode and deny stays final after reload', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'bash', decision: 'ask', patterns: ['git push**'] }])).ok()).toBe(true);
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[git push origin main]');
  await expect(permission(page)).toBeVisible();
  await page.reload(); await expect(permission(page)).toBeVisible();
  await permission(page).getByRole('button', { name: 'Deny', exact: true }).click();
  const result = await done(request, session);
  expect(toolResults(result).join('\n')).toMatch(/denied/i);
});

test('a command with shell control operators is not auto-allowed by a wildcard rule', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'bash', decision: 'allow', patterns: ['echo **'] }])).ok()).toBe(true);
  const session = await create(request); await open(page, session);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[echo safe && touch rule-escape.txt]');
  await expect(permission(page)).toBeVisible();
  await permission(page).getByRole('button', { name: 'Deny', exact: true }).click();
  await done(request, session);
  await expect(readFile(join(workspace, 'rule-escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('project rules from .litespeed/permissions.json outrank app rules and deny without prompting', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'bash', decision: 'allow', patterns: ['touch *'] }])).ok()).toBe(true);
  await mkdir(join(workspace, '.litespeed'), { recursive: true });
  await writeFile(join(workspace, '.litespeed', 'permissions.json'), JSON.stringify({ version: 1, rules: [{ tool: 'bash', decision: 'deny', patterns: ['touch **'] }] }));
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[touch project-denied.txt]');
  const result = await done(request, session);
  expect(await permission(page).count()).toBe(0);
  expect(toolResults(result).join('\n')).toMatch(/denied by an explicit project permission rule for "bash" \(pattern "touch \*\*"\)/i);
  await expect(readFile(join(workspace, 'project-denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rules are captured at acceptance: later edits do not change a pending approval', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'bash', decision: 'ask', patterns: ['echo **'] }])).ok()).toBe(true);
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[echo captured-rule]');
  await expect(permission(page)).toBeVisible();
  expect((await rules(request, [{ tool: 'bash', decision: 'deny', patterns: ['echo **'] }])).ok()).toBe(true);
  await permission(page).getByRole('button', { name: 'Allow once', exact: true }).click();
  const result = await done(request, session);
  expect(toolResults(result).join('\n')).toContain('captured-rule');
});

test('a pattern-free deny removes the tool from the advertised list for the turn', async ({ page, request }) => {
  expect((await rules(request, [{ tool: 'bash', decision: 'deny' }])).ok()).toBe(true);
  const session = await create(request); await open(page, session);
  await send(page, session, 'RULES_BROWSER RULES_ADVERTISE');
  const result = await done(request, session);
  const advertised = result.messages.at(-1)?.content ?? '';
  expect(advertised).toContain('Advertised tools:');
  expect(advertised).not.toMatch(/\bbash\b/);
  expect(advertised).toContain('write_file');
});

test('an invalid project rules file is ignored with a visible notice and the turn still runs', async ({ page, request }) => {
  await mkdir(join(workspace, '.litespeed'), { recursive: true });
  await writeFile(join(workspace, '.litespeed', 'permissions.json'), '{ not valid json');
  const session = await create(request); await open(page, session);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[echo invalid-rules-still-runs]');
  await expect(permission(page)).toBeVisible();
  await expect(permission(page)).toContainText(/project permission rules/i);
  await permission(page).getByRole('button', { name: 'Allow once', exact: true }).click();
  const result = await done(request, session);
  expect(toolResults(result).join('\n')).toContain('invalid-rules-still-runs');
});

test('the settings editor saves rules that then govern a real run', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Permissions', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add rule' }).first().click();
  await dialog.getByLabel('Rule 1 tool', { exact: true }).selectOption('bash');
  await dialog.getByLabel('Rule 1 decision', { exact: true }).selectOption('allow');
  await dialog.getByLabel('Rule 1 patterns', { exact: true }).fill('echo *');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => {
    const settings: Settings = await (await request.get('/api/settings')).json();
    return settings.permissionRules?.rules?.length ?? 0;
  }).toBeGreaterThan(0);
  await send(page, session, 'RULES_BROWSER RUN_COMMAND[echo saved-from-editor]');
  const result = await done(request, session);
  expect(await permission(page).count()).toBe(0);
  expect(toolResults(result).join('\n')).toContain('saved-from-editor');
});


test('an external read in Plan mode shows the resolved path and completes after approval', async ({page,request}) => {
  expect((await rules(request, [])).ok()).toBe(true);
  const project=join(workspace,'project'); await mkdir(project);
  const session=await create(request,{workspace:project,mode:'plan'});await open(page,session);
  await send(page,session,'RULES_BROWSER READ_PATH[../notes.txt]');
  await expect(permission(page)).toContainText('Read outside this session’s workspace');
  await expect(permission(page)).toContainText(join(workspace,'notes.txt'));
  await expect(permission(page).getByRole('button',{name:'Allow at this path',exact:true})).toBeVisible();
  await page.reload();await expect(permission(page)).toBeVisible();
  await permission(page).getByRole('button',{name:'Allow once',exact:true}).click();
  const result=await done(request,session);expect(toolResults(result).join('\n')).toContain('Rule fixture file.');
  await expect(permission(page)).toHaveCount(0);
});
