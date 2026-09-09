import { test, expect } from '@playwright/test';

async function fresh(page:any){await page.goto('/');await expect(page.getByRole('textbox',{name:'Message Lite'})).toBeVisible();}
async function send(page:any,text:string){await page.getByRole('textbox',{name:'Message Lite'}).fill(text);await page.getByRole('button',{name:'Send message',exact:true}).click();}

test('welcome is usable, keyboard palette works, and layout fits desktop',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await fresh(page);
  await expect(page.getByRole('heading',{name:'Lite.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
  await page.keyboard.press('Control+k');await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
  await page.screenshot({path:'test-results/welcome-desktop.png',fullPage:true,animations:'disabled'});
});

test('streams a message once, persists on reload, shows code and model usage',async({page})=>{
  await fresh(page);await send(page,'hello browser');await expect(page.getByRole('article',{name:'Assistant message'}).last()).toContainText('Hello from Lite.');
  await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Copy code'})).toBeVisible();
  expect(await page.getByRole('article',{name:'Assistant message'}).last().innerText()).not.toContain('Hello from Lite.Hello');
  const url=page.url();await page.reload();await expect(page.getByRole('article',{name:'Assistant message'})).toHaveCount(1);await expect(page.getByRole('article',{name:'Assistant message'})).toContainText('Your workspace is ready.');expect(page.url()).toBe(url);
  await page.screenshot({path:'test-results/conversation-desktop.png',fullPage:true,animations:'disabled'});
});

test('asks before changing files and records an approved tool result',async({page})=>{
  await fresh(page);await send(page,'create fixture');await expect(page.getByRole('region',{name:'Permission requested'})).toBeVisible();
  await page.getByRole('button',{name:'Allow once'}).click();await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
  await expect(page.getByRole('article',{name:'Assistant message'}).last()).toContainText('The file operation is complete.');
  await page.getByText('Write file',{exact:true}).click();await expect(page.getByText(/(?:Created|Updated|Wrote) result\.txt/)).toBeVisible();
  await page.screenshot({path:'test-results/tool-approved.png',fullPage:true,animations:'disabled'});
});

test('can deny a tool without leaving an approval spinner',async({page})=>{
  await fresh(page);await send(page,'create fixture denied');await expect(page.getByRole('button',{name:'Deny',exact:true})).toBeVisible();await page.getByRole('button',{name:'Deny',exact:true}).click();
  await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);await expect(page.getByRole('region',{name:'Permission requested'})).toHaveCount(0);
  await page.getByText('Write file',{exact:true}).click();await expect(page.getByText('The user denied or cancelled this action.',{exact:false})).toBeVisible();
});

test('stops a live stream and sends a follow-up',async({page})=>{
  await fresh(page);await send(page,'slow response');await expect(page.getByRole('button',{name:'Stop generation'})).toBeVisible();await page.getByRole('button',{name:'Stop generation'}).click();await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
  await send(page,'continue normally');await expect(page.getByRole('article',{name:'Assistant message'}).last()).toContainText('Your workspace is ready.');await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
});

test('surfaces provider errors and remains navigable',async({page})=>{
  await fresh(page);await send(page,'provider failure');await expect(page.getByRole('alert').first()).toContainText('HTTP 401');await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
  await page.getByRole('button',{name:/New session/}).first().click();await expect(page.getByRole('heading',{name:'Lite.'})).toBeVisible();
});

test('discovers models and attaches workspace context',async({page})=>{
  await fresh(page);await page.getByRole('button',{name:'test-model'}).click();await expect(page.getByRole('dialog',{name:'Choose a model'})).toBeVisible();await page.getByRole('button',{name:'test-fast',exact:true}).click();
  await page.getByRole('button',{name:'Add workspace file context'}).click();await page.getByRole('textbox',{name:'Search workspace files'}).fill('hello.ts');await page.getByRole('button',{name:'src/hello.ts'}).click();
  await expect(page.getByRole('button',{name:'Remove hello.ts'})).toBeVisible();await send(page,'Read this attached source');await expect(page.getByRole('article',{name:'Your message'})).toContainText('src/hello.ts');await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
});

test('terminal executes real commands, persists on hide and reload, and ends explicitly',async({page,request})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await fresh(page);await send(page,'terminal workspace');await expect(page.getByRole('article',{name:'Assistant message'}).last()).toContainText('Your workspace is ready.');await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
  const sessionId=page.url().split('#session/')[1];
  const detail=await (await request.get(`/api/sessions/${sessionId}`)).json();
  const fileUrl=`/api/file?${new URLSearchParams({workspace:detail.session.workspace,path:'terminal-browser.txt'})}`;
  async function command(text:string){await page.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText(text);await page.keyboard.press('Enter');}
  async function content(){const res=await request.get(fileUrl);return res.ok()?(await res.json()).content:'';}
  await page.getByRole('button',{name:'Open terminal',exact:true}).click();
  const pane=page.getByRole('region',{name:'Session terminal'});await expect(pane.getByRole('status')).toHaveText('Connected');
  await command("export LITE_BROWSER_VALUE=kept; printf '%s' first > terminal-browser.txt");await expect.poll(content).toBe('first');
  await page.getByRole('button',{name:'Hide terminal',exact:true}).click();await expect(pane).toHaveCount(0);
  await page.reload();await expect(page.getByRole('button',{name:'Open terminal',exact:true})).toBeVisible();await page.getByRole('button',{name:'Open terminal',exact:true}).click();await expect(pane.getByRole('status')).toHaveText('Connected');
  await command('printf "%s" "$LITE_BROWSER_VALUE" > terminal-browser.txt');await expect.poll(content).toBe('kept');
  await command("printf '\\nTerminal is ready. State survived reconnection.\\n'");
  await page.screenshot({path:'test-results/terminal-desktop.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/terminal-mobile.png',fullPage:true,animations:'disabled'});
  await pane.getByRole('button',{name:'End shell',exact:true}).click();await expect(pane.getByRole('status')).toHaveText('Shell ended.');
  await pane.getByRole('button',{name:'Reconnect / new shell',exact:true}).click();await expect(pane.getByRole('status')).toHaveText('Connected');
  await command('printf "%s" "${LITE_BROWSER_VALUE:-fresh}" > terminal-browser.txt');await expect.poll(content).toBe('fresh');
  await pane.getByRole('button',{name:'End shell',exact:true}).click();expect(errors).toEqual([]);
});

test('settings save, test connection, validation and dark appearance',async({page})=>{
  await fresh(page);await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('dialog',{name:'Settings'})).toBeVisible();
  const key=page.locator('input[type=password]');await expect(key).toHaveValue('');
  await page.getByRole('button',{name:'Save & test connection'}).click();await expect(page.getByRole('status')).toContainText('Connected');
  await page.getByRole('button',{name:'Workspace',exact:true}).click();await page.getByLabel('Appearance').selectOption('dark');await page.getByRole('button',{name:'Save settings'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.screenshot({path:'test-results/welcome-dark.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Workspace',exact:true}).click();await page.getByLabel('Appearance').selectOption('light');await page.getByRole('button',{name:'Save settings'}).click();
});

test('mobile welcome, sidebar and composer stay within viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});await fresh(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/welcome-mobile.png',fullPage:true,animations:'disabled'});
  await send(page,'hello mobile');await expect(page.getByRole('article',{name:'Assistant message'}).last()).toContainText('Your workspace is ready.');await expect(page.getByRole('button',{name:'Stop generation'})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'test-results/conversation-mobile.png',fullPage:true,animations:'disabled'});
});
