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

test('goal setup defaults to unlimited and accepts an optional limit above 25', async ({page,request})=>{
  const session=await create(request);await open(page,session);
  const openGoal=async()=>{await page.getByRole('button',{name:'Session actions',exact:true}).click();await page.getByRole('button',{name:'Set session goal',exact:true}).click();};
  await openGoal();
  const dialog=page.getByRole('dialog',{name:'Set session goal'});
  await expect(dialog.getByLabel('Turn limit (optional)')).toHaveValue('');
  await dialog.getByLabel('Goal',{exact:true}).fill('Finish a long task');
  await dialog.getByRole('button',{name:'Set goal',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect((await detail(request,session)).session.goal?.maxTurns).toBeUndefined();
  await expect(page.locator('.goal-banner-turns')).toHaveText('Turn 0');
  await page.getByRole('button',{name:'Clear goal',exact:true}).click();
  await openGoal();await dialog.getByLabel('Goal',{exact:true}).fill('Bounded task');
  await dialog.getByLabel('Turn limit (optional)').fill('100');
  await dialog.getByRole('button',{name:'Set goal',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect((await detail(request,session)).session.goal?.maxTurns).toBe(100);
  await page.reload();await expect(page.locator('.goal-banner-turns')).toHaveText('Turn 0 of 100');
});
async function send(page: Page, session: Session, text: string) {
  await composer(page).fill(text);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await accepted).status()).toBe(202);
}

test('file changes keep evidence without adding a generic check footer', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  await send(page, session, 'RECEIPTS_BROWSER please write the demo file');
  const result = await done(request, session);
  const final = result.messages.at(-1)!;
  expect(final.content).toBe('The write is complete.');
  expect(final.receipts?.filesChanged).toEqual(['receipts-demo.txt']);
  await expect(page.locator('.receipts-row')).toHaveCount(0);
  await expect(page.locator('.assistant-message .markdown')).not.toContainText('Changes haven’t been checked');
  await expect(page.getByText('Files changed: receipts-demo.txt', { exact: true })).not.toBeVisible();
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

test('historical host check footers stay out of the conversation', async ({ page, request }) => {
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
  await expect(page.locator('.receipts-row')).toHaveCount(0);
  await expect(page.locator('.conversation-content')).not.toContainText('check(s) still failing');
  await expect(page.locator('.conversation-content')).not.toContainText('Checks need attention');
});

for(const width of [1280,390])test(`cache hit percentage uses input tokens and survives reload at ${width}px`,async({page,request})=>{
  await page.setViewportSize({width,height:800});
  const session=await create(request);await open(page,session);
  await send(page,session,'CACHE_HIT_BROWSER report usage');await done(request,session);
  for(let reload=0;reload<2;reload++){
    if(reload)await page.reload();
    const usage=page.locator('.usage').last();
    await expect(usage).toContainText('60 tokens');await expect(usage.locator('summary')).toContainText('80% cache hit');
    await usage.locator('summary').click();await expect(usage.locator('.usage-breakdown')).toContainText('80% cache hit');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
