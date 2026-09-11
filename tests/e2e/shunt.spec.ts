import { test, expect } from './fixtures';

test('Advanced settings keeps onboarding simple and saves an independently chosen Shunt model',async({page,request},testInfo)=>{
  const settings=await(await request.get('/api/settings')).json();
  const original=await(await request.get(`/api/workspace-preferences?workspace=${encodeURIComponent(settings.workspace)}`)).json();
  try {
    await request.post('/api/workspace-preferences',{data:{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null,shunt:null,setupComplete:false}});
    await page.goto('/');await page.getByRole('button',{name:'Set up Litespeed',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Set up Litespeed',exact:true});
    await dialog.getByRole('button',{name:'Connect & continue'}).click();
    await dialog.getByRole('button',{name:/Single model/}).click();await dialog.getByRole('button',{name:'Continue',exact:true}).click();
    await expect(dialog.locator('.shunt-settings')).not.toHaveAttribute('open');
    await expect(dialog.getByRole('switch',{name:'Enable Shunt'})).not.toBeVisible();
    await dialog.locator('.shunt-settings > summary').click();
    await expect(dialog.getByText(/Up to ~90% less main-model context/)).toBeVisible();
    await dialog.getByRole('switch',{name:'Enable Shunt'}).click();
    await expect(dialog.getByRole('button',{name:'Start with this setup'})).toBeDisabled();
    await dialog.getByRole('option',{name:'test-fast',exact:true}).click();
    await expect(dialog.getByRole('switch',{name:'Enable Shunt'})).toBeChecked();
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('shunt-setup-mobile.png')});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await dialog.getByRole('button',{name:'Start with this setup'}).click();
    const preferences=await(await request.get(`/api/workspace-preferences?workspace=${encodeURIComponent(settings.workspace)}`)).json();
    expect(preferences.shunt).toEqual({enabled:true,model:{providerId:'fixture',model:'test-fast'}});
    const session=await(await request.post('/api/sessions',{data:{workspace:settings.workspace}})).json();
    expect(session.shunt).toEqual(preferences.shunt);
    await page.goto(`/#session/${session.id}`);await page.locator('.model-trigger').click();
    const models=page.getByRole('dialog',{name:'Choose a model'});
    await expect(models.getByRole('switch',{name:'Enable Shunt'})).toBeChecked();
    await models.getByRole('switch',{name:'Enable Shunt'}).click();await models.getByRole('button',{name:'Done',exact:true}).click();
    await expect.poll(async()=>(await(await request.get(`/api/sessions/${session.id}`)).json()).session.shunt.enabled).toBe(false);
    await page.reload();await page.locator('.model-trigger').click();
    await models.locator('.shunt-settings > summary').click();await models.getByRole('switch',{name:'Enable Shunt'}).click();
    await expect.poll(async()=>(await(await request.get(`/api/sessions/${session.id}`)).json()).session.shunt.enabled).toBe(true);
  } finally {await request.post('/api/workspace-preferences',{data:{...original,workspace:settings.workspace,shunt:original.shunt??null,architecture:original.architecture??null,setupComplete:true}});}
});

for(const workers of [false,true])test(`Shunt streams inline in ${workers?'each worker':'the originating tool'} without Inspect`,async({page,request},testInfo)=>{
  const settings=await(await request.get('/api/settings')).json();
  const original=await(await request.get(`/api/workspace-preferences?workspace=${encodeURIComponent(settings.workspace)}`)).json();
  const session=await(await request.post('/api/sessions',{data:{providerId:'fixture',model:'test-model',permissionMode:'auto',architecture:workers?{kind:'team-fusion',worker:{providerId:'fixture',model:'test-fast'}}:null,shunt:{enabled:true,model:{providerId:'fixture',model:'budget-model'}}}})).json();
  try {
    await page.goto(`/#session/${session.id}`);
    await page.getByRole('textbox',{name:'Message Litespeed',exact:true}).fill(workers?'SHUNT_WORKERS':'SHUNT_BROWSER');await page.getByRole('button',{name:'Send message',exact:true}).click();
    const readers=page.getByRole('region',{name:'Shunt reader',exact:true});
    await expect(readers).toHaveCount(workers?2:1);
    for(const reader of await readers.all()){await expect(reader).toContainText('The fixture exports a greeting.');await expect(reader).toContainText('budget-model');}
    if(workers)for(const name of ['Worker 1 task','Worker 2 task'])await expect(page.getByRole('region',{name,exact:true}).getByRole('region',{name:'Shunt reader',exact:true})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath(workers?'shunt-workers.png':'shunt-inline.png')});
    await request.post('/fixture/delegations/release');
    await expect.poll(async()=>(await(await request.get(`/api/sessions/${session.id}`)).json()).session.status).toBe('idle');
    await page.reload();
    await page.locator('.work-log > summary').first().click();
    await expect(readers).toHaveCount(workers?2:1);
  } finally {await request.post('/fixture/delegations/release');await request.post(`/api/sessions/${session.id}/cancel`,{data:{}});await request.post('/api/workspace-preferences',{data:{...original,workspace:settings.workspace,shunt:original.shunt??null,architecture:original.architecture??null,permissionMode:original.permissionMode??'ask',setupComplete:true}});}
});
