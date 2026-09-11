import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from './fixtures';
import type { Message, Session, SessionDetail } from '../../shared/types';

const reply = 'Hello from Litespeed.\n\nYour workspace is ready. Here is a small example:\n\n```typescript\nconst answer = 42;\n```';
const reasoning = 'Checking the request and preparing a clear response.';
const toolReply = 'The file operation is complete. Check the activity card for its result.';

async function createSession(request: APIRequestContext, title: string): Promise<Session> {
  const response = await request.post('/api/sessions', { data: {
    title: `${title} ${randomUUID().slice(0, 8)}`, providerId: 'fixture', model: 'test-model', mode: 'build', permissionMode: 'ask',
  } });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function history(request: APIRequestContext, id: string): Promise<SessionDetail> {
  const response = await request.get(`/api/sessions/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function open(page: Page, session: Session) {
  await page.goto(`/#session/${session.id}`);
  await expect(page.getByRole('textbox', { name: 'Message Litespeed' })).toBeVisible();
  await expect(page.getByText('Connecting to live updates…', { exact: true })).toHaveCount(0);
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message Litespeed' }).fill(text);
  const response = page.waitForResponse(r => /\/api\/sessions\/[^/]+\/messages$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await response).status()).toBe(202);
}

async function completed(page: Page, request: APIRequestContext, id: string, userTurns: number) {
  await expect.poll(async () => {
    const detail = await history(request, id);
    return { status: detail.session.status, turns: detail.messages.filter(m => m.role === 'user').length };
  }).toEqual({ status: 'idle', turns: userTurns });
  await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(userTurns);
}

async function expectExactReply(page: Page, request: APIRequestContext, id: string) {
  const detail = await history(request, id);
  const assistants = detail.messages.filter(m => m.role === 'assistant');
  expect(assistants).toHaveLength(1);
  expect(assistants[0].content).toBe(reply);
  expect(assistants[0].reasoning).toBe(reasoning);
  const assistant = page.getByRole('article', { name: 'Assistant message' });
  await expect(assistant).toHaveCount(1);
  await expect(assistant.locator('.message-body > .markdown > p')).toHaveText([
    'Hello from Litespeed.', 'Your workspace is ready. Here is a small example:',
  ]);
  await expect(assistant.locator('.message-body > .markdown pre code')).toHaveText('const answer = 42;');
  await expect(assistant.locator('.message-body > .markdown')).toHaveCount(1);
  const workLog = assistant.locator('.work-log');
  if (await workLog.getAttribute('open') === null) await workLog.locator(':scope > summary').click();
  await expect(assistant.locator('.thinking-inline')).toHaveText(reasoning);
}

test('reloads a genuinely partial stream and finishes with exactly-once text and reasoning', async ({ page, request }) => {
  const session = await createSession(request, 'Mid-stream reload');
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await open(page, session);
  await send(page, 'slow response for reload coverage');
  await expect(page.getByRole('article', { name: 'Assistant message' })).toContainText('Hello from Litespeed.');
  const before = await history(request, session.id);
  expect(before.session.status).toBe('running');
  const partial = before.messages.find(m => m.role === 'assistant')!.content;
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(reply.length);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Litespeed' })).toBeVisible();
  await completed(page, request, session.id, 1);
  await expectExactReply(page, request, session.id);
  await page.reload();
  await expectExactReply(page, request, session.id);
  expect(browserErrors).toEqual([]);
});

test('keeps two concurrent session streams isolated when switching between them', async ({ page, context, request }) => {
  const first = await createSession(request, 'Isolation text');
  const second = await createSession(request, 'Isolation tool');
  const other = await context.newPage();
  try {
    await open(page, first);
    await open(other, second);
    await send(page, 'slow response for session alpha');
    await expect(page.getByRole('article', { name: 'Assistant message' })).toContainText('Hello from Litespeed.');
    await send(other, 'create fixture for session beta');
    await expect(other.getByRole('region', { name: 'Permission requested' })).toBeVisible();
    expect((await history(request, first.id)).session.status).toBe('running');

    // Switch the first tab onto the other live stream; a stale source must not leak text into it.
    await page.locator('.session-link').filter({ hasText: second.title }).click();
    await expect(page).toHaveURL(new RegExp(`#session/${second.id}$`));
    await expect(page.getByRole('article', { name: 'Your message' })).toHaveText('create fixture for session beta');
    await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Assistant message' })).not.toContainText('Hello from Litespeed.');
    await other.getByRole('button', { name: 'Deny', exact: true }).click();
    await completed(page, request, second.id, 1);
    await expect(page.getByRole('article', { name: 'Assistant message' }).last()).toContainText(toolReply);
    await expect(page.locator('.conversation-content')).not.toContainText('Your workspace is ready.');
    await expect(page.getByRole('region', { name: 'Permission requested' })).toHaveCount(0);

    await page.locator('.session-link').filter({ hasText: first.title }).click();
    await completed(page, request, first.id, 1);
    await expectExactReply(page, request, first.id);
    await expect(page.locator('.tool-card')).toHaveCount(0);
    await expect(page.locator('.conversation-content')).not.toContainText(toolReply);
    const a = await history(request, first.id), b = await history(request, second.id);
    expect(a.messages.every(m => m.sessionId === first.id)).toBe(true);
    expect(b.messages.every(m => m.sessionId === second.id)).toBe(true);
    expect(b.messages.flatMap(m => m.toolCalls ?? []).map(t => t.status)).toEqual(['denied']);
  } finally { await other.close(); }
});

test('forks at a completed message and continues without copying subsequent parent turns', async ({ page, request }) => {
  const parent = await createSession(request, 'Fork boundary');
  await open(page, parent);
  await send(page, 'The first parent turn');
  await completed(page, request, parent.id, 1);
  const firstHistory = await history(request, parent.id);
  const boundary = firstHistory.messages.find(m => m.role === 'assistant')!;
  await send(page, 'This later parent turn must not be forked');
  await completed(page, request, parent.id, 2);
  await expect(page.getByRole('article', { name: 'Assistant message' })).toHaveCount(2);

  const forkResponse = page.waitForResponse(r => r.url().endsWith(`/api/sessions/${parent.id}/fork`) && r.request().method() === 'POST');
  await page.getByRole('article', { name: 'Assistant message' }).first().getByRole('button', { name: 'Fork session at this message' }).click();
  const response = await forkResponse;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ messageId: boundary.id });
  const forked: Session = await response.json();
  await expect(page).toHaveURL(new RegExp(`#session/${forked.id}$`));
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveText('The first parent turn');
  await expect(page.getByRole('article', { name: 'Assistant message' })).toHaveCount(1);
  expect(forked.parentId).toBe(parent.id);
  expect(forked.workspace).toBe(parent.workspace);
  const initialFork = await history(request, forked.id);
  expect(initialFork.messages.map(m => [m.role, m.content])).toEqual(firstHistory.messages.map(m => [m.role, m.content]));

  await send(page, 'Continue only the fork');
  await completed(page, request, forked.id, 2);
  const original = await history(request, parent.id);
  const child = await history(request, forked.id);
  expect(original.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['The first parent turn', 'This later parent turn must not be forked']);
  expect(child.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['The first parent turn', 'Continue only the fork']);
  await expect(page.locator('.conversation-content')).not.toContainText('This later parent turn must not be forked');
  await page.reload();
  await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'Assistant message' }).last()).toContainText('Hello from Litespeed.');
});

