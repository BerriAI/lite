import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { FileChange, Session, SessionDetail } from '../../shared/types';
import type { HistoryState } from '../../shared/history';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Lite' });
async function strip(page: Page) {
  if (!await page.locator('.session-menu').isVisible()) await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  return page.locator('.session-menu');
}
const queued = (page: Page) => page.getByRole('region', { name: 'Queued messages', exact: true });
const label = (direction: 'undo' | 'redo') => direction === 'undo' ? 'Undo last turn' : 'Redo turn';
const written = (prompt: string) => `Created by the browser test.\n${prompt}\n`;
let workspace: string;
let sessions: Session[] = [];

test.beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-history-browser-')));
  sessions = [];
});
test.afterEach(async ({ request }) => {
  // Each test owns a separate workspace; never alter the fixture's shared result.txt.
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session.id)).session.status).not.toMatch(/running|waiting/);
  }
  await rm(workspace, { recursive: true, force: true });
});

async function create(request: APIRequestContext, title: string): Promise<Session> {
  const response = await request.post('/api/sessions', { data: { title, workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask' } });
  expect(response.ok()).toBe(true);
  const session: Session = await response.json(); sessions.push(session); return session;
}
async function detail(request: APIRequestContext, id: string): Promise<SessionDetail & { history: HistoryState }> {
  const response = await request.get(`/api/sessions/${id}`);
  expect(response.ok()).toBe(true); return response.json();
}
async function history(request: APIRequestContext, id: string): Promise<HistoryState> {
  const response = await request.get(`/api/sessions/${id}/history`);
  expect(response.ok()).toBe(true); return response.json();
}
async function snapshot(request: APIRequestContext, id: string) {
  const state = await detail(request, id);
  const response = await request.get(`/api/sessions/${id}/changes`);
  expect(response.ok()).toBe(true);
  const changes: { changes: FileChange[] } = await response.json();
  return { messages: state.messages, todos: state.todos, changes: changes.changes };
}
async function calls(request: APIRequestContext): Promise<number> {
  const response = await request.get('/fixture/requests');
  expect(response.ok()).toBe(true);
  const result = await response.json(); expect(typeof result.count).toBe('number'); return result.count;
}
async function open(page: Page, session: Session) {
  await page.goto(`/#session/${session.id}`);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('Connecting to live updates…', { exact: true })).toHaveCount(0);
}
async function send(page: Page, request: APIRequestContext, session: Session, content: string, write = false) {
  await composer(page).fill(content);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/api/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await accepted).status()).toBe(202);
  if (write) {
    const approval = page.getByRole('region', { name: 'Permission requested' });
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
  }
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect((await strip(page)).getByRole('button', { name: 'Undo last turn', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close session actions', exact: true }).click();
}
async function move(page: Page, request: APIRequestContext, session: Session, direction: 'undo' | 'redo', options: { menu?: boolean; status?: number } = {}) {
  const state = await history(request, session.id);
  const checkpointId = direction === 'undo' ? state.undoId : state.redoId;
  expect(checkpointId).toBeTruthy();
  await (await strip(page)).getByRole('button', { name: label(direction), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${label(direction)}?`, exact: true });
  await expect(dialog).toBeVisible();
  // The action restores recorded state, not arbitrary side effects or another model call.
  await expect(dialog).toContainText(/transcript|conversation/i);
  await expect(dialog).toContainText(/file/i);
  await expect(dialog).toContainText(/shell/i);
  await expect(dialog).toContainText(/MCP/);
  await expect(dialog).toContainText(/terminal/i);
  const response = page.waitForResponse(result => result.url().endsWith(`/api/sessions/${session.id}/history/${direction}`) && result.request().method() === 'POST');
  await dialog.getByRole('button', { name: label(direction), exact: true }).click();
  const result = await response;
  expect(result.request().postDataJSON()).toEqual({ checkpointId });
  expect(result.status()).toBe(options.status ?? 200);
  if ((options.status ?? 200) === 200) await expect(dialog).toHaveCount(0);
  return result;
}
async function restored(page: Page, request: APIRequestContext, session: Session, expected: Awaited<ReturnType<typeof snapshot>>, contents: string) {
  await expect.poll(() => snapshot(request, session.id)).toEqual(expected);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(contents);
  await expect(page.getByRole('article', { name: 'Your message', exact: true })).toHaveText(expected.messages.filter(message => message.role === 'user').map(message => message.content));
  expect((await detail(request, session.id)).history).toEqual(await history(request, session.id));
}

test('undoes and redoes two real file-tool turns exactly, survives reload, and never replays the provider', async ({ page, request }) => {
  const session = await create(request, 'Two-turn file history');
  const baseline = 'Original workspace contents.\n';
  await writeFile(join(workspace, 'result.txt'), baseline);
  await open(page, session);
  const empty = await snapshot(request, session.id);
  const firstPrompt = 'create fixture history first revision', secondPrompt = 'create fixture history second revision';
  const beforeCalls = await calls(request);
  await send(page, request, session, firstPrompt, true);
  const first = await snapshot(request, session.id);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(written(firstPrompt));
  await send(page, request, session, secondPrompt, true);
  const second = await snapshot(request, session.id);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(written(secondPrompt));
  const completedCalls = await calls(request);
  expect(completedCalls - beforeCalls).toBe(4); // Tool call + final answer for each real turn.
  expect(first.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.status)).toEqual(['completed']);
  expect(second.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.status)).toEqual(['completed', 'completed']);

  await move(page, request, session, 'undo', { menu: true });
  await restored(page, request, session, first, written(firstPrompt));
  expect(await history(request, session.id)).toMatchObject({ canUndo: true, canRedo: true });
  await page.reload();
  await restored(page, request, session, first, written(firstPrompt));
  await move(page, request, session, 'undo');
  await restored(page, request, session, empty, baseline);
  await expect((await strip(page)).getByRole('button', { name: 'Undo last turn', exact: true })).toBeDisabled();
  await move(page, request, session, 'redo');
  await restored(page, request, session, first, written(firstPrompt));
  await page.reload();
  await restored(page, request, session, first, written(firstPrompt));
  await move(page, request, session, 'redo', { menu: true });
  await restored(page, request, session, second, written(secondPrompt));
  await expect((await strip(page)).getByRole('button', { name: 'Redo turn', exact: true })).toBeDisabled();
  expect(await calls(request)).toBe(completedCalls);
});

test('rejects outside file edits without changing the transcript, and succeeds only after the expected contents return', async ({ page, request }) => {
  const session = await create(request, 'External edit conflict');
  const baseline = 'Before the model edit.\n', prompt = 'create fixture protected history';
  await writeFile(join(workspace, 'result.txt'), baseline);
  await open(page, session);
  await send(page, request, session, prompt, true);
  const before = await snapshot(request, session.id), beforeHistory = await history(request, session.id), beforeCalls = await calls(request);
  await writeFile(join(workspace, 'result.txt'), 'New external editor work must survive.\n');
  const response = await move(page, request, session, 'undo', { status: 409 });
  expect((await response.json()).error).toMatch(/result\.txt.*changed|changed.*result\.txt/i);
  await expect(page.getByRole('alert').first()).toContainText('result.txt');
  expect(await snapshot(request, session.id)).toEqual(before);
  expect(await history(request, session.id)).toMatchObject({ undoId: beforeHistory.undoId, canUndo: true, canRedo: false });
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('New external editor work must survive.\n');
  const dialog = page.getByRole('dialog', { name: 'Undo last turn?', exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  expect(await snapshot(request, session.id)).toEqual(before);
  await writeFile(join(workspace, 'result.txt'), written(prompt));
  await move(page, request, session, 'undo');
  await restored(page, request, session, { messages: [], todos: [], changes: [] }, baseline);
  expect(await calls(request)).toBe(beforeCalls);
});

test('a stale confirmation cannot undo a different turn after another client moves history', async ({ page, request }) => {
  const session = await create(request, 'Stale checkpoint confirmation');
  await writeFile(join(workspace, 'result.txt'), 'Baseline.\n');
  await open(page, session);
  await send(page, request, session, 'create fixture stale first', true);
  const first = await snapshot(request, session.id);
  await send(page, request, session, 'create fixture stale second', true);
  const expected = await history(request, session.id), beforeCalls = await calls(request);
  await (await strip(page)).getByRole('button', { name: 'Undo last turn', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Undo last turn?', exact: true });
  await expect(dialog).toBeVisible();
  const otherClient = await request.post(`/api/sessions/${session.id}/history/undo`, { data: { checkpointId: expected.undoId } });
  expect(otherClient.ok()).toBe(true);
  await expect.poll(() => snapshot(request, session.id)).toEqual(first);
  const attempts: { checkpointId: string; status: number }[] = [];
  page.on('response', response => {
    if (response.url().endsWith(`/api/sessions/${session.id}/history/undo`) && response.request().method() === 'POST') {
      attempts.push({ checkpointId: response.request().postDataJSON().checkpointId, status: response.status() });
    }
  });
  await dialog.getByRole('button', { name: 'Undo last turn', exact: true }).click();
  // If SSE has already updated the strip, reject locally. Otherwise the captured old ID
  // must reach the real API and conflict; neither path may undo the now-current first turn.
  await expect(page.getByRole('alert').first()).toContainText(/history.*changed|checkpoint.*changed/i);
  expect(attempts.length).toBeLessThanOrEqual(1);
  if (attempts.length) expect(attempts).toEqual([{ checkpointId: expected.undoId, status: 409 }]);
  expect(await snapshot(request, session.id)).toEqual(first);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(written('create fixture stale first'));
  expect(await calls(request)).toBe(beforeCalls);
});

test('retains redo through drafts, reload, and rejected sends, and discards it only after an accepted new turn', async ({ page, request }) => {
  const session = await create(request, 'Redo branch acceptance');
  const baseline = 'Original branch file.\n';
  await writeFile(join(workspace, 'result.txt'), baseline);
  await open(page, session);
  await send(page, request, session, 'create fixture old branch', true);
  await move(page, request, session, 'undo');
  const undone = await history(request, session.id), beforeCalls = await calls(request);
  await composer(page).fill('A new branch only after acceptance');
  await page.reload();
  await expect(composer(page)).toHaveValue('A new branch only after acceptance');
  await expect((await strip(page)).getByRole('button', { name: 'Redo turn', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Close session actions', exact: true }).click();
  expect((await history(request, session.id)).redoId).toBe(undone.redoId);
  const invalid = await request.post(`/api/sessions/${session.id}/messages`, { data: { content: '' } });
  expect(invalid.status()).toBe(400);
  await page.route(`**/api/sessions/${session.id}/messages`, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'History send fixture unavailable.' }) })
    : route.continue());
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('History send fixture unavailable.');
  await expect(composer(page)).toHaveValue('A new branch only after acceptance');
  expect((await history(request, session.id)).redoId).toBe(undone.redoId);
  expect(await calls(request)).toBe(beforeCalls);
  expect((await detail(request, session.id)).messages).toEqual([]);
  await page.unroute(`**/api/sessions/${session.id}/messages`);
  await send(page, request, session, 'A new branch only after acceptance');
  expect(await history(request, session.id)).toMatchObject({ canUndo: true, canRedo: false });
  expect((await history(request, session.id)).redoId).toBeUndefined();
  await page.reload();
  await expect((await strip(page)).getByRole('button', { name: 'Redo turn', exact: true })).toBeDisabled();
  expect((await detail(request, session.id)).messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['A new branch only after acceptance']);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(baseline);
  expect(await calls(request)).toBe(beforeCalls + 1);
});

test('keeps queued work paused through undo and redo until explicit Resume accepts a new branch', async ({ page, request }) => {
  const session = await create(request, 'History queue pause');
  const baseline = 'Before queued branch.\n';
  await writeFile(join(workspace, 'result.txt'), baseline);
  await open(page, session);
  await send(page, request, session, 'create fixture queue history', true);
  await move(page, request, session, 'undo');
  const undoState = await history(request, session.id), beforeCalls = await calls(request);
  const pending = await request.post(`/api/sessions/${session.id}/queue`, { data: { content: 'Queued branch after review' } });
  expect(pending.status()).toBe(202);
  expect((await history(request, session.id)).redoId).toBe(undoState.redoId);
  const skipped = await request.post(`/api/sessions/${session.id}/messages`, { data: { content: 'Must not jump the queue' } });
  expect(skipped.status()).toBe(409);
  expect((await history(request, session.id)).redoId).toBe(undoState.redoId);
  await expect(queued(page).getByRole('status')).toHaveText('Paused');
  await move(page, request, session, 'redo');
  await expect(queued(page).getByRole('status')).toHaveText('Paused');
  await move(page, request, session, 'undo');
  await page.reload();
  await expect(queued(page).getByRole('status')).toHaveText('Paused');
  await expect(queued(page)).toContainText('Queued branch after review');
  const held = await detail(request, session.id);
  expect(held.messages).toEqual([]);
  expect(held.queue).toMatchObject({ paused: true, items: [{ content: 'Queued branch after review' }] });
  expect(held.history.canRedo).toBe(true);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(baseline);
  expect(await calls(request)).toBe(beforeCalls);
  await queued(page).getByRole('button', { name: 'Resume queue', exact: true }).click();
  await expect.poll(async () => {
    const state = await detail(request, session.id);
    return { status: state.session.status, users: state.messages.filter(message => message.role === 'user').map(message => message.content), pending: state.queue?.items.length };
  }).toEqual({ status: 'idle', users: ['Queued branch after review'], pending: 0 });
  expect((await history(request, session.id)).canRedo).toBe(false);
  expect(await calls(request)).toBe(beforeCalls + 1);
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(baseline);
});

test('keeps history controls reachable on mobile without covering the draft or overflowing the viewport', async ({ page, request }) => {
  const session = await create(request, 'Mobile turn history');
  await writeFile(join(workspace, 'result.txt'), 'Mobile baseline.\n');
  await open(page, session);
  await send(page, request, session, 'create fixture mobile first', true);
  await send(page, request, session, 'create fixture mobile second', true);
  await move(page, request, session, 'undo');
  const before = await snapshot(request, session.id), beforeCalls = await calls(request);
  await composer(page).fill('Keep this mobile draft while reviewing history');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(composer(page)).toHaveValue('Keep this mobile draft while reviewing history');
  await expect((await strip(page)).getByRole('button', { name: 'Undo last turn', exact: true })).toBeEnabled();
  await expect((await strip(page)).getByRole('button', { name: 'Redo turn', exact: true })).toBeEnabled();
  await expect(await strip(page)).toBeInViewport();
  await expect(composer(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/history-mobile.png', fullPage: true, animations: 'disabled' });
  await move(page, request, session, 'redo');
  await move(page, request, session, 'undo');
  await restored(page, request, session, before, written('create fixture mobile first'));
  await expect(composer(page)).toHaveValue('Keep this mobile draft while reviewing history');
  expect(await calls(request)).toBe(beforeCalls);
});
