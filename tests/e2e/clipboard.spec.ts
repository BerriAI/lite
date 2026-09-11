import { test, expect } from './fixtures';

test('selection copies on release, preserves selection, and still supports the native copy shortcut', async ({page, request}) => {
  const session=await(await request.post('/api/sessions/import',{data:{session:{title:'Clipboard',providerId:'fixture',model:'test-model'},messages:[{id:'copy',role:'assistant',content:'Clipboard selection Ω ready.',createdAt:1}]}})).json();
  await page.addInitScript(() => {
    Object.assign(window,{copiedText:'',nativeCopy:''});
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{Object.assign(window,{copiedText:text});}}});
    document.addEventListener('copy',event=>{Object.assign(window,{nativeCopy:getSelection()?.toString()});event.preventDefault();});
  });
  await page.goto(`/#session/${session.id}`);
  const text=page.locator('.markdown p').filter({hasText:'Clipboard selection Ω ready.'});
  const box=(await text.boundingBox())!;
  await page.mouse.move(box.x+1,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+180,box.y+box.height/2,{steps:8});await page.mouse.up();
  const selected=await page.evaluate(()=>getSelection()?.toString());
  expect(selected).toContain('Clipboard');
  await expect.poll(()=>page.evaluate(()=>(window as any).copiedText)).toBe(selected);
  await page.keyboard.press(process.platform==='darwin'?'Meta+C':'Control+C');
  await expect.poll(()=>page.evaluate(()=>(window as any).nativeCopy)).toBe(selected);
  const input=page.getByRole('textbox',{name:'Message Litespeed',exact:true});await input.fill('Draft stays editable');
  await input.selectText();await page.keyboard.press('Shift+ArrowLeft');
  expect(await page.evaluate(()=>(window as any).copiedText)).toBe(selected);
});

test('copy buttons fall back to the browser copy event when the clipboard API is denied',async({page,request})=>{
  const session=await(await request.post('/api/sessions/import',{data:{session:{title:'Copy fallback',providerId:'fixture',model:'test-model'},messages:[{id:'copy',role:'assistant',content:'Fallback copy works.',createdAt:1}]}})).json();
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('Denied');}}});
    document.addEventListener('copy',event=>{
      const data=event.clipboardData!,set=data.setData.bind(data);
      data.setData=(format,text)=>{Object.assign(window,{copiedText:text});set(format,text);};
      event.preventDefault();
    });
  });
  await page.goto(`/#session/${session.id}`);await page.getByRole('button',{name:'Copy',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).copiedText)).toBe('Fallback copy works.');
  await expect(page.getByRole('button',{name:'Copied',exact:true})).toBeVisible();
});
