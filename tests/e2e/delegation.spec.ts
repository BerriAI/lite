import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from './fixtures';
import type { Session, SessionDetail } from '../../shared/types';
import type { DelegationSummary } from '../../shared/delegation';

async function expandSteps(page: Page) { const log = page.locator('.conversation-shell').first().locator(':scope > .conversation-scroll > .conversation-content > article > .message-body > .work-log').last(); await expect(log).toBeVisible(); if (await log.getAttribute('open') === null) await log.locator(':scope > summary').click(); }
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Litespeed', exact: true });
const taskCard = (page: Page) => page.getByRole('region', { name: 'Research task', exact: true, includeHidden: true });
const transcript = (page: Page) => page.getByRole('region', { name: 'Research transcript', exact: true });
const permission = (page: Page) => page.getByRole('region', { name: 'Permission requested', exact: true });
let workspace: string, sessions: Session[], browserErrors: string[];
const fixtureText = 'RESEARCH_FILE_VERIFIED: this project uses a local SQLite database.\n';

test.beforeEach(async ({ page }) => {
  browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-delegation-browser-'))); sessions = [];
  await writeFile(join(workspace, 'research.txt'), fixtureText);
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) {
    await request.post(`/api/sessions/${session.id}/cancel`, { data: {} });
    await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/);
  }
  await request.post('/fixture/delegations/release', { data: {} });
  await expect.poll(async () => (await fixture(request)).pending).toBe(0);
  await rm(workspace, { recursive: true, force: true });
  expect(browserErrors).toEqual([]);
});
async function create(request: APIRequestContext, options: Record<string, unknown> = {}) {
  const response = await request.post('/api/sessions', { data: { title: 'Research workflow', workspace, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask', ...options } });
  expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session;
}
async function detail(request: APIRequestContext, session: Session): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${session.id}`); expect(response.ok()).toBe(true); return response.json();
}
async function done(request: APIRequestContext, session: Session) {
  await expect.poll(async () => (await detail(request, session)).session.status).not.toMatch(/running|waiting/); return detail(request, session);
}
async function fixture(request: APIRequestContext): Promise<{ pending: number; requests: { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }[] }> {
  return (await request.get('/fixture/delegations')).json();
}
async function calls(request: APIRequestContext, session: Session) {
  return (await fixture(request)).requests.filter(call => call.messages.some(message => message.role === 'user' && String(message.content).includes(session.id)));
}
async function latest(request: APIRequestContext, session: Session): Promise<DelegationSummary> {
  await expect.poll(async () => (await detail(request, session)).delegations?.length ?? 0).toBe(1);
  return (await detail(request, session)).delegations![0];
}
const bound = (session: Session, delegation: DelegationSummary) => `/api/sessions/${session.id}/delegations/${delegation.id}`;
async function child(request: APIRequestContext, session: Session, delegation: DelegationSummary): Promise<SessionDetail> {
  const response = await request.get(bound(session, delegation)); expect(response.ok()).toBe(true); return response.json();
}
async function open(page: Page, session: Session) { await page.goto(`/#session/${session.id}`); await expect(composer(page)).toBeVisible(); }
async function send(page: Page, session: Session, flags = '') {
  await composer(page).fill(`DELEGATE_BROWSER ${session.id} ${flags}`);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await accepted).status()).toBe(202);
}
async function approve(page: Page) { await expect(permission(page)).toBeVisible(); await expect(permission(page)).toContainText('task'); await permission(page).getByRole('button', { name: 'Allow once', exact: true }).click(); }
async function waitHeld(request: APIRequestContext, session: Session) { const delegation = await latest(request, session); await expect.poll(async () => (await fixture(request)).pending).toBe(1); return delegation; }
async function assertUnchanged() { expect(await readFile(join(workspace, 'research.txt'), 'utf8')).toBe(fixtureText); await expect(readFile(join(workspace, 'child-forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); }

for (const mode of ['build', 'plan'] as const) test(`${mode} requires deliberate task permission and records an independent real read-only transcript`, async ({ page, request }) => {
  const session = await create(request, { mode }); await open(page, session); await send(page, session);
  await expect(permission(page)).toBeVisible(); expect(await calls(request, session)).toHaveLength(1); expect((await detail(request, session)).delegations ?? []).toEqual([]);
  await approve(page); const completed = await done(request, session), delegation = await latest(request, session), research = await child(request, session, delegation);
  expect(delegation.status).toBe('completed'); expect(research.session.id).not.toBe(session.id);
  expect(research.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.name)).toEqual(['read_file']);
  expect(research.messages.some(message => message.role === 'tool' && message.content.includes('RESEARCH_FILE_VERIFIED'))).toBe(true);
  expect(completed.messages.filter(message => message.role === 'tool')).toHaveLength(1); expect(await calls(request, session)).toHaveLength(4);
  await expect(taskCard(page)).toContainText('Inspect fixture project'); await expandSteps(page);
  await expect(transcript(page)).toContainText('RESEARCH_FILE_VERIFIED'); await expect(transcript(page).getByRole('textbox', { name: 'Message Litespeed', exact: true })).toHaveCount(0);
  await expect(transcript(page).getByRole('button', { name: 'Fork session', exact: true })).toHaveCount(0); await assertUnchanged();
});

test('denying delegation creates no child and sends no child model request', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await send(page, session); await expect(permission(page)).toBeVisible();
  await permission(page).getByRole('button', { name: 'Deny', exact: true }).click(); const result = await done(request, session);
  expect(result.delegations ?? []).toEqual([]); expect(await calls(request, session)).toHaveLength(2); await expect(taskCard(page)).toHaveCount(0); await assertUnchanged();
});

for (const flag of ['FORCE_WRITE', 'FORCE_NESTED', 'FORCE_QUESTION']) test(`automatic approval cannot widen child authority (${flag})`, async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session, flag); await done(request, session);
  const delegation = await latest(request, session), research = await child(request, session, delegation);
  const childCalls = (await calls(request, session)).filter(call => call.messages.some(message => message.role === 'user' && String(message.content).includes('DELEGATE_CHILD')));
  expect(childCalls.length).toBeGreaterThan(0);
  for (const call of childCalls) for (const tool of call.tools) expect(['read_file', 'view_image', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_read', 'history_search', 'tool_output_page']).toContain(tool.function.name);
  expect(research.messages.flatMap(message => message.toolCalls ?? []).some(tool => tool.status === 'completed')).toBe(false);
  expect(research.questions ?? []).toEqual([]); expect(research.delegations ?? []).toEqual([]); await expect(permission(page)).toHaveCount(0); await assertUnchanged();
});

test('streamed child progress survives parent reload without clearing the draft or replaying research', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session, 'HOLD_CHILD'); const delegation = await waitHeld(request, session);
  await expandSteps(page); await expect(transcript(page)).toContainText('Researcher is reviewing');
  await composer(page).fill('A separate draft survives research.');
  const before = await calls(request, session); await page.reload(); await expect(composer(page)).toHaveValue('A separate draft survives research.');
  expect((await latest(request, session)).id).toBe(delegation.id); expect(await calls(request, session)).toHaveLength(before.length);
  await expandSteps(page); await expect(transcript(page)).toContainText('Researcher is reviewing');
  await request.post('/fixture/delegations/release', { data: {} }); await done(request, session); await expandSteps(page); await expect(transcript(page)).toContainText('RESEARCH_FILE_VERIFIED');
  await expect(composer(page)).toHaveValue('A separate draft survives research.');
  expect(await calls(request, session)).toHaveLength(4); await assertUnchanged();
});

test('Cancel task stops only the researcher, records one cancelled result and holds queued follow-ups', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session, 'HOLD_CHILD'); const delegation = await waitHeld(request, session);
  expect((await request.post(`/api/sessions/${session.id}/queue`, { data: { content: 'Do not run this queued follow-up automatically.' } })).status()).toBe(202);
  await expandSteps(page); await taskCard(page).getByRole('button', { name: 'Cancel task', exact: true }).click(); const result = await done(request, session);
  expect((await latest(request, session)).status).toBe('cancelled'); expect(result.queue).toMatchObject({ paused: true, items: [{ content: 'Do not run this queued follow-up automatically.' }] });
  expect(result.messages.filter(message => message.role === 'tool' && message.toolCallId === delegation.toolCallId)).toHaveLength(1);
  expect(result.messages.at(-1)?.role).toBe('assistant'); expect(await calls(request, session)).toHaveLength(4);
  const again = await request.post(bound(session, delegation) + '/cancel', { data: {} }); expect(again.ok()).toBe(true); expect(await calls(request, session)).toHaveLength(4); await assertUnchanged();
});

