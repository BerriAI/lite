/** Real terminal acceptance checks for queued input, recall, and interruption. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import xterm from '@xterm/headless';

const root=resolve(import.meta.dirname,'..'), artifacts=join(root,'test-results-tui','queue');
await mkdir(artifacts,{recursive:true});
const config=await mkdtemp(join(tmpdir(),'litespeed-tui-queue-'));
const server=spawn(process.execPath,['--import','tsx','scripts/e2e-server.ts'],{cwd:root,env:{...process.env,LITESPEED_E2E_PORT:'0',LITESPEED_E2E_NO_VITE:'1'},stdio:['ignore','pipe','pipe']});
let log='',terminal,emulator;
server.stdout.on('data',chunk=>log+=chunk);server.stderr.on('data',chunk=>log+=chunk);
const screen=()=>emulator?Array.from({length:emulator.rows},(_,row)=>emulator.buffer.active.getLine(emulator.buffer.active.viewportY+row)?.translateToString(true)??'').join('\n'):'';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,label){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await delay(60);}throw new Error(`${label}\n${screen()}\n${log.slice(-1500)}`);}
const save=name=>writeFile(join(artifacts,name+'.txt'),screen());
try {
  await waitFor(()=>/ready at (http:\/\/\S+)/.test(log),'fixture ready');
  const base=log.match(/ready at (http:\/\/\S+)/)[1];
  const api=async(path,body)=>{const response=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert(response.ok,JSON.stringify(data));return data;};
  const settings=await api('/settings');
  for(const [cols,rows] of [[110,36],[80,24]]) {
    const session=await api('/sessions',{workspace:settings.workspace,title:`Queued input ${cols}`});
    const detail=()=>api('/sessions/'+session.id);
    emulator=new xterm.Terminal({cols,rows,allowProposedApi:true});
    terminal=pty.spawn(process.execPath,['bin/litespeed.mjs','tui','--url',base,'--session',session.id],{cwd:root,cols,rows,name:'xterm-256color',env:{...process.env,TERM:'xterm-256color',LITESPEED_DISABLE_PROJECT_CONFIG:'1',LITESPEED_CONFIG_DIR:config,XDG_CONFIG_HOME:config,XDG_STATE_HOME:config}});
    const display=emulator;terminal.onData(chunk=>display.write(chunk));
    await waitFor(()=>screen().includes('Ask Litespeed to do something'),'composer ready');
    terminal.write('TUI_QUEUE_HOLD\r');
    await waitFor(()=>screen().includes('Waiting for an interrupt.'),'stream is held');
    terminal.write('First queued message\r');
    await waitFor(async()=>(await detail()).queue.items.length===1&&screen().includes('Press Up to edit'),'first message queued');
    terminal.write('Second queued message\r');
    await waitFor(async()=>(await detail()).queue.items.length===2&&screen().includes('Press Up to edit'),'second message queued');
    await api(`/sessions/${session.id}/queue`,{content:'Attached queued message',attachments:[{name:'queued.txt',content:'SNAPSHOT_CONTENT'}]});
    await waitFor(()=>screen().includes('Attached queued message')&&screen().includes('3 queued'),'all queued previews visible');
    await save(`queued-${cols}`);
    assert.equal((await detail()).session.status,'running');

    // Ordinary cursor movement on a later row must not take queued input back.
    terminal.write('keep my draft\x0asecond draft line');
    await waitFor(()=>screen().includes('second draft line'),'multiline draft');
    terminal.write('\x1b[A');await delay(150);
    assert.equal((await detail()).queue.items.length,3);
    terminal.write('\x1b[H\x1b[A');
    await waitFor(async()=>(await detail()).queue.items.length===0&&screen().includes('queued.txt'),'Up recalls input and attachment');
    await save(`recalled-${cols}`);
    assert.equal((await detail()).session.status,'running');
    terminal.write('\x1b[F edited\r');
    await waitFor(async()=>(await detail()).queue.items.length===1&&screen().includes('Press Up to edit'),'edited input requeued');
    const expected='First queued message\nSecond queued message\nAttached queued message\nkeep my draft\nsecond draft line edited';
    let state=await detail();assert.equal(state.queue.items[0].content,expected);
    assert.equal(state.queue.items[0].attachments[0].content,'SNAPSHOT_CONTENT');
    terminal.write('Final queued message\r');
    await waitFor(async()=>(await detail()).queue.items.length===2&&screen().includes('Press Up to edit'),'another queued message');

    // Suggestions and dialogs consume Escape before the session interrupt.
    terminal.write('/mo');await waitFor(()=>screen().includes('/models')&&screen().includes('/mode'),'slash suggestions');
    terminal.write('\x1b');await delay(150);
    assert.equal((await detail()).session.status,'running');assert.equal((await detail()).queue.items.length,2);
    terminal.write('\x15/queue\r');await waitFor(()=>screen().includes('Queued messages')&&screen().includes('Pause queue'),'queue dialog');
    terminal.write('\x1b');await waitFor(()=>!screen().includes('Pause queue'),'dialog closed');
    assert.equal((await detail()).session.status,'running');
    terminal.write('unsent draft');await waitFor(()=>screen().includes('unsent draft'),'draft while queue waits');
    terminal.write('\x1b');
    await waitFor(async()=>{state=await detail();return state.session.status==='idle'&&state.queue.items.length===0;},'single Escape interrupts and drains queue');
    assert.deepEqual(state.messages.filter(message=>message.role==='user').map(message=>message.content),['TUI_QUEUE_HOLD',expected,'Final queued message']);
    assert.equal(state.messages.find(message=>message.content===expected).attachments[0].content,'SNAPSHOT_CONTENT');
    await waitFor(()=>screen().includes('unsent draft')&&screen().includes('idle'),'unsent draft preserved');
    await save(`interrupted-${cols}`);
    console.log(`PASS ${cols}x${rows}: previews, first-row Up recall, multiline draft and attachments, requeue, Escape focus, FIFO promotion`);
    terminal.kill();terminal=undefined;await delay(100);emulator.dispose();emulator=undefined;
  }
} finally {
  if(emulator)await save('failure');
  terminal?.kill();emulator?.dispose();server.kill('SIGTERM');
  await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
  await rm(config,{recursive:true,force:true});
}
