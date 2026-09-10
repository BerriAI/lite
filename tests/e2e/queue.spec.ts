import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { QueueState, Session, SessionDetail } from '../../shared/types';

const reply = 'Hello from Speedrail.\n\nYour workspace is ready. Here is a small example:\n\n```typescript\nconst answer = 42;\n```';
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Speedrail' });
const queuePanel = (page: Page) => page.getByRole('region', { name: 'Queued messages' });

async function create(request: APIRequestContext, title: string): Promise<Session> {
  const response = await request.post('/api/sessions', { data: { title: `${title} ${randomUUID().slice(0, 8)}`, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask' } });
  expect(response.ok()).toBe(true); return response.json();
}
async function detail(request: APIRequestContext, id: string): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${id}`);
  expect(response.ok()).toBe(true); return response.json();
}
async function queue(request: APIRequestContext, id: string): Promise<QueueState> {
  const response = await request.get(`/api/sessions/${id}/queue`);
  expect(response.ok()).toBe(true); return response.json();
}
async function open(page: Page, session: Session) {
  await page.goto(`/#session/${session.id}`);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('Connecting to live updates…', { exact: true })).toHaveCount(0);
}
async function send(page: Page, session: Session, content: string) {
  await composer(page).fill(content);
  const response = page.waitForResponse(r => r.url().endsWith(`/api/sessions/${session.id}/messages`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await response).status()).toBe(202);
}
async function enqueue(page: Page, session: Session, content: string, enter = false) {
  await composer(page).fill(content);
  const response = page.waitForResponse(r => r.url().endsWith(`/api/sessions/${session.id}/queue`) && r.request().method() === 'POST');
  if (enter) await composer(page).press('Enter');
  else await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  expect((await response).status()).toBe(202);
  await expect(composer(page)).toHaveValue('');
}
async function idle(request: APIRequestContext, session: Session, turns: string[]) {
  await expect.poll(async () => {
    const state = await detail(request, session.id);
    return { status: state.session.status, users: state.messages.filter(m => m.role === 'user').map(m => m.content), pending: state.queue?.items.length ?? 0 };
  }, { timeout: 12000 }).toEqual({ status: 'idle', users: turns, pending: 0 });
}
async function stopped(page: Page, request: APIRequestContext, session: Session) {
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
  await expect(queuePanel(page).getByRole('status')).toHaveText('Paused');
}

// Real write-fixture requests pause at an approval before any mutation. This provides a
// deterministic barrier to prepare a queue; cancelling it never touches the shared result.txt.
async function waiting(page: Page, session: Session, suffix: string) {
  await send(page, session, `create fixture ${suffix}`);
  await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to queue' })).toBeVisible();
}

test('keeps per-session text and attachment drafts across switching and reload, then clears only the submitted draft', async ({ page, request }) => {
  const first = await create(request, 'Draft alpha'), second = await create(request, 'Draft beta');
  const textA = 'Keep this unsent alpha draft.', textB = 'Keep this separate beta draft.';
  await open(page, first);
  await composer(page).fill(textA);
  await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: 'draft-context.txt', mimeType: 'text/plain', buffer: Buffer.from('A small saved text attachment.\n') });
  await expect(page.getByRole('button', { name: 'Remove draft-context.txt', exact: true })).toBeVisible();
  await page.locator('.session-link').filter({ hasText: second.title }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove draft-context.txt' })).toHaveCount(0);
  await composer(page).fill(textB);
  await page.locator('.session-link').filter({ hasText: first.title }).click();
  await expect(composer(page)).toHaveValue(textA);
  await expect(page.getByRole('button', { name: 'Remove draft-context.txt' })).toBeVisible();
  await page.reload();
  await expect(composer(page)).toHaveValue(textA);
  await expect(page.getByRole('button', { name: 'Remove draft-context.txt' })).toBeVisible();
  expect((await detail(request, first.id)).messages).toEqual([]);
  expect((await detail(request, second.id)).messages).toEqual([]);

  const submission = page.waitForRequest(r => r.url().endsWith(`/api/sessions/${first.id}/messages`) && r.method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await submission).postDataJSON()).toMatchObject({ content: textA, attachments: [{ name: 'draft-context.txt', content: 'A small saved text attachment.\n', mimeType: 'text/plain' }] });
  await idle(request, first, [textA]);
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove draft-context.txt' })).toHaveCount(0);
  await page.reload();
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByRole('article', { name: 'Your message' })).toContainText('draft-context.txt');
  await page.locator('.session-link').filter({ hasText: second.title }).click();
  await expect(composer(page)).toHaveValue(textB);
  await page.reload();
  await expect(composer(page)).toHaveValue(textB);
  expect((await detail(request, second.id)).messages).toEqual([]);
});