test('Stop generation cancels descendants before the root becomes idle, with no parent continuation', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session, 'HOLD_CHILD'); await waitHeld(request, session);
  await page.getByRole('button', { name: 'Stop generation', exact: true }).click(); await done(request, session);
  expect((await latest(request, session)).status).toBe('cancelled'); expect((await fixture(request)).pending).toBe(0); expect(await calls(request, session)).toHaveLength(3);
  await page.reload(); expect(await calls(request, session)).toHaveLength(3); await assertUnchanged();
});

test('a failed researcher is visible and is not silently retried', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session, 'CHILD_FAILURE'); const result = await done(request, session);
  expect((await latest(request, session)).status).toBe('failed'); expect(await calls(request, session)).toHaveLength(3); await expect(taskCard(page)).toContainText(/failed/i);
  expect(result.messages.filter(message => message.role === 'tool')).toHaveLength(1); await assertUnchanged();
});

test('undo and redo restore exact research links and results without replay; fork and import retain only inert text', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session); const completed = await done(request, session), delegation = await latest(request, session);
  const checkpointId = completed.history!.undoId, before = await calls(request, session);
  expect((await request.post(`/api/sessions/${session.id}/history/undo`, { data: { checkpointId } })).ok()).toBe(true);
  expect((await detail(request, session)).messages).toEqual([]); await expect(taskCard(page)).toHaveCount(0);
  expect((await request.post(`/api/sessions/${session.id}/history/redo`, { data: { checkpointId } })).ok()).toBe(true);
  expect((await detail(request, session)).messages).toEqual(completed.messages); expect((await latest(request, session)).id).toBe(delegation.id); await expandSteps(page); await expect(taskCard(page)).toBeVisible();
  expect(await calls(request, session)).toHaveLength(before.length);
  const fork = await request.post(`/api/sessions/${session.id}/fork`, { data: {} }); expect(fork.status()).toBe(201); const forked: Session = await fork.json(); sessions.push(forked);
  const exported = await (await request.get(`/api/sessions/${session.id}/export`)).json();
  const imported = await request.post('/api/sessions/import', { data: exported }); expect(imported.status()).toBe(201); const copy: Session = await imported.json(); sessions.push(copy);
  for (const inert of [forked, copy]) { await open(page, inert); await expect(taskCard(page)).toHaveCount(0); expect((await detail(request, inert)).delegations ?? []).toEqual([]); }
  expect(await calls(request, session)).toHaveLength(before.length); await assertUnchanged();
});

