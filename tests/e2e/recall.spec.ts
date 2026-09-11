import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail, Settings } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Speedrail', exact: true });
let workspace: string, sessions: Session[], browserErrors: string[], baseline: Settings;

test.beforeEach(async ({ page, request }) => {
  browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-recall-browser-'))); sessions = [];
  await writeFile(join(workspace, 'notes.txt'), 'Recall fixture file.\n');
  baseline = await (await request.get('/api/settings')).json();
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/);
  }
  expect((await request.patch('/api/settings', { data: { memoryEnabled: baseline.memoryEnabled ?? true, permissionRules: baseline.permissionRules ?? {version:1,rules:[]} } })).ok()).toBe(true);
  await rm(workspace, { recursive: true, force: true });
  expect(browserErrors).toEqual([]);
});
async function create(request: APIRequestContext, options: Record<string, unknown> = {}) {
  const response = await request.post('/api/sessions', { data: { title: 'Recall workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask', ...options } });
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
const toolResults = (result: SessionDetail) => result.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n');

test('history search finds text from another session without any approval prompt', async ({ page, request }) => {
  const earlier = await create(request, { title: 'Earlier searched session' });
  await open(page, earlier); await send(page, earlier, 'create fixture DISTINCTIVE_CROSS_SESSION_MARKER for later search');
  await page.getByRole('region', { name: 'Permission requested', exact: true }).getByRole('button', { name: 'Allow once', exact: true }).click();
  await done(request, earlier);
  const searcher = await create(request, { title: 'Searching session' });
  await open(page, searcher); await send(page, searcher, 'SEARCH_BROWSER SEARCH_FOR[DISTINCTIVE_CROSS_SESSION_MARKER]');
  const result = await done(request, searcher);
  expect(await page.getByRole('region', { name: 'Permission requested', exact: true }).count()).toBe(0);
  expect(toolResults(result)).toContain('DISTINCTIVE_CROSS_SESSION_MARKER');
  expect(toolResults(result)).toContain(earlier.id);
  await page.locator('.work-log > summary').click(); await expect(page.getByText('Search history', { exact: true })).toBeVisible();
});

test('an unmatched search reports indexed counts and does not claim absence', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  await send(page, session, 'SEARCH_BROWSER SEARCH_FOR[nonexistent-marker-zzqx]');
  const result = await done(request, session);
  expect(toolResults(result)).toMatch(/does not prove|not proof/i);
  expect(toolResults(result)).toMatch(/indexed/i);
});

test('memory tools honor an explicit opt-out and can be enabled again', async ({ page, request }) => {
  expect((await request.patch('/api/settings', { data: { memoryEnabled: false } })).ok()).toBe(true);
  const before = await create(request); await open(page, before);
  await send(page, before, 'MEMORY_BROWSER MEMORY_ADVERTISE');
  const withoutMemory = (await done(request, before)).messages.at(-1)?.content ?? '';
  expect(withoutMemory).toContain('history_search');
  expect(withoutMemory).not.toContain('memory_remember');
  expect((await request.patch('/api/settings', { data: { memoryEnabled: true } })).ok()).toBe(true);
  const after = await create(request); await open(page, after);
  await send(page, after, 'MEMORY_BROWSER MEMORY_ADVERTISE');
  const withMemory = (await done(request, after)).messages.at(-1)?.content ?? '';
  for (const tool of ['memory_remember', 'memory_forget', 'memory_recall']) expect(withMemory).toContain(tool);
});

test('an explicit memory ask rule prompts, the fact persists, recall finds it, and settings can delete it', async ({ page, request }) => {
  expect((await request.patch('/api/settings', { data: { memoryEnabled: true } })).ok()).toBe(true);
  const session = await create(request); await open(page, session);
  expect((await request.patch('/api/settings', { data: { permissionRules: {version:1,rules:[{tool:'memory_remember',decision:'ask'}]} } })).ok()).toBe(true);
  await send(page, session, 'MEMORY_BROWSER REMEMBER[This project prefers tabs over spaces.]');
  const approval = page.getByRole('region', { name: 'Permission requested', exact: true });
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
  await done(request, session);
  const listed = await (await request.get(`/api/memory?workspace=${encodeURIComponent(workspace)}`)).json();
  expect(listed.facts.map((fact: { name: string }) => fact.name)).toContain('browser-fact');
  const recaller = await create(request, { permissionMode: 'auto' }); await open(page, recaller);
  await send(page, recaller, 'MEMORY_BROWSER RECALL[tabs spaces]');
  const recalled = await done(request, recaller);
  expect(toolResults(recalled)).toContain('tabs over spaces');
  expect((await request.delete(`/api/memory/browser-fact?workspace=${encodeURIComponent(workspace)}`)).ok()).toBe(true);
  const after = await (await request.get(`/api/memory?workspace=${encodeURIComponent(workspace)}`)).json();
  expect(after.facts).toEqual([]);
});

test('the memory settings toggle and fact browser manage facts end to end', async ({ page, request }) => {
  expect((await request.patch('/api/settings', { data: { memoryEnabled: true } })).ok()).toBe(true);
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session);
  await send(page, session, 'MEMORY_BROWSER REMEMBER[Deploys happen from the main branch only.]');
  await done(request, session);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // The fact browser lives on the Workspace tab and lists facts for the
  // workspace typed in the form ("the workspace above"), so open that tab and
  // point it at this test's temp workspace first.
  await dialog.getByRole('button', { name: 'Workspace', exact: true }).click();
  await dialog.getByLabel('Workspace path').fill(workspace);
  await expect(dialog.getByText('browser-fact')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete fact browser-fact', exact: true }).click();
  await expect(dialog.getByText('browser-fact')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
