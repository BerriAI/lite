import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { chromium } from '@playwright/test';
const root=resolve(import.meta.dirname,'..'), baseline=process.argv.includes('--baseline');
const artifacts=join(root,'test-results-tui',baseline?'flow-before':'flow-after');await mkdir(artifacts,{recursive:true});
const config=await mkdtemp(join(tmpdir(),'litespeed-flow-'));
const server=spawn(process.execPath,['--import','tsx','scripts/e2e-server.ts'],{cwd:root,env:{...process.env,LITESPEED_E2E_PORT:'0',LITESPEED_E2E_NO_VITE:'1'},stdio:['ignore','pipe','pipe']});
let log='',terminal,emulator,browser,frames=[],previous='';
server.stdout.on('data',chunk=>log+=chunk);server.stderr.on('data',chunk=>log+=chunk);
const screen=()=>emulator?Array.from({length:emulator.rows},(_,row)=>emulator.buffer.active.getLine(emulator.buffer.active.viewportY+row)?.translateToString(true,0,emulator.cols)??'').join('\n'):'';
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function waitFor(check,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(60);}throw new Error(label+'\n'+screen()+'\n'+log.slice(-1000));}
function record(){const text=screen();if(text!==previous){frames.push({at:Date.now(),cols:emulator.cols,rows:emulator.rows,text});previous=text;}}
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function save(name){
  await writeFile(join(artifacts,name+'.txt'),screen());
  if(!browser)return;
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

try{
 await waitFor(()=>/ready at (http:\/\/\S+)/.test(log),'fixture');const base=log.match(/ready at (http:\/\/\S+)/)[1];
 const api=async(path,body,method)=>{const res=await fetch(base+'/api'+path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await res.json();assert(res.ok,JSON.stringify(value));return value;};
 const settings=await api('/settings');if(!process.env.CI)browser=await chromium.launch({channel:'chrome',headless:true});
 const session=await api('/sessions',{workspace:settings.workspace,providerId:'fixture',model:'test-model',architecture:{kind:'sidekick-fusion',sidekick:{providerId:'fixture',model:'test-fast'}},permissionMode:'ask'});
 emulator=new xterm.Terminal({cols:120,rows:38,allowProposedApi:true});
 terminal=pty.spawn(process.execPath,['bin/litespeed.mjs','tui','--url',base,'--session',session.id],{cwd:root,cols:120,rows:38,name:'xterm-256color',env:{...process.env,TERM:'xterm-256color',LITESPEED_DISABLE_PROJECT_CONFIG:'1',XDG_CONFIG_HOME:config,XDG_STATE_HOME:config}});
 terminal.onData(chunk=>emulator.write(chunk,record));await waitFor(()=>screen().includes('Ask Litespeed to do something…')&&screen().includes('Ctrl+P Commands'),'TUI composer starts');
 if(!baseline)assert(screen().split('\n')[0].includes('test-model + sidekick'),'model selection names the companion architecture');
 terminal.write('TUI_FLOW_DRIVER inspect and update the note.\r');
 let approved=new Set(),captured=false,childRequest=false;
 await waitFor(async()=>{
  const detail=await api('/sessions/'+session.id);
  for(const p of detail.permissions){
   if(approved.has(p.id))continue;
   await delay(400);await save('approval-'+p.tool);
   if(!baseline){
    assert(screen().includes(' wants to '),'approval explains the action');
    assert(screen().split('\n').some(line=>line.includes('1 Allow once')&&line.includes('4 Allow all tools')),'approval choices share one row');
    assert(!screen().includes('"content":')&&!screen().includes('"todos":'),'approval does not expose raw arguments');
   }
   if(p.tool==='write_file'){
    childRequest=true;await save('sidekick-writing');
    if(!baseline){assert(screen().includes('Project inspection complete.'));assert(screen().includes('Sidekick · 1/3 done'));}

    terminal.resize(80,24);emulator.resize(80,24);await delay(250);await save('sidekick-narrow');if(!baseline){assert(screen().split('\n').slice(0,4).join('\n').includes('Update the project note'),'current task stays pinned on narrow terminals');assert(screen().split('\n').some(line=>line.includes('1 Allow once')&&line.includes('4 Allow all tools')),'approval choices fit on one row at 80 columns');}
    if(!baseline)assert(screen().split('\n')[0].includes('+ sidekick'),'companion remains visible on narrow terminals');
    terminal.resize(120,38);emulator.resize(120,38);await delay(250);
   }
   approved.add(p.id);terminal.write('1');
  }
  if(!captured&&screen().includes('Inspection line 8')){captured=true;await save('sidekick-streaming');
   if(!baseline){
    terminal.write('\x1b[5~');await delay(250);
    const anchor=screen().split('\n')[3].slice(0,88);
    await delay(600);assert.equal(screen().split('\n')[3].slice(0,88),anchor,'new output must not move a reader who scrolled up');
    await save('reading-earlier');terminal.write('\x07');await delay(250);
   }
  }
  return detail.messages.some(m=>m.content.includes('Driver report: the project note is verified.'))&&detail.session.status==='idle';
 },'Sidekick turn finishes',120000);
 await delay(200);await save('complete');assert(childRequest);assert.equal(await readFile(join(settings.workspace,'sidekick-note.txt'),'utf8'),'Project inspection complete.\nThe note records the observed result.\nNo configuration changes are needed.\n');
 if(!baseline){
  const reasoningFrames=frames.filter(frame=>frame.text.includes('Driver reasoning')&&frame.text.includes('Driver explains the plan.'));
  assert(reasoningFrames.length>0);
  for(const frame of reasoningFrames)assert(frame.text.indexOf('Driver reasoning')<frame.text.indexOf('Driver explains the plan.'),'reasoning stays before the response');
  assert(!frames.some(frame=>frame.text.includes('Driver → Sidekick')),'no duplicate handoff heading');
  assert(frames.some(frame=>frame.text.includes('Thinking…')),'captures active reasoning');
  assert(!frames.some(frame=>frame.text.includes('Sidekick · Thinking')),'task progress does not repeat the thinking indicator');
  assert(frames.every(frame=>(frame.text.match(/Thinking…/g)??[]).length<=1),'one thinking indicator during this sequential handoff');
  assert(screen().includes('Driver · 2/2 done')&&screen().includes('Sidekick · 3/3 done'),'task completion remains visible');
  const lines=screen().split('\n'), actor=lines.findIndex(line=>/^\s*Sidekick\s*(?:│.*)?$/.test(line));
  assert(actor>=0&&lines[actor+1].includes('▸ 5 steps · completed'),'Sidekick identity stays above its collapsed steps');
  assert(lines.slice(actor+2).some(line=>/^\s*Driver\s*(?:│.*)?$/.test(line)),'Driver is labeled again after the handoff');
  assert(!lines[actor+1].includes('Sidekick'),'the activity row does not repeat the agent name');
  assert(!screen().includes('Changes haven’t been checked')&&!screen().includes('Checks need attention'),'no generic verification footer');
  assert(screen().includes('Cache unavailable'),'unknown cache usage is not presented as a zero hit rate');
  assert(screen().includes('test-model + sidekick · 660 tokens'),'family usage names both driver and companion');
  terminal.write('CACHE_HIT_BROWSER show reported cache usage\r');
  await waitFor(()=>screen().includes('80% cache hit')&&screen().includes('idle'),'cache hit percentage appears beside tokens');await save('cache-hit');
  await waitFor(()=>screen().includes('Ask Litespeed to do something…'),'composer is ready after cache response');
  terminal.write('CACHE_PARTIAL_BROWSER report interrupted usage\r');
  await waitFor(()=>screen().includes('60 tokens reported · 80% cache hit'),'an interrupted request does not hide previous cache reports');await save('cache-partial');

 }
 await writeFile(join(artifacts,'frames.jsonl'),frames.map(frame=>JSON.stringify(frame)).join('\n'));
 console.log('Captured '+frames.length+' frames across real driver/Sidekick tools, tasks, approvals, and streamed text.');
}finally{await writeFile(join(artifacts,'frames.jsonl'),frames.map(frame=>JSON.stringify(frame)).join('\n'));terminal?.kill();emulator?.dispose();await browser?.close();server.kill('SIGTERM');await rm(config,{recursive:true,force:true});}