test('private children are hidden and every public mutation is rejected before execution', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }), unrelated = await create(request, { title: 'Unrelated research parent' });
  await open(page, session); await send(page, session, 'HOLD_CHILD'); const delegation = await waitHeld(request, session), id = delegation.childSessionId;
  const listed = await (await request.get('/api/sessions')).json(); expect(JSON.stringify(listed)).not.toContain(id);
  expect((await request.get(`/api/sessions/${id}`)).status()).toBe(404);
  expect((await request.get(bound(unrelated, delegation))).status()).toBe(404);
  expect((await request.post(bound(unrelated, delegation) + '/cancel', { data: {} })).status()).toBe(404);
  for (const suffix of ['/messages', '/queue', '/queue/resume', '/history/undo', '/fork', '/cancel']) {
    expect((await request.post(`/api/sessions/${id}${suffix}`, { data: { content: 'Forbidden direct child input', attachments: [{ path: '/outside/workspace' }] } })).status()).toBe(409);
  }
  expect((await request.patch(`/api/sessions/${id}`, { data: { mode: 'build', permissionMode: 'auto' } })).status()).toBe(409);
  expect((await request.delete(`/api/sessions/${id}`)).status()).toBe(409);
  expect((await latest(request, session)).status).toBe('running'); await page.goto(`/#session/${id}`); await expect(composer(page)).toHaveCount(0); expect(await calls(request, session)).toHaveLength(3);
});