test('exports through the browser and imports untrusted tool history without executing it', async ({ page, request }) => {
  const source = await createSession(request, 'Inert import');
  await open(page, source);
  await send(page, 'A conversation to export');
  await completed(page, request, source.id, 1);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('button', { name: 'Export session', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^litespeed-.*\.json$/);
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported: { session: Session; messages: Message[]; todos: unknown[] } = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.session.id).toBe(source.id);
  expect(exported.messages.map(m => m.content)).toEqual(['A conversation to export', reply]);

  const marker = `import-must-not-execute-${randomUUID()}.txt`;
  const fileUrl = `/api/file?${new URLSearchParams({ workspace: source.workspace, path: marker })}`;
  expect((await request.get(fileUrl)).ok()).toBe(false);
  const unsafe = {
    ...exported,
    session: { ...exported.session, workspace: '/untrusted/imported/workspace', permissionMode: 'auto', status: 'running' },
    messages: [...exported.messages, { id: randomUUID(), sessionId: source.id, role: 'assistant', content: 'Imported tool history is data, not a command.', createdAt: Date.now(), toolCalls: [{ id: randomUUID(), name: 'write_file', args: { path: marker, content: 'This must never be written.' }, status: 'pending' }] }],
  };
  const runRequests: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(r.url())) runRequests.push(r.url()); });
  const importedResponse = page.waitForResponse(r => r.url().endsWith('/api/sessions/import') && r.request().method() === 'POST');
  await page.getByLabel('Import session JSON').setInputFiles({ name: 'untrusted-history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsafe)) });
  const imported: Session = await (await importedResponse).json();
  await expect(page).toHaveURL(new RegExp(`#session/${imported.id}$`));
  await expect(page.getByRole('article', { name: 'Assistant message' })).toHaveCount(2);
  await expect(page.getByRole('article', { name: 'Assistant message' }).first()).toContainText('Hello from Litespeed.');
  await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
  const detail = await history(request, imported.id);
  const configuredWorkspace = (await (await request.get('/api/settings')).json()).workspace;
  expect(detail.session.workspace).toBe(configuredWorkspace);
  expect(detail.session.workspace).not.toBe(unsafe.session.workspace);
  expect(detail.session.permissionMode).toBe('ask');
  expect(detail.session.status).toBe('idle');
  expect(detail.permissions).toEqual([]);
  expect(detail.messages.map(m => [m.role, m.content])).toEqual(unsafe.messages.map(m => [m.role, m.content]));
  expect(detail.messages.every(m => m.sessionId === imported.id)).toBe(true);
  expect(detail.messages.every(m => !exported.messages.some(old => old.id === m.id))).toBe(true);
  expect((await (await request.get(`/api/sessions/${imported.id}/changes`)).json()).changes).toEqual([]);
  expect((await (await request.get(`/api/sessions/${imported.id}/tool-grants`)).json()).tools).toEqual([]);
  await page.reload();
  await expect(page.getByRole('article', { name: 'Assistant message' })).toHaveCount(2);
  expect((await history(request, imported.id)).session.status).toBe('idle');
  expect((await request.get(fileUrl)).ok()).toBe(false);
  expect(runRequests).toEqual([]);
});

