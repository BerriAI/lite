import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from './fixtures';
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

test('unchecked changes show one concise verification notice with expandable details', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  await send(page, session, 'RECEIPTS_BROWSER please write the demo file');
  const result = await done(request, session);
  const final = result.messages.at(-1)!;
  expect(final.content).toContain('Changes haven’t been checked: No verification commands were recorded after these changes.');
  expect(final.receipts?.filesChanged).toEqual(['receipts-demo.txt']);
  await expect(page.locator('.receipts-row summary')).toHaveText('Changes haven’t been checked');
  await expect(page.locator('.assistant-message .markdown')).not.toContainText('Changes haven’t been checked');
  await expect(page.getByText('Files changed: receipts-demo.txt', { exact: true })).not.toBeVisible();
  await page.locator('.receipts-row summary').click();
  await expect(page.getByText('Files changed: receipts-demo.txt', { exact: true })).toBeVisible();
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

test('historical failed command dumps become a single expandable verification notice', async ({ page, request }) => {
  const session = await create(request);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { content: 'Reply with hello' } });
  await done(request, session);
  const commands = ['npx vitest run | tail -18', 'npm test', "python3 - <<'PY'\nprint('historical edit script')\nPY\nnpm run typecheck"];
  await page.route(`**/api/sessions/${session.id}`, async route => {
    const response = await route.fetch(), data = await response.json();
    const final = data.messages.findLast((message: { role: string }) => message.role === 'assistant');
    final.content = `The change is ready.\n\n[Receipts: 3 check(s) still failing: ${commands.join(', ')}.]`;
    final.receipts = { filesChanged: [], commandsRun: commands, checksRun: commands, checksFailed: commands, unresolvedChecks: commands, filesChangedAfterLastCheck: [], unreadFilesChanged: [] };
    await route.fulfill({ response, json: data });
  });
  await open(page, session);
  await expect(page.locator('.assistant-message .message-body > .markdown')).toHaveText('The change is ready.');
  const row = page.locator('.receipts-row');
  await expect(row.locator('summary')).toHaveText('Verification needs review');
  await expect(row.locator('pre').last()).not.toBeVisible();
  await row.locator('summary').click();
  await expect(row).toContainText('3 earlier verification attempts failed or timed out without a recorded successful rerun.');
  await expect(row.locator('pre').last()).toBeVisible();
  await expect(row.locator('pre').last()).toHaveText(commands[2]);
  await page.screenshot({ path: 'test-results/verification-details.png', fullPage: true });
});