test('named profiles exclude task while explicitly selected instruction skills remain pinned in a child', async ({ page, request }) => {
  await mkdir(join(workspace, '.litespeed', 'skills', 'research'), { recursive: true });
  await writeFile(join(workspace, '.litespeed', 'profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'inspector', name: 'Inspector', tools: ['read_file'] }], skills: [{ id: 'research', name: 'Research checklist' }] }));
  await writeFile(join(workspace, '.litespeed', 'skills', 'research', 'SKILL.md'), 'DELEGATION_SKILL_PINNED: Report facts from the actual file.');
  const catalog = await (await request.get('/api/profiles', { params: { workspace } })).json();
  const profiled = await create(request, { profile: { profileId: 'inspector', skillIds: [], catalogRevision: catalog.revision }, permissionMode: 'auto' });
  await open(page, profiled); await send(page, profiled, 'ADVERTISE_ONLY'); expect((await done(request, profiled)).messages.at(-1)?.content).toContain('unavailable');
  const skilled = await create(request, { profile: { profileId: null, skillIds: ['research'], catalogRevision: catalog.revision }, permissionMode: 'auto' });
  await writeFile(join(workspace, '.litespeed', 'skills', 'research', 'SKILL.md'), 'UNPINNED_REPLACEMENT must not silently activate.');
  await open(page, skilled); await send(page, skilled); await done(request, skilled);
  const childRequests = (await calls(request, skilled)).filter(call => call.messages.some(message => message.role === 'user' && String(message.content).includes('DELEGATE_CHILD')));
  expect(childRequests.length).toBe(2); for (const call of childRequests) { const system = call.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n'); expect(system).toContain('DELEGATION_SKILL_PINNED'); expect(system).not.toContain('UNPINNED_REPLACEMENT'); }
  await assertUnchanged();
});

test('a pending task inherits accepted provider and project guidance rather than later settings or file changes', async ({ page, request }) => {
  await writeFile(join(workspace, 'AGENTS.md'), 'ACCEPTED_PROJECT_GUIDANCE: inspect actual local files.');
  const settings = await (await request.get('/api/settings')).json(), session = await create(request); await open(page, session); await send(page, session); await expect(permission(page)).toBeVisible();
  try {
    await writeFile(join(workspace, 'AGENTS.md'), 'LATER_PROJECT_GUIDANCE: must not alter this accepted researcher.');
    expect((await request.patch('/api/settings', { data: { providers: settings.providers.map((provider: { id: string }) => provider.id === 'fixture' ? { ...provider, baseUrl: 'http://127.0.0.1:1' } : provider) } })).ok()).toBe(true);
    await approve(page); const completed = await done(request, session); expect(completed.session.status).toBe('idle'); expect((await latest(request, session)).status).toBe('completed');
    const requests = await calls(request, session); expect(requests).toHaveLength(4);
    for (const call of requests) { const system = call.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n'); expect(system).toContain('ACCEPTED_PROJECT_GUIDANCE'); expect(system).not.toContain('LATER_PROJECT_GUIDANCE'); }
  } finally { expect((await request.patch('/api/settings', { data: { providers: settings.providers } })).ok()).toBe(true); }
});

test('a late child transcript response cannot replace another session or clear its draft', async ({ page, request }) => {
  const first = await create(request, { title: 'First researcher', permissionMode: 'auto' }), second = await create(request, { title: 'Other research session' });
  await open(page, second); await composer(page).fill('Keep the other session draft.'); await open(page, first); await send(page, first); await done(request, first); const delegation = await latest(request, first);
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${bound(first, delegation)}`, async route => { const response = await route.fetch(); reached = true; await gate; await route.fulfill({ response }); });
  try {
    await expandSteps(page); await expect(transcript(page)).toBeVisible(); await expect.poll(() => reached).toBe(true);
    await page.getByRole('button', { name: 'Other research session', exact: true }).click();
    await expect(composer(page)).toHaveValue('Keep the other session draft.'); release(); await expect(transcript(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(second.id)); await expect(composer(page)).toHaveValue('Keep the other session draft.');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('another tab can cancel one researcher without duplicating results or losing either draft', async ({ page, context, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await send(page, session, 'HOLD_CHILD'); const delegation = await waitHeld(request, session);
  await composer(page).fill('Original tab research draft.'); const other = await context.newPage();
  try {
    await open(other, session); await expandSteps(other); await other.getByRole('region', { name: 'Research task', exact: true, includeHidden: true }).getByRole('button', { name: 'Cancel task', exact: true }).click();
    const completed = await done(request, session); await expect(taskCard(page)).toContainText(/cancelled/i); await expect(composer(page)).toHaveValue('Original tab research draft.');
    expect(completed.messages.filter(message => message.role === 'tool' && message.toolCallId === delegation.toolCallId)).toHaveLength(1); expect(await calls(request, session)).toHaveLength(4);
    await page.reload(); await expect(composer(page)).toHaveValue('Original tab research draft.'); expect(await calls(request, session)).toHaveLength(4);
  } finally { await other.close(); }
});

test('desktop and mobile research transcript controls fit without horizontal overflow', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await page.setViewportSize({ width: 1440, height: 1000 }); await open(page, session); await send(page, session, 'HOLD_CHILD'); await waitHeld(request, session);
  await expandSteps(page); await expect(transcript(page)).toContainText('Researcher is reviewing');
  await expect(transcript(page).locator('.markdown').last()).toHaveCSS('font-style', 'italic');
  await expect(page.getByRole('button', { name: 'Open transcript', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: 'test-results/delegation-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/delegation-mobile.png', fullPage: true, animations: 'disabled' });
  await request.post('/fixture/delegations/release', { data: {} }); await done(request, session); await expandSteps(page); await expect(transcript(page)).toContainText('RESEARCH_FILE_VERIFIED');
});
