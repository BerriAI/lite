import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Litespeed', exact: true });
let workspace: string, sessions: Session[], browserErrors: string[];

test.beforeEach(async ({ page }) => {
  browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-commands-browser-'))); sessions = [];
  await mkdir(join(workspace, '.litespeed', 'commands'), { recursive: true });
  await writeFile(join(workspace, '.litespeed', 'commands', 'inspect.md'), '# Inspect a target\nInspect $1 carefully. Full request: $ARGUMENTS');
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/);
  }
  await rm(workspace, { recursive: true, force: true });
  expect(browserErrors).toEqual([]);
});
async function create(request: APIRequestContext) {
  const response = await request.post('/api/sessions', { data: { title: 'Command workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask' } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function detail(request: APIRequestContext, session: Session): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${session.id}`); expect(response.ok()).toBe(true); return response.json();
}

test('typing / offers project commands and the accepted command expands with arguments at send', async ({ page, request }) => {
  const session = await create(request);
  await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible();
  await composer(page).pressSequentially('/ins');
  const popover = page.getByRole('listbox');
  await expect(popover).toBeVisible();
  await expect(popover.getByRole('option', { name: /inspect/ })).toBeVisible();
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('/inspect ');
  await composer(page).pressSequentially('notes.txt quickly');
  await expect(page.getByText(/Command: inspect/)).toBeVisible();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await detail(request, session)).messages.length).toBeGreaterThan(0);
  const first = (await detail(request, session)).messages[0];
  expect(first.content).toContain('Inspect notes.txt carefully.');
  expect(first.content).toContain('Full request: notes.txt quickly');
  expect(first.content).not.toContain('$1');
});

test('escape closes the popover and an unknown /path is sent literally', async ({ page, request }) => {
  const session = await create(request);
  await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible();
  await composer(page).pressSequentially('/ins');
  await expect(page.getByRole('listbox')).toBeVisible();
  await composer(page).press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await composer(page).fill('/tmp/nothing hello');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await detail(request, session)).messages.length).toBeGreaterThan(0);
  expect((await detail(request, session)).messages[0].content).toBe('/tmp/nothing hello');
});

test('built-in slash commands complete with Tab and execute locally without a provider turn', async ({page,request}) => {
  const session=await create(request);await page.goto(`/#session/${session.id}`);
  await composer(page).pressSequentially('/mod');
  await expect(page.getByRole('option',{name:/models/})).toBeVisible();
  await composer(page).press('Tab');await expect(composer(page)).toHaveValue('/models ');
  await composer(page).press('Enter');
  const dialog=page.getByRole('dialog',{name:'Choose a model'});await expect(dialog).toBeVisible();
  expect((await detail(request,session)).messages).toHaveLength(0);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await composer(page).fill('/plan');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Agent mode'})).toHaveValue('plan');
  expect((await detail(request,session)).messages).toHaveLength(0);
  await expect(page.getByRole('button',{name:'Litespeed home',exact:true})).toHaveText('');
});
