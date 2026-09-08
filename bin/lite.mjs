#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),command=args[0]||'serve';
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
const base=option('--url',process.env.LITE_URL||`http://localhost:${process.env.LITE_PORT||3210}`);
async function api(path,body){const response=await fetch(`${base}/api${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;}
async function runPrompt(prompt){
  const sessionId=option('--session');
  const session=sessionId?{id:sessionId}:await api('/sessions',{workspace:process.cwd(),model:option('--model'),providerId:option('--provider'),mode:args.includes('--plan')?'plan':'build',permissionMode:args.includes('--auto')?'auto':'ask'});
  const controller=new AbortController();
  const events=await fetch(`${base}/api/sessions/${session.id}/events`,{signal:controller.signal});
  if(!events.ok)throw new Error('Could not connect to session stream.');
  const interrupt=()=>{void api(`/sessions/${session.id}/cancel`,{});controller.abort();};
  process.once('SIGINT',interrupt);
  try{
    await api(`/sessions/${session.id}/messages`,{content:prompt});
    let buffer='';const decoder=new TextDecoder();
    for await(const chunk of events.body){
      buffer+=decoder.decode(chunk,{stream:true});let boundary;
      while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const line=frame.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;const event=JSON.parse(line.slice(6));
        if(args.includes('--json'))console.log(JSON.stringify(event));
        else if(event.type==='delta')process.stdout.write(event.data.delta);
        else if(event.type==='tool'&&event.data.tool.status==='running')process.stderr.write(`\n  ≋ ${event.data.tool.name}\n`);
        else if(event.type==='error'){process.stderr.write(`\n${event.data.message}\n`);process.exitCode=1;}
        if(event.type==='permission'){
          const p=event.data;
          if(!process.stdin.isTTY){await api(`/sessions/${session.id}/permissions/${p.id}`,{decision:'deny'});process.stderr.write(`\nDenied ${p.tool}: interactive approval required (or explicitly use --auto).\n`);}
          else{const rl=createInterface({input:process.stdin,output:process.stderr});const answer=await rl.question(`\nAllow ${p.tool} ${JSON.stringify(p.args)}? [y/N] `);rl.close();await api(`/sessions/${session.id}/permissions/${p.id}`,{decision:/^y(es)?$/i.test(answer.trim())?'allow':'deny'});}
        }
        if(event.type==='done'){controller.abort();if(!args.includes('--json'))process.stdout.write('\n');process.stderr.write(`\nSession: ${session.id}\n`);return;}
      }
    }
  }finally{controller.abort();process.removeListener('SIGINT',interrupt);}
}
try{
  if(['help','--help','-h'].includes(command))console.log(`\n≋ Lite — your ideas, up to speed.\n\n  lite [serve]              Start the local app\n  lite run "your prompt"    Run a coding task on a running server\n  lite sessions            List recent sessions\n  lite models              List available models\n  lite export <session>    Export a session as JSON\n\nOptions: --port 3210, --url URL, --model ID, --provider ID,\n         --session ID, --plan, --auto, --json\n\nTools ask for approval by default. --auto explicitly allows shell\ncommands and edits; it is not a sandbox. Keys stay server-side.\n`);
  else if(command==='serve'){
    const entry=existsSync(resolve(root,'dist/server/index.js'))?['dist/server/index.js']:['--import','tsx','server/index.ts'];
    const child=spawn(process.execPath,entry.map(v=>v.startsWith('dist/')||v.startsWith('server/')?resolve(root,v):v),{cwd:root,stdio:'inherit',env:{...process.env,LITE_WORKSPACE:option('--workspace',process.cwd()),LITE_PORT:option('--port',process.env.LITE_PORT||'3210')}});
    child.on('exit',code=>{process.exitCode=code||0;});
    process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
  }else if(command==='run'){
    const prompt=args[1];if(!prompt||prompt.startsWith('--'))throw new Error('Usage: lite run "your prompt" [--model ID]');await runPrompt(prompt);
  }else if(command==='sessions'){for(const s of(await api('/sessions')).sessions)console.log(`${s.id}  ${s.status.padEnd(8)}  ${s.title}`);}
  else if(command==='models'){const p=option('--provider');for(const m of(await api(`/models${p?'?providerId='+encodeURIComponent(p):''}`)).models)console.log(`${m.id}  (${m.providerId})`);}
  else if(command==='export'){if(!args[1])throw new Error('Usage: lite export <session-id>');console.log(JSON.stringify(await api(`/sessions/${encodeURIComponent(args[1])}/export`),null,2));}
  else throw new Error(`Unknown command: ${command}. Use lite --help.`);
}catch(error){if(error.name!=='AbortError'){console.error(`Lite: ${error.cause?.code==='ECONNREFUSED'?'Start the local server with lite serve first.':error.message}`);process.exitCode=1;}}
