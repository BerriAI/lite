import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Litespeed', exact: true });
let workspace: string, sessions: Session[], browserErrors: string[];

test.beforeEach(async ({ page }) => {
  browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-autonomy-browser-'))); sessions = [];
  await writeFile(join(workspace, 'notes.txt'), 'Autonomy fixture.\n');
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/);
  }
  await rm(workspace, { recursive: true, force: true });
  expect(browserErrors).toEqual([]);
});
async function create(request: APIRequestContext, options: Record<string, unknown> = {}) {
  const response = await request.post('/api/sessions', { data: { title: 'Autonomy workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'auto', ...options } });
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

test('a mutation turn with no checks shows the receipts row and appended notice', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  await send(page, session, 'RECEIPTS_BROWSER please write the demo file');
  const result = await done(request, session);
  const final = result.messages.at(-1)!;
  expect(final.content).toContain('[Receipts: 1 file(s) changed, no checks were run.]');
  expect(final.receipts?.filesChanged).toEqual(['receipts-demo.txt']);
  await expect(page.locator('.receipts-row')).toContainText('receipts-demo.txt');
  await expect(page.locator('.receipts-row')).toContainText(/No checks run/i);
});

test('a session goal continues turns automatically and completes with a banner', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  expect((await request.post(`/api/sessions/${session.id}/goal`, { data: { text: 'GOAL_BROWSER demonstrate goal turns', maxTurns: 3 } })).ok()).toBe(true);
  await send(page, session, 'GOAL_BROWSER start working');
  await expect(page.locator('.goal-banner')).toBeVisible();
  await expect(page.locator('.goal-banner')).toContainText(/GOAL_BROWSER demonstrate/);
  // The fixture reports 'continue', so the host starts turn 2 without user input.
  await expect.poll(async () => (await detail(request, session)).messages.filter(m => m.role === 'user').length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  const hostTurn = (await detail(request, session)).messages.filter(m => m.role === 'user')[1];
  expect(hostTurn.content).toContain('Continue working toward the session goal.');
  await done(request, session);
});

test('a blocked goal stops continuing and the banner can be cleared', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  expect((await request.post(`/api/sessions/${session.id}/goal`, { data: { text: 'GOAL_BROWSER blocked path', maxTurns: 5 } })).ok()).toBe(true);
  await send(page, session, 'GOAL_BROWSER FORCE_BLOCKED start');
  const result = await done(request, session);
  expect(result.session.goal?.status).toBe('blocked');
  expect(result.messages.filter(m => m.role === 'user')).toHaveLength(1);
  await expect(page.locator('.goal-banner')).toContainText(/blocked/i);
  await page.locator('.goal-banner').getByRole('button', { name: /Clear goal/ }).click();
  await expect(page.locator('.goal-banner')).toHaveCount(0);
});