test('queues by button and Enter behind a live stream, then drains FIFO exactly once', async ({ page, request }) => {
  const session = await create(request, 'FIFO streaming');
  const first = 'slow response before queued turns', second = 'FIFO second turn', third = 'FIFO third turn';
  await open(page, session);
  await send(page, session, first);
  await expect(page.getByRole('article', { name: 'Assistant message' })).toContainText('Hello from Speedrail.');
  expect((await detail(request, session.id)).session.status).toBe('running');
  const posts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/sessions\/[^/]+\/(?:messages|queue)$/.test(r.url())) posts.push(new URL(r.url()).pathname); });
  await enqueue(page, session, second);
  await enqueue(page, session, third, true);
  await expect(queuePanel(page).locator('.queue-item-content > p')).toHaveText([second, third]);
  expect((await queue(request, session.id)).items.map(item => item.content)).toEqual([second, third]);
  expect(posts).toEqual([`/api/sessions/${session.id}/queue`, `/api/sessions/${session.id}/queue`]);
  await page.reload();
  await idle(request, session, [first, second, third]);
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveText([first, second, third]);
  await expect(page.getByRole('article', { name: 'Assistant message' })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
  const final = await detail(request, session.id);
  expect(final.messages.filter(m => m.role === 'assistant').map(m => m.content)).toEqual([reply, reply, reply]);
  expect(new Set(final.messages.map(m => m.id)).size).toBe(6);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveText([first, second, third]);
  expect((await detail(request, session.id)).messages).toHaveLength(6);
});

test('Stop pauses queued items, removal is durable, and only explicit Resume starts the remaining item', async ({ page, request }) => {
  const session = await create(request, 'Pause remove resume');
  await open(page, session);
  await waiting(page, session, 'queue cancellation barrier');
  await enqueue(page, session, 'Remove this queued item');
  await enqueue(page, session, 'Keep this queued item', true);
  await stopped(page, request, session);
  expect((await queue(request, session.id)).items.map(item => item.content)).toEqual(['Remove this queued item', 'Keep this queued item']);
  await page.reload();
  await expect(queuePanel(page).getByRole('status')).toHaveText('Paused');
  await expect(queuePanel(page)).toContainText('Resume queue');
  expect((await detail(request, session.id)).messages.filter(m => m.role === 'user')).toHaveLength(1);
  const remove = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes(`/api/sessions/${session.id}/queue/`));
  await page.getByRole('button', { name: 'Remove queued message 1', exact: true }).click();
  expect((await remove).ok()).toBe(true);
  await expect(queuePanel(page).locator('.queue-item-content > p')).toHaveText(['Keep this queued item']);
  await page.reload();
  await expect(queuePanel(page).locator('.queue-item-content > p')).toHaveText(['Keep this queued item']);
  await expect(queuePanel(page).getByRole('status')).toHaveText('Paused');
  expect((await detail(request, session.id)).messages.filter(m => m.role === 'user')).toHaveLength(1);
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await idle(request, session, ['create fixture queue cancellation barrier', 'Keep this queued item']);
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveText(['create fixture queue cancellation barrier', 'Keep this queued item']);
  expect((await detail(request, session.id)).messages.some(m => m.content === 'Remove this queued item')).toBe(false);
});

test('provider failure pauses remaining work until a separate explicit resume', async ({ page, request }) => {
  const session = await create(request, 'Error queue hold');
  await open(page, session);
  await waiting(page, session, 'error queue preparation');
  await enqueue(page, session, 'provider failure queued turn');
  await enqueue(page, session, 'Recover after reviewing the error');
  await stopped(page, request, session);
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('error');
  await expect(queuePanel(page).getByRole('status')).toHaveText('Paused');
  await expect(queuePanel(page).locator('.queue-item-content > p')).toHaveText(['Recover after reviewing the error']);
  await expect(page.getByRole('alert').first()).toContainText('401');
  const failed = await detail(request, session.id);
  expect(failed.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['create fixture error queue preparation', 'provider failure queued turn']);
  expect(failed.queue?.paused).toBe(true);
  await page.reload();
  await expect(queuePanel(page).getByRole('status')).toHaveText('Paused');
  expect((await detail(request, session.id)).messages.filter(m => m.role === 'user')).toHaveLength(2);
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await idle(request, session, ['create fixture error queue preparation', 'provider failure queued turn', 'Recover after reviewing the error']);
  await expect(page.getByRole('article', { name: 'Assistant message' }).last()).toContainText('Hello from Speedrail.');
});

