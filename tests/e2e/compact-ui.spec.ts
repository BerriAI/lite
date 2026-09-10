import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 700 }]) {
  test(`model dialog fits ${viewport.width}×${viewport.height}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/settings', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), theme: 'dark' } });
    });
    const response = await request.post('/api/sessions', { data: { providerId: 'fixture', model: 'test-model', architecture: null, planner: null, modelReasoning: {} } });
    const session = await response.json();
    await page.goto(`/#session/${session.id}`);
    await expect(page.locator('.model-trigger')).toBeEnabled();
    await expect(page.locator('.chat-composer .turn-history')).toHaveCount(0);
    await expect(page.locator('.enter-hint')).toHaveCount(0);
    await page.locator('.model-trigger').click();
    const dialog = page.getByRole('dialog');
    await expect(page.getByRole('button', { name: 'Architecture', exact: true })).toContainText('Single model');
    await page.getByRole('button', { name: 'Architecture', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Architecture', exact: true }).getByRole('option')).toHaveCount(4);
    await page.screenshot({ path: `/tmp/lite-architectures-${viewport.width}.png`, animations: 'disabled' });
    await page.getByRole('option', { name: /^Sidekick Fusion/ }).click();
    await page.getByRole('button', { name: 'Sidekick model', exact: true }).click();
    await expect(page.getByRole('option', { name: 'test-fast', exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/lite-model-search-${viewport.width}.png`, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('textbox', { name: 'Search sidekick models' }).fill('fast');
    await page.getByRole('option', { name: 'test-fast', exact: true }).click();
    const effort = page.getByLabel('Sidekick reasoning', { exact: true });
    await expect(effort).toBeEnabled();
    await effort.selectOption('low');
    await expect(effort).toBeEnabled();
    await page.getByLabel('Driver reasoning', { exact: true }).selectOption('high');
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeEnabled();
    await page.getByRole('switch', { name: 'Use a planner model' }).click();
    await expect(page.getByRole('button', { name: 'Planner model', exact: true })).toBeEnabled();
    const geometry = await dialog.evaluate(el => { const rect = el.getBoundingClientRect(); const body = el.querySelector('.model-picker-scroll')!; return { top: rect.top, bottom: rect.bottom, overflow: body.scrollHeight - body.clientHeight }; });
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/lite-model-${viewport.width}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    const saved = await (await request.get(`/api/sessions/${session.id}`)).json();
    expect(saved.session.modelReasoning).toEqual({ '["fixture","test-model"]': 'high', '["fixture","test-fast"]': 'low' });
    await expect(page.locator('.composer [aria-label="Project profiles"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Session actions', exact: true }).click();
    await expect(page.locator('.session-menu').getByRole('button', { name: 'Undo last turn', exact: true })).toBeVisible();
  });
}

test('delegation has one status and usage appears only after the turn finishes', async ({ page, request }) => {
  const response = await request.post('/api/sessions', { data: { providerId: 'fixture', model: 'test-model', architecture: { kind: 'sidekick-fusion', sidekick: { providerId: 'fixture', model: 'test-fast' } } } });
  const session = await response.json();
  try {
    await page.goto(`/#session/${session.id}`);
    await page.getByRole('textbox', { name: 'Message Lite', exact: true }).fill('SIDEKICK_BROWSER compact UI');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const approval = page.getByRole('region', { name: 'Permission requested', exact: true });
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(approval).toBeVisible();
    await expect(page.locator('.work-log > summary')).toContainText('step');
    await expect(approval).toContainText(/sidekick/i);
    await expect(page.locator('.message-live, .run-status, .session-state, .context-estimate, .usage')).toHaveCount(0);
    await expect(page.locator('.research-task')).toBeHidden();
    await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.locator('.usage')).toHaveCount(1);
    await expect(page.locator('.context-estimate')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/lite-conversation-compact.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Session actions', exact: true }).click();
    await page.getByRole('button', { name: 'Context details', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Context details', exact: true }).getByLabel('Context estimate', { exact: true })).toBeVisible();
  } finally { await request.post(`/api/sessions/${session.id}/cancel`); }
});

for (const width of [1280, 390]) {
  test(`repository answer has one collapsed work log and a clean composer at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const answer = 'This repository contains **AI model-routing and agent experiments**.\n\n| Folder | What’s inside |\n| --- | --- |\n| `harness-planner-executor/` | A planner → executor → validator agent loop using the Claude Agent SDK |\n| `router/` | Mid-session model switching, with a web configuration UI |\n| `oc-router/` | Model-routing experiments built as an OpenCode plugin |\n| `proxy/` | An HTTP proxy that classifies conversations and rewrites the requested model |\n| `bot-loop/` | Tests whether repository knowledge reduces review iterations |\n| `caveats/` | A taxonomy of failure patterns mined from LiteLLM PR reviews |\n| `ux/` | A protocol for evaluating the agent experience |\n\n**THOUGHTS.md** collects auto-routing ideas. The root **README.md** describes the experiments, but references a `practice/` folder that is no longer present.\n\nI only inspected files; nothing changed or ran.';
    const result = await request.post('/api/sessions/import', { data: { session: { title: 'Repository overview', providerId: 'fixture', model: 'test-model' }, messages: [
      { id: 'u', role: 'user', content: 'Give me an overview of this repository.', createdAt: 1 },
      { id: 'steps', role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 't1', name: 'sidekick', args: { description: 'Inspect repository overview' }, status: 'completed', output: 'Repository overview report.' }, { id: 't2', name: 'read_file', args: { path: 'README.md' }, status: 'completed', output: '# Experiments' }] },
      { id: 'answer', role: 'assistant', content: answer, createdAt: 3 },
    ] } });
    expect(result.ok()).toBe(true); const session = await result.json();
    // Imported tool records have no local checkpoints; isolate the reading-layout fixture.
    await page.route(`**/api/sessions/${session.id}`, async route => { const response = await route.fetch(); const value = await response.json(); await route.fulfill({ response, json: { ...value, history: { hasCheckpoints: false, canUndo: false, canRedo: false } } }); });
    await page.goto(`/#session/${session.id}`);
    await expect(page.locator('.work-log > summary')).toHaveText('2 steps');
    await expect(page.locator('.tool-card').first()).toBeHidden();
    await expect(page.locator('.composer [aria-label="Project profiles"]')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Agent mode', exact: true })).toHaveValue('build');
    await expect(page.locator('.markdown table')).toBeVisible();
    const answerBounds = await page.locator('.markdown').last().boundingBox(), stepsBounds = await page.locator('.work-log').boundingBox();
    expect(stepsBounds!.y).toBeGreaterThanOrEqual(answerBounds!.y + answerBounds!.height);
    await page.locator('.conversation-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `/tmp/lite-clean-overview-${width}.png`, animations: 'disabled' });
    await page.locator('.work-log > summary').click();
    await expect(page.locator('.tool-card').last()).toBeVisible();
    await page.locator('.tool-card').last().locator('summary').click();
    await expect(page.locator('.tool-card').last()).toContainText('# Experiments');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
