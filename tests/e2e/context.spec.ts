import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Provider, Session, SessionDetail, Settings } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Lite', exact: true });
const indicator = (page: Page) => page.getByLabel('Context estimate', { exact: true }).last();
let workspace: string, settings: Settings, provider: Provider, sessions: Session[];
test.beforeEach(async ({ request }) => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-context-browser-'))); sessions = [];
  settings = await (await request.get('/api/settings')).json();
  provider = { id: `budget-${randomUUID().slice(0, 8)}`, name: 'Context test gateway', kind: 'openai', baseUrl: settings.providers.find(item => item.id === 'fixture')!.baseUrl };
  expect((await request.patch('/api/settings', { data: { providers: [...settings.providers, provider] } })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session.id)).session.status).not.toMatch(/running|waiting/);
  }
  expect((await request.patch('/api/settings', { data: { providers: settings.providers } })).ok()).toBe(true);
  await rm(workspace, { recursive: true, force: true });
});
async function detail(request: APIRequestContext, id: string): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${id}`); expect(response.ok()).toBe(true); return response.json();
}
async function calls(request: APIRequestContext) { return (await (await request.get('/fixture/requests')).json()).count as number; }
async function discover(request: APIRequestContext) {
  const response = await request.get(`/api/models?providerId=${provider.id}`); expect(response.ok()).toBe(true);
  expect((await response.json()).models.find((model: { id: string }) => model.id === 'budget-model').contextWindow).toBe(16384);
}
async function create(request: APIRequestContext, model = 'budget-model') {
  const response = await request.post('/api/sessions', { data: { title: 'Advisory context test', workspace, providerId: provider.id, model, mode: 'plan', permissionMode: 'ask' } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function imported(request: APIRequestContext, marker = 'OLDER_CONTEXT_MARKER') {
  const response = await request.post('/api/sessions/import', { data: {
    session: { title: 'Older project context', providerId: provider.id, model: 'budget-model', mode: 'plan' },
    messages: [
      { id: 'old-user', role: 'user', content: `${marker}\n${'Earlier project context. '.repeat(3000)}`, createdAt: 1 },
      { id: 'old-assistant', role: 'assistant', content: 'I recorded the earlier project requirements. No files were changed.', createdAt: 2 },
    ],
  } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function open(page: Page, session: Session) {
  await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible();
  await expect(page.getByText('Connecting to live updates…', { exact: true })).toHaveCount(0);
}
async function send(page: Page, request: APIRequestContext, session: Session, content: string) {
  await composer(page).fill(content);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await accepted).status()).toBe(202);
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect(indicator(page)).toBeVisible();
  return detail(request, session.id);
}
function latestContext(state: SessionDetail) { return state.messages.filter(message => message.role === 'assistant').at(-1)!.context!; }
async function expand(page: Page) {
  const target = indicator(page); if (!await target.evaluate(element => (element as HTMLDetailsElement).open)) await target.locator('summary').click();
  return target;
}

test('catalog context is an approximate request snapshot, survives reload, and never counts an unsent draft', async ({ page, request }) => {
  await discover(request); const session = await create(request); await open(page, session); const before = await calls(request);
  const completed = await send(page, request, session, 'Explain this fixture project briefly.');
  const context = latestContext(completed);
  expect(context).toMatchObject({ providerId: provider.id, model: 'budget-model', contextWindow: 16384, limitSource: 'catalog', action: 'continue' });
  expect(context.estimatedInputTokens).toBeGreaterThan(0);
  await expect(await expand(page)).toContainText(/estimat|approx/i);
  await composer(page).fill('This draft is not in the request estimate. '.repeat(100));
  await page.reload(); await expect(indicator(page)).toBeVisible();
  expect(latestContext(await detail(request, session.id))).toEqual(context); expect(await calls(request)).toBe(before + 1);
  await expect(composer(page)).toHaveValue('This draft is not in the request estimate. '.repeat(100));
});

test('unknown context limits remain unknown and do not block a large latest message', async ({ page, request }) => {
  const session = await create(request, 'test-model'); await open(page, session); const before = await calls(request);
  const completed = await send(page, request, session, `LATEST_TASK\n${'Large latest task data. '.repeat(2500)}`);
  const context = latestContext(completed); expect(context.limitSource).toBe('unknown'); expect(context.contextWindow).toBeUndefined();
  await expect(await expand(page)).toContainText(/unknown/i); expect(await calls(request)).toBe(before + 1);
  expect(completed.messages.some(message => message.role === 'system')).toBe(false);
});

test('a known window never trims or refuses a huge latest turn with no safely compactable prefix', async ({ page, request }) => {
  await discover(request); const session = await create(request); await open(page, session); const before = await calls(request);
  const prompt = `KEEP_LATEST_VERBATIM\n${'Huge latest requirements. '.repeat(3000)}`.trim();
  const completed = await send(page, request, session, prompt);
  expect(completed.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([prompt]);
  expect(latestContext(completed)).toMatchObject({ contextWindow: 16384, action: 'continue' });
  expect(latestContext(completed).reason).toBeTruthy(); expect(await calls(request)).toBe(before + 1);
});

test('proactive compaction archives older history, preserves the current task, and undo/redo is exact without model replay', async ({ page, request }) => {
  await discover(request); const session = await imported(request), original = await detail(request, session.id); await open(page, session);
  const before = await calls(request), prompt = 'LATEST_TASK: summarize the next step without editing files.';
  const completed = await send(page, request, session, prompt);
  expect(await calls(request)).toBe(before + 2);
  expect(completed.messages.some(message => message.role === 'system' && message.content.includes('Earlier context:'))).toBe(true);
  expect(completed.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([prompt]);
  expect(completed.messages.some(message => message.content.includes('OLDER_CONTEXT_MARKER'))).toBe(false);
  const archives: { sessions: Session[] } = await (await request.get('/api/sessions?archived=true')).json();
  const archive = archives.sessions.find(item => item.parentId === session.id); expect(archive).toBeTruthy();
  expect((await detail(request, archive!.id)).messages.map(message => message.content)).toEqual([...original.messages.map(message => message.content), prompt]);
  await composer(page).fill('Unsent follow-up stays separate.'); const checkpointId = completed.history!.undoId;
  expect((await request.post(`/api/sessions/${session.id}/history/undo`, { data: { checkpointId } })).status()).toBe(200);
  await page.reload(); expect((await detail(request, session.id)).messages).toEqual(original.messages);
  expect((await request.post(`/api/sessions/${session.id}/history/redo`, { data: { checkpointId } })).status()).toBe(200);
  await page.reload(); expect((await detail(request, session.id)).messages).toEqual(completed.messages);
  await expect(composer(page)).toHaveValue('Unsent follow-up stays separate.'); expect(await calls(request)).toBe(before + 2);
});

test('an empty proactive summary preserves original context and falls back to one ordinary completion', async ({ page, request }) => {
  await discover(request); const session = await imported(request, 'EMPTY_BUDGET_SUMMARY'), original = await detail(request, session.id); await open(page, session);
  const before = await calls(request); const completed = await send(page, request, session, 'Continue with the existing requirements.');
  expect(await calls(request)).toBe(before + 2); expect(completed.messages.slice(0, original.messages.length)).toEqual(original.messages);
  expect(completed.messages.some(message => message.role === 'system')).toBe(false);
  const archives: { sessions: Session[] } = await (await request.get('/api/sessions?archived=true')).json();
  expect(archives.sessions.some(item => item.parentId === session.id)).toBe(false);
  expect(latestContext(completed).reason).toBeTruthy();
});

test('image-bearing requests label uncertainty rather than presenting base64 as measured input tokens', async ({ page, request }) => {
  await discover(request); const session = await create(request); const before = await calls(request);
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=';
  expect((await request.post(`/api/sessions/${session.id}/messages`, { data: { content: 'Describe this image.', attachments: [{ name: 'pixel.png', mimeType: 'image/png', dataUrl }] } })).status()).toBe(202);
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle'); await open(page, session);
  expect(latestContext(await detail(request, session.id)).uncertain).toBe(true);
  await expect(await expand(page)).toContainText(/uncertain|image/i); expect(await calls(request)).toBe(before + 1);
});

test('provider limits save explicitly, override catalog metadata, survive reload, and can be removed', async ({ page, request }) => {
  await discover(request); const session = await create(request); await open(page, session);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: provider.name, exact: true }).click();
  await dialog.locator('summary').filter({ hasText: 'Context window overrides' }).click();
  await dialog.getByRole('button', { name: 'Add context limit', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Model ID 1', exact: true }).fill('budget-model');
  await dialog.getByRole('spinbutton', { name: 'Context window tokens 1', exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const unsaved: Settings = await (await request.get('/api/settings')).json();
  expect(unsaved.providers.find(item => item.id === provider.id)!.contextWindows).toBeUndefined();
  await dialog.getByRole('spinbutton', { name: 'Context window tokens 1', exact: true }).fill('24000');
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.reload(); await expect(composer(page)).toBeVisible();
  const saved: Settings = await (await request.get('/api/settings')).json();
  expect(saved.providers.find(item => item.id === provider.id)!.contextWindows).toEqual({ 'budget-model': 24000 });
  const completed = await send(page, request, session, 'Use the configured provider limit.');
  expect(latestContext(completed)).toMatchObject({ contextWindow: 24000, limitSource: 'override' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByRole('button', { name: provider.name, exact: true }).click();
  await dialog.locator('summary').filter({ hasText: 'Context window overrides' }).click();
  await dialog.getByRole('button', { name: 'Remove context limit budget-model', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await discover(request); const next = await send(page, request, session, 'Use catalog metadata after removing the override.');
  expect(latestContext(next)).toMatchObject({ contextWindow: 16384, limitSource: 'catalog' });
});

test('reload during a proactive summary keeps live status and replaces progress without duplicate messages', async ({ page, request }) => {
  await discover(request); const session = await imported(request, 'WAIT_BUDGET_SUMMARY'); await open(page, session);
  const before = await calls(request); await composer(page).fill('Continue after safely condensing the older notes.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/fixture/summaries')).json()).pending).toBe(1);
  await expect(indicator(page)).toBeVisible(); await page.reload();
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  await expect(indicator(page)).toBeVisible();
  expect(latestContext(await detail(request, session.id)).action).toBe('compact');
  await composer(page).fill('Draft kept through in-progress reload.');
  expect((await request.post('/fixture/summaries/release')).ok()).toBe(true);
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect(indicator(page)).toHaveCount(1);
  const completed = await detail(request, session.id);
  expect(completed.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
  expect(latestContext(completed).action).toBe('continue');
  await page.reload(); await expect(indicator(page)).toHaveCount(1);
  await expect(composer(page)).toHaveValue('Draft kept through in-progress reload.');
  expect(await calls(request)).toBe(before + 2);
});

test('stopping a proactive summary preserves original history and pauses follow-ups without another provider request', async ({ page, request }) => {
  await discover(request); const session = await imported(request, 'WAIT_BUDGET_SUMMARY'), original = await detail(request, session.id); await open(page, session);
  const before = await calls(request); await composer(page).fill('Start safe context preparation.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/fixture/summaries')).json()).pending).toBe(1);
  await composer(page).fill('Follow-up must stay queued.'); await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(composer(page)).toHaveValue(''); await composer(page).fill('Keep my separate unsent draft.');
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect.poll(async () => (await (await request.get('/fixture/summaries')).json()).pending).toBe(0);
  const stopped = await detail(request, session.id);
  expect(stopped.messages.slice(0, original.messages.length)).toEqual(original.messages);
  expect(stopped.messages.some(message => message.role === 'system')).toBe(false);
  expect(stopped.queue?.paused).toBe(true); expect(stopped.queue?.items).toHaveLength(1);
  await page.reload(); await expect(composer(page)).toHaveValue('Keep my separate unsent draft.');
  expect(await calls(request)).toBe(before + 1);
});

test('mobile context details remain reachable without covering the composer or overflowing', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await discover(request); const session = await create(request); await open(page, session);
  await send(page, request, session, 'Give a brief fixture overview.'); await expand(page);
  await composer(page).fill('Keep the mobile composer usable.'); await indicator(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/context-mobile.png', fullPage: true, animations: 'disabled' });
  await expect(composer(page)).toHaveValue('Keep the mobile composer usable.');
});
