import { test, expect } from './fixtures';

for (const [kind, role, concurrency, width] of [
  ['team-fusion', 'Worker', undefined, 1440],
  ['expert-fusion', 'Expert', undefined, 1440],
  ['team-fusion', 'Worker', 1, 390],
] as const) {
  test(`${kind} shows separate live identities at ${width}px with concurrency ${concurrency ?? 'default'}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const response = await request.post('/api/sessions', { data: { permissionMode: 'auto', architecture: { kind, [kind === 'expert-fusion' ? 'expert' : 'worker']: { providerId: 'fixture', model: 'test-fast' }, ...(concurrency ? { concurrency } : {}) } } });
    const session = await response.json();
    const pending = async () => (await (await request.get('/fixture/delegations')).json()).pending;
    try {
      await page.goto(`/#session/${session.id}`);
      await page.getByRole('textbox', { name: 'Message Litespeed', exact: true }).fill('WORKERS_BROWSER inspect two assignments');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(pending).toBe(concurrency === 1 ? 1 : 2);
      const cards = page.locator('.worker-task');
      await expect(cards).toHaveCount(2);
      await expect(cards.nth(0).locator('.task-actor')).toHaveText(`${role} 1`);
      await expect(cards.nth(1).locator('.task-actor')).toHaveText(`${role} 2`);
      await expect(page.locator('.driver-identity').first()).toHaveText('Driver');
      await expect(cards.first()).toContainText('alpha progress');
      await expect(cards.first()).not.toContainText('beta progress');
      if (concurrency === 1) {
        await expect(cards.nth(1)).toContainText('Queued');
        await expect(cards.nth(1)).not.toContainText('Arguments');
      } else {
        await expect(cards.nth(1)).toContainText('beta progress');
        await expect(cards.nth(1)).not.toContainText('alpha progress');
        const bounds = await cards.evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; }));
        expect(bounds[1].x).toBeGreaterThan(bounds[0].x);
        expect(bounds[1].y).toBe(bounds[0].y);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `/tmp/litespeed-live-${role}-${width}.png`, animations: 'disabled' });
      await request.post('/fixture/delegations/release');
      if (concurrency === 1) {
        await expect(cards.nth(1)).toContainText('beta progress');
        await expect(cards.nth(1).locator('.task-actor')).toHaveText('Worker 2');
        await request.post('/fixture/delegations/release');
      }
      await expect(page.getByRole('article', { name: 'Assistant message' }).last()).toContainText('Driver report: both assignments are complete.');
      const work = page.locator('.conversation-content > .assistant-message .work-log').first();
      await expect(work).not.toHaveAttribute('open');
      await expect(work.locator(':scope > summary')).toHaveText(`2 ${role.toLowerCase()}s`);
      await work.locator(':scope > summary').click();
      await expect(page.getByRole('region', { name: `${role} 1 transcript`, exact: true })).toContainText('alpha final report');
      await expect(page.getByRole('region', { name: `${role} 2 transcript`, exact: true })).toContainText('beta final report');
    } finally {
      await request.post(`/api/sessions/${session.id}/cancel`);
      await request.post('/fixture/delegations/release');
    }
  });
}

test('tool rounds remain visible and compact until prose collapses their combined count', async ({ page, request }) => {
  const session = await (await request.post('/api/sessions', { data: { permissionMode: 'auto', architecture: null } })).json();
  try {
    await page.goto(`/#session/${session.id}`);
    await page.getByRole('textbox', { name: 'Message Litespeed', exact: true }).fill('LIVE_STEPS_BROWSER inspect files');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await (await request.get('/fixture/delegations')).json()).pending).toBe(1);
    await expect(page.locator('.work-log')).toHaveCount(1);
    await expect(page.locator('.tool-card')).toHaveCount(5);
    for (const tool of await page.locator('.tool-card').all()) await expect(tool).toBeVisible();
    const rows = await page.locator('.tool-card > summary').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { y: r.y, height: r.height }; }));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].y - rows[i - 1].y - rows[i - 1].height).toBeLessThanOrEqual(2);
      expect(rows[i].height).toBeLessThanOrEqual(30);
    }
    await page.screenshot({ path: '/tmp/litespeed-live-tool-spacing.png', animations: 'disabled' });
    await request.post('/fixture/delegations/release');
    await expect(page.getByText('The five file reads are complete.', { exact: true })).toBeVisible();
    await expect(page.locator('.work-log')).not.toHaveAttribute('open');
    await expect(page.locator('.work-log > summary')).toHaveText('5 steps');
    await page.locator('.work-log > summary').click();
    await expect(page.locator('.tool-card').last()).toBeVisible();
  } finally { await request.post(`/api/sessions/${session.id}/cancel`); await request.post('/fixture/delegations/release'); }
});

test('workspace panel can close during a visit and reopens when entering the session again', async ({ page, request }) => {
  const session = await (await request.post('/api/sessions', { data: {} })).json();
  await page.goto(`/#session/${session.id}`);
  const panel = page.locator('.workspace-panel');
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Hide workspace panel', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Hide workspace panel', exact: true })).toBeVisible();
  await expect(panel).toBeVisible();
});

test('narrowing the window closes the workspace overlay without changing the desktop preference', async ({ page, request }) => {
  const session = await (await request.post('/api/sessions', { data: {} })).json();
  await page.goto(`/#session/${session.id}`);
  const panel = page.locator('.workspace-panel');
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Show workspace panel', exact: true }).click();
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('litespeed.workspace-panel-open'))).toBe('true');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Hide workspace panel', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(panel).toHaveCount(0);
});