test('keeps queues and drafts isolated between sessions and fits the mobile viewport', async ({ page, request }) => {
  const first = await create(request, 'Mobile queue alpha'), second = await create(request, 'Mobile queue beta');
  await open(page, first);
  await waiting(page, first, 'mobile queue barrier');
  await enqueue(page, first, 'Review the API boundary and explain the next smallest implementation step.');
  await stopped(page, request, first);
  await composer(page).fill('Unsent alpha follow-up');
  await page.locator('.session-link').filter({ hasText: second.title }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(queuePanel(page)).toHaveCount(0);
  await composer(page).fill('Unsent beta follow-up');
  expect((await queue(request, second.id)).items).toEqual([]);
  expect((await detail(request, second.id)).messages).toEqual([]);
  await page.locator('.session-link').filter({ hasText: first.title }).click();
  await expect(composer(page)).toHaveValue('Unsent alpha follow-up');
  await expect(queuePanel(page).getByRole('status')).toHaveText('Paused');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove queued message 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dismissToast = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismissToast.isVisible()) await dismissToast.click();
  await page.screenshot({ path: 'test-results/queue-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.locator('.session-link').filter({ hasText: second.title }).click();
  await expect(composer(page)).toHaveValue('Unsent beta follow-up');
  await expect(queuePanel(page)).toHaveCount(0);
  expect((await queue(request, first.id)).items).toHaveLength(1);
});

test('retains the draft and attachment when a queue request fails, with no ghost queued message', async ({ page, request }) => {
  const session = await create(request, 'Queue request failure');
  await open(page, session);
  await waiting(page, session, 'request failure barrier');
  await composer(page).fill('Keep this draft after a failed queue request');
  await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: 'retry-context.txt', mimeType: 'text/plain', buffer: Buffer.from('Context must survive a failed submission.\n') });
  await expect(page.getByRole('button', { name: 'Remove retry-context.txt' })).toBeVisible();
  await page.route(`**/api/sessions/${session.id}/queue`, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Queue fixture temporarily unavailable.' }) })
    : route.continue());
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('Queue fixture temporarily unavailable.');
  await expect(composer(page)).toHaveValue('Keep this draft after a failed queue request');
  await expect(page.getByRole('button', { name: 'Remove retry-context.txt' })).toBeVisible();
  expect((await queue(request, session.id)).items).toEqual([]);
  await page.reload();
  await expect(composer(page)).toHaveValue('Keep this draft after a failed queue request');
  await expect(page.getByRole('button', { name: 'Remove retry-context.txt' })).toBeVisible();
  await page.unroute(`**/api/sessions/${session.id}/queue`);
  await enqueue(page, session, 'Keep this draft after a failed queue request');
  const accepted = await queue(request, session.id);
  expect(accepted.items).toHaveLength(1);
  expect(accepted.items[0].attachments).toMatchObject([{ name: 'retry-context.txt', content: 'Context must survive a failed submission.\n' }]);
  await expect(page.getByRole('button', { name: 'Remove retry-context.txt' })).toHaveCount(0);
  await stopped(page, request, session);
});

for (const width of [1280, 390]) {
  test(`promotes a queued message to steering without losing its attachment or the current draft at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await create(request, 'Queue to steering');
    try {
      await open(page, session); await waiting(page, session, 'steering barrier');
      await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: 'queued-context.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the saved attachment.') });
      await enqueue(page, session, 'Explain the plan before making changes.');
      await composer(page).fill('An independent unsent thought.');
      const item = (await queue(request, session.id)).items[0];
      const path = `/api/sessions/${session.id}/queue/${item.id}/steer`;
      await page.route(`**${path}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Steering temporarily unavailable' }) }));
      await page.getByRole('button', { name: 'Steer with queued message 1', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Steering temporarily unavailable');
      expect((await queue(request, session.id)).items).toEqual([item]);
      await expect(composer(page)).toHaveValue('An independent unsent thought.');
      await page.unroute(`**${path}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/steer-queue-${width}.png`, animations: 'disabled' });
      const accepted = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Steer with queued message 1', exact: true }).click();
      expect((await accepted).status()).toBe(202);
      await expect(queuePanel(page)).toHaveCount(0);
      const note = page.getByRole('article', { name: 'Your message', exact: true }).last();
      await expect(note).toContainText('Steering'); await expect(note).toContainText(item.content);
      await expect(note).toContainText('queued-context.txt'); await expect(note).not.toContainText('[Steering]');
      await expect(composer(page)).toHaveValue('An independent unsent thought.');
      await expect(page.getByRole('region', { name: 'Permission requested' })).toHaveCount(0);
      await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
      const state = await detail(request, session.id);
      expect(state.messages.filter(message => message.content.includes('[Steering]'))).toHaveLength(1);
      expect(state.messages.find(message => message.content.includes('[Steering]'))?.attachments).toEqual(item.attachments);
      expect(state.messages.filter(message => message.role === 'user')).toHaveLength(1);
      await page.reload(); await expect(composer(page)).toHaveValue('An independent unsent thought.');
      await expect(queuePanel(page)).toHaveCount(0); await expect(note).toContainText(item.content);
    } finally { await request.post(`/api/sessions/${session.id}/cancel`); }
  });
}