test('remembers approvals across reload and later runs, isolates sessions, and resets from the UI', async ({ page, request }) => {
  const session = await createSession(request, 'Remembered approval');
  const grants = async (id: string) => (await (await request.get(`/api/sessions/${id}/tool-grants`)).json()).tools as string[];
  await open(page, session);
  await send(page, 'create fixture with remembered approval');
  await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow this tool for session', exact: true }).click();
  await completed(page, request, session.id, 1);
  expect(await grants(session.id)).toEqual(['write_file']);
  expect((await history(request, session.id)).messages.flatMap(m => m.toolCalls ?? []).map(t => t.status)).toEqual(['completed']);

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Litespeed' })).toBeVisible();
  await send(page, 'create fixture in a later run');
  await completed(page, request, session.id, 2);
  await expect(page.getByRole('region', { name: 'Permission requested' })).toHaveCount(0);
  expect(await grants(session.id)).toEqual(['write_file']);
  expect((await history(request, session.id)).messages.flatMap(m => m.toolCalls ?? []).map(t => t.status)).toEqual(['completed', 'completed']);

  // A persisted grant is per-session, not a workspace-wide or provider-wide auto mode.
  const other = await createSession(request, 'Approval isolation');
  await open(page, other);
  await send(page, 'create fixture in an unrelated session');
  await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible();
  expect(await grants(other.id)).toEqual([]);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await completed(page, request, other.id, 1);

  await open(page, session);
  const resetResponse = page.waitForResponse(r => r.url().endsWith(`/api/sessions/${session.id}/tool-grants`) && r.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('button', { name: 'Reset remembered approvals', exact: true }).click();
  expect((await resetResponse).ok()).toBe(true);
  await expect(page.getByRole('status')).toContainText('Remembered tool approvals cleared.');
  expect(await grants(session.id)).toEqual([]);
  expect((await history(request, session.id)).session.permissionMode).toBe('ask');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Litespeed' })).toBeVisible();
  await send(page, 'create fixture after resetting remembered approval');
  await expect(page.getByRole('region', { name: 'Permission requested' })).toBeVisible();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await completed(page, request, session.id, 3);
  expect((await history(request, session.id)).messages.flatMap(m => m.toolCalls ?? []).map(t => t.status)).toEqual(['completed', 'completed', 'denied']);
  expect(await grants(session.id)).toEqual([]);
});
