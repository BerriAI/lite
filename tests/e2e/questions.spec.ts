import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail } from '../../shared/types';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Speedrail', exact: true });
const question = (page: Page) => page.getByRole('region', { name: 'Question from agent', exact: true });
let workspace: string;
let sessions: Session[];
test.beforeEach(async () => { workspace = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-question-browser-'))); sessions = []; });
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session.id)).session.status).not.toMatch(/running|waiting/);
  }
  await rm(workspace, { recursive: true, force: true });
});
async function detail(request: APIRequestContext, id: string): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${id}`); expect(response.ok()).toBe(true); return response.json();
}
async function create(request: APIRequestContext, options: Partial<Session> = {}): Promise<Session> {
  const response = await request.post('/api/sessions', { data: { title: 'Structured question', workspace, providerId: 'fixture', model: 'test-model', permissionMode: 'ask', ...options } });
  expect(response.status()).toBe(201); const session = await response.json(); sessions.push(session); return session;
}
async function calls(request: APIRequestContext) { return (await (await request.get('/fixture/requests')).json()).count as number; }
async function open(page: Page, session: Session) {
  await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible();
  await expect(page.getByText('Connecting to live updates…', { exact: true })).toHaveCount(0);
}
async function ask(page: Page, request: APIRequestContext, session: Session, prompt = 'ask fixture question') {
  await composer(page).fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(question(page)).toBeVisible();
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('waiting');
  await expect(page.getByRole('region', { name: 'Permission requested' })).toHaveCount(0);
  await expect(question(page).getByRole('button', { name: 'Submit answer', exact: true })).toBeDisabled();
}
async function select(page: Page, label: string) {
  await question(page).getByRole('radio', { name: new RegExp(`^${label}`) }).check();
}
async function answer(page: Page, request: APIRequestContext, session: Session) {
  const received = page.waitForResponse(response => response.url().includes(`/sessions/${session.id}/questions/`) && response.url().endsWith('/answer'));
  await question(page).getByRole('button', { name: 'Submit answer', exact: true }).click();
  expect((await received).status()).toBe(200);
  await expect(question(page)).toHaveCount(0);
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
}

for (const mode of ['build', 'plan'] as const) test(`${mode} asks a deliberate question, survives reload, and saves one option answer without granting permissions`, async ({ page, request }) => {
  const session = await create(request, { mode }); await open(page, session); const before = await calls(request);
  await ask(page, request, session);
  const pending = (await detail(request, session.id)).questions![0];
  await composer(page).fill('Keep this unsent composer draft');
  await page.reload(); await expect(question(page)).toBeVisible();
  expect((await detail(request, session.id)).questions![0].id).toBe(pending.id);
  expect(await calls(request)).toBe(before + 1);
  await select(page, 'SQLite'); await answer(page, request, session);
  const completed = await detail(request, session.id);
  expect(completed.messages.filter(message => message.role === 'user')).toHaveLength(1);
  const results = completed.messages.filter(message => message.role === 'tool' && message.toolCallId === pending.toolCallId);
  expect(results).toHaveLength(1); expect(JSON.parse(results[0].content)).toMatchObject({ status: 'answered', answer: { kind: 'option', optionId: 'sqlite' } });
  expect(completed.questions).toEqual([]); expect(await calls(request)).toBe(before + 2);
  expect(await composer(page).inputValue()).toBe('Keep this unsent composer draft');
  const grants = await (await request.get(`/api/sessions/${session.id}/tool-grants`)).json(); expect(grants.tools).toEqual([]);
  const retry = await request.post(`/api/sessions/${session.id}/questions/${pending.id}/answer`, { data: { kind: 'option', optionId: 'sqlite' } });
  expect(retry.status()).toBe(200); expect(await calls(request)).toBe(before + 2);
});

test('automatic tool approval never chooses an answer and custom replies remain plain text', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); const before = await calls(request);
  await ask(page, request, session); expect(await calls(request)).toBe(before + 1);
  await select(page, 'Custom reply');
  const text = 'Use a plain text file. <script>window.injected=true</script>';
  await question(page).getByRole('textbox', { name: 'Custom reply', exact: true }).fill(text);
  await answer(page, request, session);
  const completed = await detail(request, session.id);
  const result = completed.messages.find(message => message.role === 'tool')!;
  expect(JSON.parse(result.content)).toMatchObject({ status: 'answered', answer: { kind: 'text', text } });
  expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
  expect(await calls(request)).toBe(before + 2);
});

test('answering a question does not authorize a later write in ask mode', async ({ page, request }) => {
  const session = await create(request); await open(page, session);
  await ask(page, request, session, 'ask fixture question then write'); await select(page, 'PostgreSQL');
  await question(page).getByRole('button', { name: 'Submit answer', exact: true }).click();
  const permission = page.getByRole('region', { name: 'Permission requested' }); await expect(permission).toBeVisible();
  await expect(readFile(join(workspace, 'answered.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await permission.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  await expect(readFile(join(workspace, 'answered.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const tools = (await detail(request, session.id)).messages.flatMap(message => message.toolCalls ?? []);
  expect(tools.map(tool => [tool.name, tool.status])).toEqual([['ask_user', 'completed'], ['write_file', 'denied']]);
});

test('another tab can answer once and remove a stale local question without clearing its composer draft', async ({ page, context, request }) => {
  const session = await create(request); await open(page, session); await ask(page, request, session);
  const pending = (await detail(request, session.id)).questions![0];
  await composer(page).fill('A separate follow-up draft'); await select(page, 'SQLite');
  const other = await context.newPage();
  try {
    await open(other, session); await expect(question(other)).toBeVisible(); await select(other, 'PostgreSQL'); await answer(other, request, session);
    await expect(question(page)).toHaveCount(0); expect(await composer(page).inputValue()).toBe('A separate follow-up draft');
    const stale = await request.post(`/api/sessions/${session.id}/questions/${pending.id}/answer`, { data: { kind: 'option', optionId: 'sqlite' } }); expect(stale.status()).toBe(409);
    const state = await detail(request, session.id); const answers = state.messages.filter(message => message.role === 'tool');
    expect(answers).toHaveLength(1); expect(JSON.parse(answers[0].content).answer.optionId).toBe('postgres');
  } finally { await other.close(); }
});

test('Stop response cancels an unanswered question, holds queued work, and never executes the later write', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); const before = await calls(request);
  await ask(page, request, session, 'ask fixture question then write'); const pending = (await detail(request, session.id)).questions![0];
  await composer(page).fill('A separate queued follow-up');
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await expect.poll(async () => (await detail(request, session.id)).queue?.items.length).toBe(1);
  await question(page).getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(question(page)).toHaveCount(0); await expect.poll(async () => (await detail(request, session.id)).session.status).toBe('idle');
  const stopped = await detail(request, session.id); expect(stopped.queue).toMatchObject({ paused: true, items: [{ content: 'A separate queued follow-up' }] });
  expect(await calls(request)).toBe(before + 1); await expect(readFile(join(workspace, 'answered.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await request.post(`/api/sessions/${session.id}/questions/${pending.id}/answer`, { data: { kind: 'option', optionId: 'sqlite' } })).status()).toBe(409);
  await page.reload(); await expect(question(page)).toHaveCount(0); expect(await calls(request)).toBe(before + 1);
});

test('a failed answer submission keeps the selected reply and can be retried without losing the composer draft', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await ask(page, request, session);
  await composer(page).fill('Preserve my separate task draft'); await select(page, 'Custom reply');
  await question(page).getByRole('textbox', { name: 'Custom reply', exact: true }).fill('Keep the database local.');
  const pattern = `**/sessions/${session.id}/questions/*/answer`;
  await page.route(pattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary answer service failure' }) }));
  await question(page).getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(question(page).getByRole('alert')).toContainText('Temporary answer service failure');
  await expect(question(page).getByRole('textbox', { name: 'Custom reply', exact: true })).toHaveValue('Keep the database local.');
  await expect(composer(page)).toHaveValue('Preserve my separate task draft');
  const pending = await detail(request, session.id); expect(pending.questions).toHaveLength(1); expect(pending.messages.filter(message => message.role === 'tool')).toEqual([]);
  await page.unroute(pattern); await answer(page, request, session);
  const results = (await detail(request, session.id)).messages.filter(message => message.role === 'tool'); expect(results).toHaveLength(1);
  await expect(composer(page)).toHaveValue('Preserve my separate task draft');
});

test('forked and imported answered questions remain inert transcripts', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await ask(page, request, session);
  await select(page, 'SQLite'); await answer(page, request, session);
  const completed = await detail(request, session.id), count = await calls(request);
  const forkedResponse = await request.post(`/api/sessions/${session.id}/fork`, { data: {} }); expect(forkedResponse.status()).toBe(201);
  const forked: Session = await forkedResponse.json(); sessions.push(forked);
  await open(page, forked); await expect(question(page)).toHaveCount(0); expect((await detail(request, forked.id)).questions).toEqual([]);
  const exported = await (await request.get(`/api/sessions/${session.id}/export`)).json();
  const importedResponse = await request.post('/api/sessions/import', { data: exported }); expect(importedResponse.status()).toBe(201);
  const imported: Session = await importedResponse.json(); sessions.push(imported);
  await open(page, imported); await expect(question(page)).toHaveCount(0); expect((await detail(request, imported.id)).questions).toEqual([]);
  expect(completed.messages.some(message => message.toolCalls?.some(tool => tool.name === 'ask_user'))).toBe(true);
  expect(await calls(request)).toBe(count);
});

test('switching sessions while an answer response is delayed cannot overwrite another draft or view', async ({ page, request }) => {
  const first = await create(request, { title: 'Question first session' }), second = await create(request, { title: 'Question second session' });
  await open(page, second); await composer(page).fill('Second session draft stays here');
  await open(page, first); await ask(page, request, first); await select(page, 'SQLite');
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { reached = resolve; });
  await page.route(`**/sessions/${first.id}/questions/*/answer`, async route => {
    const result = await route.fetch(); reached(); await gate; await route.fulfill({ response: result });
  });
  try {
    await question(page).getByRole('button', { name: 'Submit answer', exact: true }).click(); await intercepted;
    await page.getByRole('button', { name: 'Question second session', exact: true }).click();
    await expect(composer(page)).toHaveValue('Second session draft stays here');
    release(); await expect.poll(async () => (await detail(request, first.id)).session.status).toBe('idle');
    await expect(page).toHaveURL(new RegExp(second.id)); await expect(question(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue('Second session draft stays here');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('mobile question controls fit, and undo/redo restores the answered history without reviving a question', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await create(request); await open(page, session); const before = await calls(request);
  await ask(page, request, session); await select(page, 'Custom reply');
  await question(page).getByRole('textbox', { name: 'Custom reply', exact: true }).fill('Use SQLite for the first version.');
  await question(page).getByRole('button', { name: 'Submit answer', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/questions-mobile.png', fullPage: true, animations: 'disabled' });
  await answer(page, request, session);
  const original = await detail(request, session.id); const checkpointId = original.history!.undoId;
  expect((await request.post(`/api/sessions/${session.id}/history/undo`, { data: { checkpointId } })).status()).toBe(200);
  await page.reload(); await expect(question(page)).toHaveCount(0); expect((await detail(request, session.id)).messages).toEqual([]);
  expect((await request.post(`/api/sessions/${session.id}/history/redo`, { data: { checkpointId } })).status()).toBe(200);
  await page.reload(); await expect(question(page)).toHaveCount(0); expect((await detail(request, session.id)).messages).toEqual(original.messages);
  expect(await calls(request)).toBe(before + 2);
});
