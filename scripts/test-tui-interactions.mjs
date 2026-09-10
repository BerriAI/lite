/** Acceptance and visual checks for setup and live worker attribution. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { chromium } from '@playwright/test';

const root=resolve(import.meta.dirname,'..'), artifacts=join(root,'test-results-tui','interactions');
await mkdir(artifacts,{recursive:true});
const config=await mkdtemp(join(tmpdir(),'lite-tui-setup-'));
const server=spawn(process.execPath,['--import','tsx','scripts/e2e-server.ts'],{cwd:root,env:{...process.env,LITE_E2E_PORT:'0',LITE_E2E_NO_VITE:'1',LITE_E2E_ONBOARDING:'1'},stdio:['ignore','pipe','pipe']});
let log='',terminal,emulator,browser;
server.stdout.on('data',chunk=>log+=chunk);server.stderr.on('data',chunk=>log+=chunk);
const screen=()=>emulator?Array.from({length:emulator.rows},(_,row)=>emulator.buffer.active.getLine(emulator.buffer.active.viewportY+row)?.translateToString(true,0,emulator.cols)??'').join('\n'):'';
async function waitFor(check,label,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await new Promise(done=>setTimeout(done,60));}throw new Error(`${label}\n${screen()}\n${log.slice(-1000)}`);}
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function save(name){
  await writeFile(join(artifacts,name+'.txt'),screen());
  const rows=[];
  for(let y=0;y<emulator.rows;y++){
    const line=emulator.buffer.active.getLine(emulator.buffer.active.viewportY+y),cells=[];
    for(let x=0;x<emulator.cols;x++){
      const cell=line?.getCell(x);if(!cell||cell.getWidth()===0)continue;
      const color=(value,rgb,palette,fallback)=>{
        if(rgb)return '#'+value.toString(16).padStart(6,'0');
        if(!palette)return fallback;
        if(value<16)return ['#111','#c55','#5a5','#ca5','#65a','#a5a','#5aa','#ddd','#777','#f77','#8e8','#ff9','#99f','#f9f','#9ff','#fff'][value];
        if(value>=232){const gray=8+(value-232)*10;return `rgb(${gray},${gray},${gray})`;}
        const n=value-16,levels=[0,95,135,175,215,255];return `rgb(${levels[Math.floor(n/36)]},${levels[Math.floor(n/6)%6]},${levels[n%6]})`;
      };
      const fg=color(cell.getFgColor(),cell.isFgRGB(),cell.isFgPalette(),'#ddd'),bg=color(cell.getBgColor(),cell.isBgRGB(),cell.isBgPalette(),'#0a0a0a');
      cells.push(`<span style="color:${fg};background:${bg};font-style:${cell.isItalic()?'italic':'normal'};font-weight:${cell.isBold()?'bold':'normal'}">${escape(cell.getChars()||' ')}</span>`);
    }rows.push(cells.join(''));
  }
  const page=await browser.newPage({viewport:{width:emulator.cols*9+32,height:emulator.rows*20+32},deviceScaleFactor:2});
  await page.setContent(`<body style="margin:0;background:#0a0a0a"><pre style="font:15px/20px Menlo,monospace;margin:16px">${rows.join('\n')}</pre></body>`);
  await page.screenshot({path:join(artifacts,name+'.png')});await page.close();
}
async function stopTerminal(){if(terminal){terminal.kill();terminal=undefined;await new Promise(done=>setTimeout(done,100));}emulator?.dispose();}
try{
  await waitFor(()=>/ready at (http:\/\/\S+)/.test(log),'fixture ready');const base=log.match(/ready at (http:\/\/\S+)/)[1];
  const api=async(path,body,method)=>{const r=await fetch(base+'/api'+path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;};
  const settings=await api('/settings');browser=await chromium.launch({channel:'chrome',headless:true});
  async function launch(session,cols=100,rows=38){
    await stopTerminal();emulator=new xterm.Terminal({cols,rows,allowProposedApi:true});
    terminal=pty.spawn(process.execPath,['bin/lite.mjs','tui','--url',base,'--session',session.id,'--workspace',settings.workspace],{cwd:root,cols,rows,name:'xterm-256color',env:{...process.env,TERM:'xterm-256color',LITE_DISABLE_PROJECT_CONFIG:'1',LITE_CONFIG_DIR:config,XDG_CONFIG_HOME:config,XDG_STATE_HOME:config}});
    terminal.onData(chunk=>emulator.write(chunk));await waitFor(()=>screen().includes('Ctrl+P Commands'),'ready');
  }
  const session=await api('/sessions',{workspace:settings.workspace});await launch(session,80,24);
  await waitFor(()=>screen().includes('Connect your LiteLLM gateway · 1 of 3'),'gateway setup');await save('00-setup-gateway');
  terminal.write('\r');await waitFor(()=>screen().includes('Gateway base URL')&&screen().includes('Enter save'),'gateway URL');terminal.write('\r');await waitFor(()=>screen().includes('LiteLLM API key'),'gateway key');terminal.write('fixture-key');await waitFor(()=>screen().includes('•••'),'masked key');assert(!screen().includes('fixture-key'));terminal.write('\r');
  await waitFor(()=>screen().includes('Set up Lite · 2 of 3'),'first-run setup');await save('01-setup-architecture');
  terminal.write('\x1b[B\x1b[B\r');await waitFor(()=>screen().includes('Worker: Choose a model'),'team setup');
  terminal.write('\x1b[H\x1b[B\x1b[B\r');await waitFor(()=>screen().includes('Enter a model ID'),'model chooser');terminal.write('test-fast');await waitFor(()=>screen().includes('› test-fast'),'model result');terminal.write('\r');
  await waitFor(()=>screen().includes('Worker: test-fast'),'worker selected');await save('02-setup-models');
  terminal.write('\x1b[F\r');await waitFor(()=>!screen().includes('Choose your models · 3 of 3'),'setup saved');
  assert.equal((await api('/workspace-preferences?workspace='+encodeURIComponent(settings.workspace))).setupComplete,true);
  await save('03-start');
  const configured=await api(`/sessions/${session.id}`);await api(`/sessions/${session.id}`,{architecture:null,expectedConfigRevision:configured.session.configRevision},'PATCH');
  terminal.write('create fixture\r');await waitFor(()=>screen().includes('Permission requested'),'prompt');await save('04-permissions');terminal.write('4');
  await waitFor(async()=>{const d=await api(`/sessions/${session.id}`);return d.session.status==='idle'&&d.session.permissionMode==='auto';},'allow all while waiting');
  const live=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null,permissionMode:'auto'});await launch(live,100,32);
  terminal.write('LIVE_STEPS_BROWSER\r');
  await waitFor(()=>screen().split('\n').filter(line=>line.includes('Read README.md')||line.includes('Read src/hello.ts')).length>=5,'consecutive tools visible without Inspect');
  assert(!screen().includes('Inspect'));
  const row=screen().split('\n').findIndex(line=>line.includes('Read README.md'))+1;
  terminal.write(`\x1b[<0;10;${row}M\x1b[<0;10;${row}m`);
  await waitFor(()=>screen().includes('A small project for browser tests.'),'tool result opens inline on click');await save('04-inline-tools');
  await fetch(base+'/fixture/delegations/release',{method:'POST'});
  await waitFor(async()=>(await api(`/sessions/${live.id}`)).session.status==='idle','tool run finishes');
  terminal.write('\x1bo');await waitFor(()=>screen().includes('A small project for browser tests.'),'Alt+O opens completed activity');
  for(const [kind,label] of [['team-fusion','Worker'],['expert-fusion','Expert'],['sidekick-fusion','Sidekick']]){
    const architecture={kind,[kind==='team-fusion'?'worker':kind==='expert-fusion'?'expert':'sidekick']:{providerId:'fixture',model:'test-fast'}};
    const next=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture,permissionMode:label==='Sidekick'?'ask':'auto'});await launch(next,100,38);
    terminal.write((label==='Sidekick'?'SIDEKICK_BROWSER HOLD_CHILD':'WORKERS_BROWSER')+'\r');
    if(label==='Sidekick'){
      await waitFor(()=>screen().includes('Permission requested · sidekick'),'sidekick permission');terminal.write('1');
      await waitFor(()=>screen().includes('Permission requested · write_file'),'sidekick action');
      await waitFor(()=>screen().includes('Driver → Sidekick'),'sidekick handoff visible');await save('07-sidekick');terminal.write('4');
    }else{
      await waitFor(()=>screen().includes('Driver → '+label+' 1')&&screen().includes('Driver → '+label+' 2')&&screen().includes('beta progress:'),'both live transcripts');
      assert(screen().includes('alpha progress:'));assert(!screen().includes('prompt='));await save('05-'+label.toLowerCase()+'s');
      terminal.resize(80,24);emulator.resize(80,24);await new Promise(done=>setTimeout(done,300));await save('06-'+label.toLowerCase()+'s-narrow');
      terminal.resize(100,38);emulator.resize(100,38);
    }
    await fetch(base+'/fixture/delegations/release',{method:'POST'});
    await waitFor(async()=>(await api(`/sessions/${next.id}`)).session.status==='idle','workers finish');
  }
  const imported=await api('/sessions/import',{session:{title:'Long conversation',providerId:'fixture',model:'test-model',permissionMode:'ask'},messages:Array.from({length:240},(_,i)=>({id:`history-${i}`,role:i%2?'assistant':'user',content:i%2?'A completed answer.\n\n```typescript\n'+Array.from({length:30},(_,n)=>`const value${n} = ${n};`).join('\n')+'\n```':'Inspect these files.',createdAt:i+1}))});
  await launch(imported,100,32);await new Promise(done=>setTimeout(done,250));
  const started=performance.now();terminal.write('Draft stays responsive');await waitFor(()=>screen().includes('Draft stays responsive'),'typing through long history');
  console.log(`Typing latency with 240 historical messages: ${Math.round(performance.now()-started)} ms.`);
  await api('/workspace-preferences',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null,setupComplete:false});
  const fresh=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null});
  await api('/settings',{providers:[]},'PATCH');await launch(fresh,80,24);
  await waitFor(()=>screen().includes('Gateway base URL: Enter your URL'),'fresh gateway fields');assert(!screen().includes('localhost:4000'));await save('08-fresh-gateway');
  terminal.write('\r');await waitFor(()=>screen().includes('Enter save'),'enter fresh URL');terminal.write(settings.providers[0].baseUrl+'/setup-auth\r');
  await waitFor(()=>screen().includes('LiteLLM API key'),'enter fresh key');terminal.write('wrong-key\r');
  await waitFor(()=>screen().includes('HTTP 401'),'gateway error stays in setup');assert.equal((await api('/settings')).providers.length,0);
  terminal.write('\x1b[H\x1b[B\r');await waitFor(()=>screen().includes('LiteLLM API key'),'correct key');terminal.write('fixture-key\r');
  await waitFor(()=>screen().includes('Set up Lite · 2 of 3'),'fresh gateway connected');terminal.write('\r');
  await waitFor(()=>screen().includes('Model: Choose a model'),'fresh model selection');terminal.write('\x1b[H\x1b[B\r');
  await waitFor(()=>screen().includes('Enter a model ID'),'fresh catalog');terminal.write('test-model');await waitFor(()=>screen().includes('› test-model'),'gateway model found');terminal.write('\r');
  await waitFor(()=>screen().includes('Model: test-model'),'fresh model chosen');terminal.write('\x1b[F\r');
  await waitFor(async()=>(await api('/workspace-preferences?workspace='+encodeURIComponent(settings.workspace))).setupComplete===true,'fresh setup persisted');
  const freshSettings=await api('/settings');assert.equal(freshSettings.providers[0].baseUrl,settings.providers[0].baseUrl+'/setup-auth');assert(!JSON.stringify(freshSettings).includes('fixture-key'));
  console.log('Fresh TUI gateway setup passed: blank URL, masked key, failed authentication, model discovery, and saved setup.');
  console.log('TUI interactions passed: first-run setup, saved models, live Allow all, two workers, two experts, Sidekick handoff, and narrow/wide rendering.');
}finally{await stopTerminal();await browser?.close();server.kill('SIGTERM');await rm(config,{recursive:true,force:true});}
