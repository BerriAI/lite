import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Session, SessionDetail } from '../../shared/types';
import type { DelegationSummary } from '../../shared/delegation';

async function expandSteps(page: Page) { const log = page.locator('.conversation-content > article .work-log').last(); await expect(log).toBeVisible(); if (await log.getAttribute('open') === null) await log.locator(':scope > summary').click(); }
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Lite', exact: true });
const sidekickCard = (page: Page) => page.getByRole('region', { name: 'Sidekick task', exact: true, includeHidden: true });
const transcript = (page: Page) => page.getByRole('dialog', { name: 'Sidekick transcript', exact: true });
const permission = (page: Page) => page.getByRole('region', { name: 'Permission requested', exact: true });
let workspace: string, sessions: Session[], browserErrors: string[];

test.beforeEach(async ({ page }) => {
  browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-sidekick-browser-'))); sessions = [];
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
  const response = await request.post('/api/sessions', { data: { title: 'Sidekick workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask', architecture: { kind: 'sidekick-fusion', sidekick: { providerId: 'fixture', model: 'test-fast' } }, ...options } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function detail(request: APIRequestContext, session: Session): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${session.id}`); expect(response.ok()).toBe(true); return response.json();
}
async function done(request: APIRequestContext, session: Session) {
  await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/); return detail(request, session);
}
async function calls(request: APIRequestContext, session: Session) {
  const fixture: { requests: { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }[] } = await (await request.get('/fixture/delegations')).json();
  return fixture.requests.filter(call => call.messages.some(message => message.role === 'user' && String(message.content).includes(session.id)));
}
async function latest(request: APIRequestContext, session: Session): Promise<DelegationSummary> {
  await expect.poll(async () => (await detail(request, session)).delegations?.length ?? 0).toBe(1);
  return (await detail(request, session)).delegations![0];
}
async function open(page: Page, session: Session) { await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible(); }
async function send(page: Page, session: Session, flags = '') {
  await composer(page).fill(`SIDEKICK_BROWSER ${session.id} ${flags}`);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await accepted).status()).toBe(202);
}
async function approve(page: Page, text: string | RegExp) {
  await expect(permission(page)).toBeVisible(); await expect(permission(page)).toContainText(text);
  await permission(page).getByRole('button', { name: 'Allow once', exact: true }).click();
}

test('the sidekick writes behind parent-surfaced approvals and one persistent child spans turns', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await send(page, session);
  // Launch approval, then the sidekick's own write surfaces in THIS parent session.
  await approve(page, 'sidekick');
  await approve(page, /sidekick/i); await expect(permission(page)).toHaveCount(0, { timeout: 10_000 });
  const first = await done(request, session), delegation = await latest(request, session);
  expect(delegation.role).toBe('sidekick'); expect(delegation.status).toBe('completed');
  expect(await readFile(join(workspace, 'sidekick-note.txt'), 'utf8')).toBe('sidekick turn 1');
  expect(first.messages.some(message => message.role === 'tool' && message.content.includes('Sidekick report for turn 1'))).toBe(true);
  // The card and transcript are labeled as sidekick surfaces, on the sidekick model.
  await expect(sidekickCard(page)).toContainText('Write the fixture note');
  await expect(sidekickCard(page).locator('strong')).toHaveAttribute('title', /Sidekick/);
  const childCalls = (await calls(request, session)).filter(call => call.messages.some(message => message.role === 'user' && String(message.content).includes('SIDEKICK_CHILD')));
  expect(childCalls.length).toBeGreaterThan(0); for (const call of childCalls) expect(call.model).toBe('test-fast');
  await expandSteps(page); await sidekickCard(page).getByRole('button', { name: 'Open transcript', exact: true }).click();
  await expect(transcript(page)).toContainText('Sidekick report for turn 1');
  await expect(transcript(page).getByRole('textbox', { name: 'Message Lite', exact: true })).toHaveCount(0);
  await transcript(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  // Second turn: the SAME child session continues — persistent context, not a fresh helper.
  await send(page, session, 'second');
  await approve(page, 'sidekick'); await approve(page, /sidekick/i); await done(request, session);
  const after = (await detail(request, session)).delegations!;
  expect(after).toHaveLength(1); expect(after[0].id).toBe(delegation.id); expect(after[0].childSessionId).toBe(delegation.childSessionId);
  expect(await readFile(join(workspace, 'sidekick-note.txt'), 'utf8')).toBe('sidekick turn 2');
  const final = (await calls(request, session)).filter(call => call.messages.some(message => message.role === 'user' && String(message.content).includes('SIDEKICK_CHILD'))).at(-1)!;
  expect(final.messages.filter(message => message.role === 'user')).toHaveLength(2);
});

test('the sidekick tool is advertised only when the architecture is selected', async ({ page, request }) => {
  const plain = await create(request, { architecture: null, permissionMode: 'auto' });
  await open(page, plain); await send(page, plain, 'ADVERTISE_ONLY');
  expect((await done(request, plain)).messages.at(-1)?.content).toContain('unavailable');
  const fusion = await create(request, { permissionMode: 'auto' });
  await open(page, fusion); await send(page, fusion, 'ADVERTISE_ONLY');
  expect((await done(request, fusion)).messages.at(-1)?.content).toContain('Sidekick tool is available');
});
