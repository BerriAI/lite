import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

// Opt-in: uses the configured local server and incurs provider usage.
const base=process.env.LITESPEED_URL||'http://localhost:3210';
const model=process.env.LITESPEED_TEST_MODEL;
if(!model)throw new Error('Set LITESPEED_TEST_MODEL to an available coding model before running this live test.');
const workspace=await mkdtemp(join(tmpdir(),'litespeed-live-'));
await writeFile(join(workspace,'README.md'),'# Live smoke fixture\nOnly this temporary project may be changed.\n');
const response=await fetch(base+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Live coding smoke',workspace,model,permissionMode:'auto'})});
const session=await response.json();if(!response.ok)throw new Error(session.error);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/#session/${session.id}`);
  await page.getByRole('textbox',{name:'Message Litespeed'}).fill('In this empty temporary workspace, read README.md, then create sum.mjs exporting function sum(a,b) returning a+b, and sum.test.mjs using node:test and node:assert/strict to test sum(2,3) === 5 and sum(-2,2) === 0. Run node --test sum.test.mjs via the bash tool. Do not install packages, use network, modify any other directory, or create more files. Finish with a concise report of the actual test result.');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('button',{name:'Stop generation'}).waitFor({timeout:15000});
  await page.screenshot({path:'.litespeed/live-streaming.png',fullPage:true});
  await page.getByRole('button',{name:'Stop generation'}).waitFor({state:'hidden',timeout:180000});
  const detail=await(await fetch(`${base}/api/sessions/${session.id}`)).json();
  const tools=detail.messages.flatMap((m:any)=>m.toolCalls||[]);
  const summary={sessionId:session.id,workspace,status:detail.session.status,tools:tools.map((t:any)=>({name:t.name,status:t.status})),browserErrors:errors,final:detail.messages.at(-1)?.content};
  console.log(JSON.stringify(summary,null,2));
  await page.screenshot({path:'.litespeed/live-complete.png',fullPage:true});
  if(detail.session.status==='error'||errors.length)throw new Error('Live smoke ended with errors.');
  if(!tools.some((t:any)=>t.name==='bash'&&t.status==='completed'))throw new Error('Model did not complete the required test command.');
  const code=await readFile(join(workspace,'sum.mjs'),'utf8');if(!code.includes('sum'))throw new Error('Expected source file missing.');
  await writeFile('.litespeed/live-smoke-result.json',JSON.stringify(summary,null,2));
}finally{await browser.close();}
