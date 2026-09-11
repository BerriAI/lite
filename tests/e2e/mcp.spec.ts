import { mkdtemp, readFile, writeFile, rename, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { McpServerConfig, Session, SessionDetail, Settings } from '../../shared/types';
import type { McpServerStatus } from '../../shared/mcp';

let directory: string, controlPath: string, journalPath: string, settings: Settings, sessions: Session[], control: Record<string, unknown>;
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Litespeed', exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const card = (page: Page) => panel(page).getByRole('region', { name: 'MCP server demo', exact: true });
// advertise:true — these browser scenarios exercise DIRECT advertisement, which
// Phase 4.6 made per-server opt-in (default routes via the capability gateway).
const config = (identity = 'original'): McpServerConfig => ({ command: process.execPath, args: [resolve('scripts/mcp-e2e-fixture.mjs'), controlPath, journalPath, identity], enabled: true, advertise: true });
async function journal(): Promise<{ type: string; identity: string; name?: string; pid: number; version?: number }[]> { try { return (await readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
async function changeControl(patch: Record<string, unknown>) { control = { ...control, ...patch }; await writeFile(controlPath + '.next', JSON.stringify(control)); await rename(controlPath + '.next', controlPath); }
async function status(request: APIRequestContext): Promise<{ servers: McpServerStatus[]; configRevision: string }> { const response = await request.get('/api/mcp'); expect(response.ok()).toBe(true); return response.json(); }
async function current(request: APIRequestContext) { const result = await status(request); return result.servers.find(server => server.name === 'demo')!; }
async function configure(request: APIRequestContext, servers: Record<string, McpServerConfig>) {
  const latest = await (await request.get('/api/settings')).json();
  const response = await request.patch('/api/settings', { data: { mcpServers: servers, expectedMcpConfigRevision: latest.mcpConfigRevision } });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
async function lifecycle(request: APIRequestContext, action: 'refresh' | 'reconnect') {
  const latest = await status(request), server = latest.servers.find(server => server.name === 'demo')!;
  const response = await request.post(`/api/mcp/demo/${action}`, { data: { expectedRevision: server.revision, expectedConfigRevision: latest.configRevision } });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
async function detail(request: APIRequestContext, id: string): Promise<SessionDetail> { const response = await request.get(`/api/sessions/${id}`); expect(response.ok()).toBe(true); return response.json(); }
async function create(request: APIRequestContext, input: Record<string, unknown> = {}) { const response = await request.post('/api/sessions', { data: { workspace: directory, title: 'MCP lifecycle verification', providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask', ...input } }); expect(response.status()).toBe(201); const session: Session = await response.json(); sessions.push(session); return session; }
async function open(page: Page, session?: Session) { await page.goto(session ? `/#session/${session.id}` : '/'); await expect(composer(page)).toBeVisible(); }
async function integrations(page: Page) { const navigation = page.getByRole('button', { name: 'Open navigation', exact: true }); if (await navigation.isVisible() && await navigation.getAttribute('aria-expanded') !== 'true') await navigation.click(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await panel(page).getByRole('button', { name: 'Integrations', exact: true }).click(); await expect(card(page)).toBeVisible(); }
async function closeSettings(page: Page) { await panel(page).getByRole('button', { name: 'Close dialog', exact: true }).click(); }
async function connect(page: Page, request: APIRequestContext) { await card(page).getByRole('button', { name: 'Connect', exact: true }).click(); await expect.poll(async () => (await current(request)).status).toBe('connected'); await expect(card(page)).toContainText(/connected/i); }
async function send(page: Page, session: Session, prompt: string) { await composer(page).fill(prompt); const response = page.waitForResponse(response => response.url().endsWith(`/sessions/${session.id}/messages`) && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); expect((await response).status()).toBe(202); }
async function done(request: APIRequestContext, session: Session) { await expect.poll(async () => (await detail(request, session.id)).session.status).not.toMatch(/running|waiting/); return detail(request, session.id); }

test.beforeEach(async ({ request }) => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-mcp-browser-'))); controlPath = join(directory, 'control.json'); journalPath = join(directory, 'journal.jsonl'); sessions = []; control = { version: 1 };
  await writeFile(controlPath, JSON.stringify(control)); settings = await (await request.get('/api/settings')).json(); await configure(request, { demo: config() });
});
test.afterEach(async ({ request }) => {
  for (const session of sessions) { await request.post(`/api/sessions/${session.id}/cancel`, { data: {} }); await done(request, session); }
  await configure(request, settings.mcpServers);
  const started = (await journal()).filter(entry => entry.type === 'started');
  await expect.poll(() => started.filter(entry => { try { process.kill(entry.pid, 0); return true; } catch { return false; } }).length).toBe(0);
  await rm(directory, { recursive: true, force: true });
});

test('status, settings, and model requests never implicitly start a configured MCP server', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await integrations(page);
  expect((await current(request)).status).toBe('disconnected'); await panel(page).getByRole('button', { name: 'Refresh status', exact: true }).click();
  expect(await journal()).toEqual([]); await closeSettings(page); await send(page, session, 'MCP_BROWSER no hidden connect'); const result = await done(request, session);
  expect(result.messages.at(-1)?.content).toContain('No connected MCP tool'); expect(await journal()).toEqual([]);
});

test('an explicit connection discovers a real subprocess tool and still asks before execution', async ({ page, request }) => {
  const session = await create(request); await open(page, session); await composer(page).fill('My separate MCP draft.'); await integrations(page); await connect(page, request);
  expect((await journal()).filter(entry => entry.type === 'started')).toHaveLength(1); expect((await current(request)).tools[0]?.remoteName).toBe('echo'); await closeSettings(page);
  await expect(composer(page)).toHaveValue('My separate MCP draft.'); await send(page, session, 'MCP_BROWSER approved call'); await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible();
  expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(0); await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  const result = await done(request, session); expect(result.messages.some(message => message.role === 'tool' && message.content.includes('original: MCP_BROWSER approved call'))).toBe(true);
  expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(1); await composer(page).fill('Keep my MCP draft on reload.'); await page.reload(); await expect(composer(page)).toHaveValue('Keep my MCP draft on reload.');
});

test('tool list notifications invalidate catalogs until an explicit refresh', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await integrations(page); await connect(page, request); const before = await current(request);
  await changeControl({ version: 2, toolName: 'new_echo' }); await expect.poll(async () => (await current(request)).status).toBe('stale');
  expect((await journal()).filter(entry => entry.type === 'list')).toHaveLength(1); await closeSettings(page); await send(page, session, 'MCP_BROWSER stale tools omitted'); await done(request, session);
  expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(0); await integrations(page); await card(page).getByRole('button', { name: 'Refresh tools', exact: true }).click();
  await expect.poll(async () => (await current(request)).status).toBe('connected'); expect((await current(request)).revision).not.toBe(before.revision); expect((await current(request)).tools[0].remoteName).toBe('new_echo');
  await closeSettings(page); await send(page, session, 'MCP_BROWSER refreshed tools execute'); await done(request, session); expect((await journal()).filter(entry => entry.type === 'call').map(entry => entry.name)).toEqual(['new_echo']);
});

test('a pending approval cannot route an old advertised tool to replacement executable configuration', async ({ page, request }) => {
  const session = await create(request); await lifecycle(request, 'reconnect'); await open(page, session); await send(page, session, 'MCP_BROWSER stale pending approval');
  await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible(); await configure(request, { demo: config('replacement') }); await lifecycle(request, 'reconnect');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click(); const result = await done(request, session);
  expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(0); expect(result.messages.flatMap(message => message.toolCalls ?? []).some(tool => tool.name.startsWith('mcp_') && tool.status === 'completed')).toBe(false);
  expect(JSON.stringify(result.messages)).toMatch(/changed|stale|new turn|unavailable/i);
});

test('disconnect is visible and reconnect is explicit without replaying calls', async ({ page, request }) => {
  const session = await create(request, { permissionMode: 'auto' }); await open(page, session); await integrations(page); await connect(page, request); await closeSettings(page);
  await send(page, session, 'MCP_BROWSER before disconnect'); await done(request, session); await changeControl({ exit: true });
  await expect.poll(async () => (await current(request)).status).toMatch(/disconnected|error/); await changeControl({ exit: false }); await integrations(page);
  await card(page).getByRole('button', { name: /^(Connect|Reconnect)$/ }).click(); await expect.poll(async () => (await current(request)).status).toBe('connected');
  expect((await journal()).filter(entry => entry.type === 'started')).toHaveLength(2); expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(1);
});

test('unsaved MCP JSON blocks lifecycle actions without losing provider credentials or the draft', async ({ page, request }) => {
  await open(page); await page.getByRole('button', { name: 'Settings', exact: true }).click(); const secretDraft = 'unsaved-local-fixture-key'; await panel(page).locator('input[type=password]').fill(secretDraft);
  await panel(page).getByRole('button', { name: 'Integrations', exact: true }).click(); const editor = panel(page).getByLabel('MCP servers', { exact: true });
  const changed = JSON.stringify({ demo: config('unreviewed') }, null, 2); await editor.fill(changed); await expect(card(page).getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Refresh status', exact: true }).click(); await expect(editor).toHaveValue(changed); expect(await journal()).toEqual([]);
  await panel(page).getByRole('button', { name: 'Providers', exact: true }).click(); await expect(panel(page).locator('input[type=password]')).toHaveValue(secretDraft);
  expect((await current(request)).status).toBe('disconnected');
});

test('a fresh status token cannot launch a server changed in another tab without review', async ({ page, request }) => {
  await open(page); await integrations(page); await configure(request, { demo: config('replacement') }); await panel(page).getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(card(page).getByRole('button', { name: 'Connect', exact: true })).toBeDisabled(); expect(await journal()).toEqual([]);
  await expect(panel(page)).toContainText(/saved.*changed|review.*configuration|configuration.*changed/i);
});

test('explicit saved-configuration review adopts a replacement without launching it', async ({ page, request }) => {
  await open(page); await integrations(page); await configure(request, { demo: config('reviewed-replacement') });
  await panel(page).getByRole('button', { name: 'Refresh status', exact: true }).click(); await expect(card(page).getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Review saved MCP configuration', exact: true }).click();
  await expect(panel(page).getByLabel('Saved MCP configuration preview', { exact: true })).toContainText('reviewed-replacement'); expect(await journal()).toEqual([]);
  await panel(page).getByRole('button', { name: 'Use reviewed configuration', exact: true }).click();
  await expect(panel(page).getByLabel('MCP servers', { exact: true })).toHaveValue(JSON.stringify({ demo: config('reviewed-replacement') }, null, 2));
  await expect(card(page).getByRole('button', { name: 'Connect', exact: true })).toBeEnabled(); expect(await journal()).toEqual([]);
  await connect(page, request); expect((await journal()).find(entry => entry.type === 'started')?.identity).toBe('reviewed-replacement');
});

test('a stale settings save preserves the editor and does not overwrite replacement configuration', async ({ page, request }) => {
  await open(page); await integrations(page); const edited = JSON.stringify({ demo: config('unsaved-editor') }, null, 2);
  await panel(page).getByLabel('MCP servers', { exact: true }).fill(edited); await configure(request, { demo: config('other-tab') });
  const response = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
  await panel(page).getByRole('button', { name: 'Save settings', exact: true }).click(); expect((await response).status()).toBe(409);
  await expect(panel(page).getByLabel('MCP servers', { exact: true })).toHaveValue(edited); expect(await journal()).toEqual([]);
  const saved = await (await request.get('/api/settings')).json(); expect(saved.mcpServers.demo.args.at(-1)).toBe('other-tab');
  await panel(page).getByRole('button', { name: 'Review saved MCP configuration', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Use reviewed configuration', exact: true })).toBeDisabled();
});

test('a pending approval becomes inert when the server announces a new tool catalog', async ({ page, request }) => {
  const session = await create(request); await lifecycle(request, 'reconnect'); await open(page, session); await send(page, session, 'MCP_BROWSER approval versus changed catalog');
  await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible(); await changeControl({ version: 2, toolName: 'changed_echo' });
  await expect.poll(async () => (await current(request)).status).toBe('stale'); await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  const result = await done(request, session); expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(0);
  expect((await journal()).filter(entry => entry.type === 'list')).toHaveLength(1); expect(JSON.stringify(result.messages)).toMatch(/changed|stale|new turn|unavailable/i);
});

test('a stale direct lifecycle request changes nothing and starts no process', async ({ request }) => {
  const before = await status(request); await configure(request, { demo: config('replacement') });
  const response = await request.post('/api/mcp/demo/reconnect', { data: { expectedRevision: before.servers[0].revision, expectedConfigRevision: before.configRevision } });
  expect(response.status()).toBe(409); expect((await current(request)).status).toBe('disconnected'); expect(await journal()).toEqual([]);
});

test('a catalog failure is visible and an explicit retry can recover', async ({ page, request }) => {
  await changeControl({ failList: true }); await open(page); await integrations(page); await card(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(async () => (await current(request)).status).toBe('error'); await expect(card(page)).toContainText(/failed|error|could not/i); expect((await current(request)).tools).toEqual([]);
  await changeControl({ failList: false }); await card(page).getByRole('button', { name: 'Reconnect', exact: true }).click(); await expect.poll(async () => (await current(request)).status).toBe('connected');
  expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(0);
});

test('Plan mode never advertises or invokes already-connected MCP tools', async ({ page, request }) => {
  await lifecycle(request, 'reconnect'); const session = await create(request, { mode: 'plan', permissionMode: 'auto' }); await open(page, session); await send(page, session, 'MCP_BROWSER read-only plan');
  const result = await done(request, session); expect(result.messages.at(-1)?.content).toContain('No connected MCP tool'); expect((await journal()).filter(entry => entry.type === 'call')).toHaveLength(0);
});

test('saving executable configuration does not connect until a separate explicit action', async ({ page, request }) => {
  await open(page); await integrations(page); await panel(page).getByLabel('MCP servers', { exact: true }).fill(JSON.stringify({ demo: config('saved') }, null, 2));
  await panel(page).getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(panel(page)).toHaveCount(0); expect(await journal()).toEqual([]);
  await integrations(page); await connect(page, request); expect((await journal()).find(entry => entry.type === 'started')?.identity).toBe('saved');
});

test('mobile integration controls and saved configuration fit without horizontal overflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page); await integrations(page); await connect(page, request);
  await card(page).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mcp-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: 'test-results/mcp-desktop.png', fullPage: true, animations: 'disabled' });
});
