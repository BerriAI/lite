import { test, expect } from '@playwright/test';

test('setup explains roles, saves a workspace default, and keeps advanced controls out of the first run', async ({ page, request }, testInfo) => {
  const settings = await (await request.get('/api/settings')).json();
  const original = await (await request.get(`/api/workspace-preferences?workspace=${encodeURIComponent(settings.workspace)}`)).json();
  try {
    await request.post('/api/workspace-preferences', { data: { ...original, workspace:settings.workspace, providerId:'fixture', model:'test-model', setupComplete:false } });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name:'Set up Lite', exact:true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name:/Team Fusion/ }).click();
    await page.screenshot({ path:testInfo.outputPath('setup-architecture.png') });
    await dialog.getByRole('button', { name:'Continue', exact:true }).click();
    await dialog.getByRole('button', { name:'Worker model', exact:true }).click();
    await dialog.getByRole('option', { name:'test-fast', exact:true }).click();
    await expect(dialog.getByRole('combobox', { name:/reasoning/i })).toHaveCount(0);
    await dialog.getByRole('combobox', { name:'Setup permissions' }).selectOption('auto');
    await page.screenshot({ path:testInfo.outputPath('setup-models.png') });
    await page.setViewportSize({ width:390,height:844 });
    await page.screenshot({ path:testInfo.outputPath('setup-mobile.png') });
    await expect(dialog.getByRole('button', {name:'Start with this setup'})).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', {name:'Start with this setup'}).click();
    await expect(dialog).toHaveCount(0);
    const preferences=await (await request.get(`/api/workspace-preferences?workspace=${encodeURIComponent(settings.workspace)}`)).json();
    expect(preferences).toMatchObject({setupComplete:true,permissionMode:'auto',architecture:{kind:'team-fusion',worker:{providerId:'fixture',model:'test-fast'}}});
    const session=await (await request.post('/api/sessions',{data:{workspace:settings.workspace}})).json();
    expect(session.architecture).toEqual(preferences.architecture);expect(session.permissionMode).toBe('auto');
    await page.reload();await expect(page.getByRole('textbox',{name:'Message Lite',exact:true})).toBeVisible();await expect(dialog).toHaveCount(0);
  } finally { await request.post('/api/workspace-preferences',{data:{...original,workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:original.architecture??null,permissionMode:original.permissionMode??'ask',setupComplete:true}}); }
});

test('Allow all tools resolves a live prompt and updates the visible session mode', async ({page,request}) => {
  const session=await (await request.post('/api/sessions',{data:{providerId:'fixture',model:'test-model',permissionMode:'ask',architecture:null}})).json();
  await page.goto(`/#session/${session.id}`);
  await page.getByRole('textbox',{name:'Message Lite',exact:true}).fill('create fixture with new permissions');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('region',{name:'Permission requested'}).getByRole('button',{name:'Allow all tools',exact:true}).click();
  await expect.poll(async()=>(await (await request.get(`/api/sessions/${session.id}`)).json()).session.status).toBe('idle');
  await expect(page.locator('.permission-select summary')).toContainText('Allow all tools');
  await expect(page.getByRole('region',{name:'Permission requested'})).toHaveCount(0);
  await page.getByRole('textbox',{name:'Message Lite',exact:true}).fill('slow response');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect.poll(async()=>(await (await request.get(`/api/sessions/${session.id}`)).json()).session.status).toBe('running');
  await page.locator('.permission-select summary').click();
  await page.getByRole('button',{name:/Ask before changes/}).click();
  await expect.poll(async()=>(await (await request.get(`/api/sessions/${session.id}`)).json()).session.permissionMode).toBe('ask');
  await request.post(`/api/sessions/${session.id}/cancel`,{data:{}});
});
