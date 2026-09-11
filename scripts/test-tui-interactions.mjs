/** Acceptance and visual checks for setup and live worker attribution. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { chromium } from '@playwright/test';

const root=resolve(import.meta.dirname,'..'), artifacts=join(root,'test-results-tui','interactions');
await mkdir(artifacts,{recursive:true});
const config=await mkdtemp(join(tmpdir(),'litespeed-tui-setup-'));
const clipboard=join(config,'clipboard.txt');
await writeFile(join(config,'pbcopy'),`#!/bin/sh\ncat > "$LITESPEED_TEST_CLIPBOARD"\n`,{mode:0o700});
const server=spawn(process.execPath,['--import','tsx','scripts/e2e-server.ts'],{cwd:root,env:{...process.env,LITESPEED_E2E_PORT:'0',LITESPEED_E2E_NO_VITE:'1',LITESPEED_E2E_ONBOARDING:'1'},stdio:['ignore','pipe','pipe']});
let log='',terminal,emulator,browser;
server.stdout.on('data',chunk=>log+=chunk);server.stderr.on('data',chunk=>log+=chunk);
const screen=()=>emulator?Array.from({length:emulator.rows},(_,row)=>emulator.buffer.active.getLine(emulator.buffer.active.viewportY+row)?.translateToString(true,0,emulator.cols)??'').join('\n'):'';
function clickLine(marker,start=0){const lines=screen().split('\n'),row=lines.findIndex((line,index)=>index>=start&&line.includes(marker));assert(row>=0,`Missing clickable row: ${marker}\n${screen()}`);const column=lines[row].indexOf(marker)+2;terminal.write(`\x1b[<0;${column};${row+1}M\x1b[<0;${column};${row+1}m`);return row;}
function scrollLine(marker,direction,start=0){const lines=screen().split('\n'),row=lines.findIndex((line,index)=>index>=start&&line.includes(marker));assert(row>=0,`Missing scroll row: ${marker}\n${screen()}`);const column=lines[row].indexOf(marker)+2;terminal.write(`\x1b[<${direction==='down'?65:64};${column};${row+1}M`);}
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
    terminal=pty.spawn(process.execPath,['bin/litespeed.mjs','tui','--url',base,'--session',session.id,'--workspace',settings.workspace],{cwd:root,cols,rows,name:'xterm-256color',env:{...process.env,PATH:config+':'+process.env.PATH,SSH_CONNECTION:'',SSH_TTY:'',LITESPEED_TEST_CLIPBOARD:clipboard,TERM:'xterm-256color',LITESPEED_DISABLE_PROJECT_CONFIG:'1',LITESPEED_CONFIG_DIR:config,XDG_CONFIG_HOME:config,XDG_STATE_HOME:config}});
    const display=emulator;terminal.onData(chunk=>display.write(chunk));await waitFor(()=>screen().includes('Ctrl+P Commands'),'ready');
    await new Promise(done=>setTimeout(done,100));
  }
  const session=await api('/sessions',{workspace:settings.workspace});await launch(session,80,24);
  assert(!screen().includes('Connect your LiteLLM gateway'));
  terminal.write('/set');await waitFor(()=>screen().includes('/settings')&&screen().includes('/setup'),'slash suggestions');await save('00-slash-commands');
  terminal.write('\t');await waitFor(()=>screen().includes('/settings '),'Tab completes command');
  terminal.write('\x15/setup\r');
  await waitFor(()=>screen().includes('Connect your LiteLLM gateway · 1 of 3'),'gateway setup');await save('00-setup-gateway');
  terminal.write('\r');await waitFor(()=>screen().includes('Gateway base URL')&&screen().includes('Enter save'),'gateway URL');terminal.write('\r');await waitFor(()=>screen().includes('LiteLLM API key'),'gateway key');terminal.write('fixture-key');await waitFor(()=>screen().includes('•••'),'masked key');assert(!screen().includes('fixture-key'));terminal.write('\r');
  await waitFor(()=>screen().includes('Set up Litespeed · 2 of 3'),'first-run setup');await save('01-setup-architecture');
  terminal.write('\x1b[B\x1b[B\r');await waitFor(()=>screen().includes('Worker: Choose a model'),'team setup');
  terminal.write('\x1b[H\x1b[B\x1b[B\r');await waitFor(()=>screen().includes('Enter a model ID'),'model chooser');terminal.write('test-fast');await waitFor(()=>screen().includes('› test-fast'),'model result');terminal.write('\r');
  await waitFor(()=>screen().includes('Worker: test-fast'),'worker selected');await save('02-setup-models');
  assert(screen().includes('Advanced settings'));
  terminal.write('\x1b[H\x1b[B\x1b[B\x1b[B\r');await waitFor(()=>screen().includes('Shunt: Off'),'Shunt advanced settings');await save('02-shunt-advanced');
  terminal.write('\r');await waitFor(()=>screen().includes('Enter a model ID'),'Shunt chooser');terminal.write('budget-model');await waitFor(()=>screen().includes('› budget-model'),'Shunt model found');terminal.write('\r');
  await waitFor(()=>screen().includes('Shunt model: budget-model'),'Shunt selected');await save('02-shunt-model');terminal.write('\x1b');await waitFor(()=>screen().includes('Advanced settings · Shunt On'),'Shunt configured');
  terminal.write('\x1b[F\r');await waitFor(()=>!screen().includes('Choose your models · 3 of 3'),'setup saved');
  assert.equal((await api('/workspace-preferences?workspace='+encodeURIComponent(settings.workspace))).setupComplete,true);
  const shuntSetup=await api(`/sessions/${session.id}`);assert.equal(shuntSetup.session.shunt.model.model,'budget-model');
  await api(`/sessions/${session.id}`,{shunt:{enabled:false},expectedConfigRevision:shuntSetup.session.configRevision},'PATCH');
  await api('/workspace-preferences',{workspace:settings.workspace,providerId:'fixture',model:'test-model',shunt:{enabled:false}});
  await save('03-start');
  terminal.write('/settings\r');await waitFor(()=>screen().includes('API connections and ChatGPT sign-in'),'settings menu');
  terminal.write('\x1b[H\r');await waitFor(()=>screen().includes('+ Add provider'),'providers menu');
  terminal.write('\x1b[H\x1b[B\r');await waitFor(()=>screen().includes('Claude caching aliases:'),'provider editor');
  terminal.write('\x1b[F\x1b[A\r');await waitFor(()=>screen().includes('Claude model aliases (one per line)'),'cache aliases editor');
  terminal.write('team/coding\nreader-alias');await waitFor(()=>screen().includes('reader-alias'),'cache aliases typed');terminal.write('\x13');
  await waitFor(()=>screen().includes('Claude caching aliases: team/coding, reader-alias'),'cache aliases returned');await save('03-cache-aliases');
  terminal.write('\x1b[F\r');await waitFor(async()=>JSON.stringify((await api('/settings')).providers[0].anthropicCacheModels)===JSON.stringify(['team/coding','reader-alias']),'cache aliases persisted');
  await waitFor(()=>screen().includes('+ Add provider'),'provider save finished');terminal.write('\x1b');await waitFor(()=>screen().includes('API connections and ChatGPT sign-in'),'back to settings');terminal.write('\x1b');
  await waitFor(()=>!screen().includes('API connections and ChatGPT sign-in'),'settings closed');
  const configured=await api(`/sessions/${session.id}`);await api(`/sessions/${session.id}`,{architecture:null,expectedConfigRevision:configured.session.configRevision},'PATCH');
  terminal.write('create fixture\r');await waitFor(()=>screen().includes('1 Allow once'),'prompt');await save('04-permissions');terminal.write('4');
  await waitFor(async()=>{const d=await api(`/sessions/${session.id}`);return d.session.status==='idle'&&d.session.permissionMode==='auto';},'allow all while waiting');
  const live=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null,permissionMode:'auto'});await launch(live,100,32);
  terminal.write('LIVE_STEPS_BROWSER\r');
  await waitFor(()=>screen().split('\n').filter(line=>line.includes('Read README.md')||line.includes('Read src/hello.ts')).length>=5,'consecutive tools visible without Inspect');
  assert(!screen().includes('Inspect'));
  await new Promise(done=>setTimeout(done,200));
  clickLine('Read README.md');
  await waitFor(()=>screen().includes('A small project for browser tests.'),'tool result opens inline on click');await save('04-inline-tools');
  clickLine('Read README.md');
  await waitFor(()=>!screen().includes('A small project for browser tests.'),'tool result collapses on second click');
  await fetch(base+'/fixture/delegations/release',{method:'POST'});
  await waitFor(async()=>(await api(`/sessions/${live.id}`)).session.status==='idle','tool run finishes');
  terminal.write('\x1bo');await waitFor(()=>screen().includes('A small project for browser tests.'),'Alt+O opens completed activity');
  for(const [kind,label] of [['team-fusion','Worker'],['expert-fusion','Expert'],['sidekick-fusion','Sidekick']]){
    const architecture={kind,[kind==='team-fusion'?'worker':kind==='expert-fusion'?'expert':'sidekick']:{providerId:'fixture',model:'test-fast'}};
    const next=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture,permissionMode:label==='Sidekick'?'ask':'auto'});await launch(next,100,38);
    terminal.write((label==='Sidekick'?'SIDEKICK_BROWSER HOLD_CHILD':'WORKERS_BROWSER')+'\r');
    if(label==='Sidekick'){
      await waitFor(()=>screen().includes('Driver wants to ask Sidekick'),'sidekick permission');terminal.write('1');
      await waitFor(()=>screen().includes('wants to write a file'),'sidekick action');
      await waitFor(()=>screen().split('\n').some(line=>line.trim()==='Sidekick'),'sidekick identity visible');
      await waitFor(()=>screen().includes('Write sidekick-note.txt'),'sidekick card opens its bound invocation by default');await save('07-sidekick');clickLine('▾',screen().split('\n').findIndex(line=>line.trim()==='Sidekick')+1);
      await waitFor(()=>!screen().includes('Write sidekick-note.txt'),'sidekick card collapses without resolving its permission');terminal.write('4');
    }else{
      await waitFor(()=>screen().split('\n').some(line=>line.trim()===label+' 1')&&screen().split('\n').some(line=>line.trim()===label+' 2'),'both worker cards');
      await waitFor(()=>screen().includes('beta is inspecting its assignment.'),'worker card opens its bound child transcript by default');
      assert(!screen().includes('A small project for browser tests.'));
      let card=screen().split('\n').findIndex(line=>line.trim()===label+' 2');
      await waitFor(()=>screen().split('\n').some((line,index)=>index>card&&line.includes('1 step')),'child work log is visible');
      await new Promise(done=>setTimeout(done,150));card=screen().split('\n').findIndex(line=>line.trim()===label+' 2');clickLine('▸ 1 step',card+1);
      await waitFor(()=>screen().includes('Read README.md'),'child work log opens');clickLine('Read README.md',card+1);
      await waitFor(()=>screen().includes('A small project for browser tests.'),'child tool result opens inline');await save('05-'+label.toLowerCase()+'s');
      terminal.write('\x1b[5~');await new Promise(done=>setTimeout(done,150));
      assert(screen().includes('beta is inspecting its assignment.'),'Page Up reads the shared conversation');
      terminal.write('\x07');await new Promise(done=>setTimeout(done,150));
      card=screen().split('\n').findIndex(line=>line.trim()===label+' 2');clickLine('Read README.md',card+1);
      await waitFor(()=>!screen().includes('A small project for browser tests.'),'child tool result collapses');
      terminal.resize(80,24);emulator.resize(80,24);await new Promise(done=>setTimeout(done,300));await save('06-'+label.toLowerCase()+'s-narrow-expanded');
      terminal.resize(100,38);emulator.resize(100,38);
      await fetch(base+'/fixture/delegations/release',{method:'POST'});
      await waitFor(()=>screen().includes('Driver report: both assignments are complete.'),'driver receives completed workers');
      await waitFor(()=>screen().split('\n').some(line=>line.trim()===label+' 2'),'completed worker identity remains visible');
      card=screen().split('\n').findIndex(line=>line.trim()===label+' 2');
      clickLine('▸ 1 step',card+1);
      await waitFor(()=>screen().includes('beta is inspecting its assignment.'),'completed worker reopens directly');
      await waitFor(()=>screen().includes('beta final report: inspection complete.'),'completed child transcript keeps its final update');clickLine('▾ 1 step',screen().split('\n').findIndex(line=>line.trim()===label+' 2')+1);
      await waitFor(()=>!screen().includes('beta is inspecting its assignment.'),'worker card collapses without stopping work');
    }
    await fetch(base+'/fixture/delegations/release',{method:'POST'});
    await waitFor(async()=>(await api(`/sessions/${next.id}`)).session.status==='idle','workers finish');
  }
  for(const kind of ['single','team-fusion','expert-fusion']){
    const architecture=kind==='single'?null:{kind,[kind==='team-fusion'?'worker':'expert']:{providerId:'fixture',model:'test-fast'}};
    const shuntSession=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture,permissionMode:'auto',shunt:{enabled:true,model:{providerId:'fixture',model:'budget-model'}}});await launch(shuntSession,120,42);
    terminal.write((kind==='single'?'SHUNT_BROWSER':'SHUNT_WORKERS')+'\r');
    await waitFor(()=>screen().includes('fixture exports a greeting'),'Shunt result visible inline');
    if(kind!=='single')await waitFor(()=>screen().split('Shunt reader').length>=3,'Shunt appears in both workers');
    assert(!screen().includes('Inspect'));await save('07-shunt-'+kind);
    await fetch(base+'/fixture/delegations/release',{method:'POST'});
    await waitFor(async()=>(await api(`/sessions/${shuntSession.id}`)).session.status==='idle','Shunt finishes');
  }
  const copySession=await api('/sessions/import',{session:{title:'Clipboard',providerId:'fixture',model:'test-model'},messages:[{id:'copy-answer',role:'assistant',content:'Clipboard selection Ω ready.',createdAt:1}]});
  await launch(copySession,100,32);await waitFor(()=>screen().includes('Clipboard selection Ω ready.'),'copyable response');
  const copyRows=screen().split('\n'),copyY=copyRows.findIndex(line=>line.includes('Clipboard selection Ω ready.'))+1,copyX=copyRows[copyY-1].indexOf('Clipboard selection Ω ready.')+1;
  terminal.write(`\x1b[<0;${copyX};${copyY}M`);await new Promise(done=>setTimeout(done,80));
  terminal.write(`\x1b[<32;${copyX+20};${copyY}M`);await new Promise(done=>setTimeout(done,80));
  terminal.write(`\x1b[<0;${copyX+20};${copyY}m`);
  await waitFor(async()=>{try{return (await readFile(clipboard,'utf8')).includes('Clipboard selection');}catch{return false;}},'selection copied automatically');
  const selected=await readFile(clipboard,'utf8');assert(selected.includes('Ω'));
  await writeFile(clipboard,'');terminal.write('\x1b[99;9u');
  await waitFor(async()=>(await readFile(clipboard,'utf8'))===selected,'Command+C copies selection');
  await writeFile(clipboard,'');terminal.write('\x1b[99;6u');
  await waitFor(async()=>(await readFile(clipboard,'utf8'))===selected,'Ctrl+Shift+C copies selection');
  await save('07-selection-copy');console.log('TUI clipboard passed: selection release, Unicode, Command+C, Ctrl+Shift+C, native clipboard stdin.');
  const imported=await api('/sessions/import',{session:{title:'Long conversation',providerId:'fixture',model:'test-model',permissionMode:'ask'},messages:Array.from({length:240},(_,i)=>({id:`history-${i}`,role:i%2?'assistant':'user',content:i%2?'A completed answer.\n\n```typescript\n'+Array.from({length:30},(_,n)=>`const value${n} = ${n};`).join('\n')+'\n```':'Inspect these files.',createdAt:i+1}))});
  await launch(imported,100,32);await new Promise(done=>setTimeout(done,250));
  const started=performance.now();terminal.write('Draft stays responsive');await waitFor(()=>screen().includes('Draft stays responsive'),'typing through long history');
  console.log(`Typing latency with 240 historical messages: ${Math.round(performance.now()-started)} ms.`);
  await api('/workspace-preferences',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null,setupComplete:false});
  const fresh=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:null});
  await api('/settings',{providers:[],defaultModel:''},'PATCH');await launch(fresh,80,24);
  await waitFor(()=>screen().includes('Gateway base URL')&&screen().includes('Enter save'),'fresh gateway prompt');assert(!screen().includes('localhost:4000'));await save('08-fresh-gateway');
  terminal.write(settings.providers[0].baseUrl+'/setup-auth\r');
  await waitFor(()=>screen().includes('LiteLLM API key'),'enter fresh key');terminal.write('wrong-key\r');
  await waitFor(()=>screen().includes('HTTP 401'),'gateway error stays in setup');assert.equal((await api('/settings')).providers.length,0);
  terminal.write('\x1b[H\r');await waitFor(()=>screen().includes('LiteLLM API key'),'correct key');terminal.write('fixture-key\r');
  await waitFor(()=>screen().includes('Choose your setup'),'fresh recommended setup');assert(screen().includes('Sidekick Fusion'));assert(screen().includes('Recommended'));await save('09-recommended-setup');
  terminal.write('\x1b[H\x1b[B\r');await waitFor(()=>screen().includes('powerful reasoning'),'driver chooser');assert(screen().includes('powerful reasoning'));terminal.write('test-model');await waitFor(()=>screen().includes('› test-model'),'driver found');terminal.write('\r');
  await waitFor(()=>screen().includes('Driver: test-model'),'driver chosen');terminal.write('\x1b[H\x1b[B\x1b[B\r');await waitFor(()=>screen().includes('efficient coding workhorse'),'sidekick guidance');terminal.write('test-fast');await waitFor(()=>screen().includes('› test-fast'),'sidekick found');terminal.write('\r');
  await waitFor(()=>screen().includes('Sidekick: test-fast'),'sidekick chosen');await save('09-recommended-models');terminal.write('\x1b[F\r');
  await waitFor(async()=>(await api('/workspace-preferences?workspace='+encodeURIComponent(settings.workspace))).setupComplete===true,'fresh setup persisted');
  const freshSettings=await api('/settings');assert.equal(freshSettings.providers[0].baseUrl,settings.providers[0].baseUrl+'/setup-auth');assert(!JSON.stringify(freshSettings).includes('fixture-key'));
  assert.equal(freshSettings.defaultModel,'test-model');assert.equal((await api('/workspace-preferences?workspace='+encodeURIComponent(settings.workspace))).architecture.kind,'sidekick-fusion');
  const next=await api('/sessions',{workspace:settings.workspace+'/src'});await launch(next,80,24);await waitFor(()=>screen().includes('A fresh start.'),'next folder opens chat');assert(!screen().includes('Gateway base URL'));assert.equal(next.model,'test-model');assert.equal(next.architecture.kind,'sidekick-fusion');assert.equal(next.architecture.sidekick.model,'test-fast');await save('10-next-folder-ready');
  console.log('Fresh TUI gateway setup passed: blank URL, masked key, failed authentication, model discovery, and saved setup.');
  console.log('TUI interactions passed: first-run setup, saved models, live Allow all, two workers, two experts, Sidekick handoff, and narrow/wide rendering.');
}finally{await stopTerminal();await browser?.close();server.kill('SIGTERM');await rm(config,{recursive:true,force:true});}
