import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createViteServer } from 'vite';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { attachTerminals } from '../server/terminal.js';

const root=await mkdtemp(join(tmpdir(),'lite-e2e-'));
await mkdir(join(root,'src'));await writeFile(join(root,'src','hello.ts'),'export const hello = "world";\n');await writeFile(join(root,'README.md'),'# Fixture project\nA small project for browser tests.\n');
let providerRequests=0;
const mock=createServer(async(req,res)=>{
  if(req.url?.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'},{id:'test-fast'}]}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);let data:any;
  try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end();return;}
  providerRequests++;
  const lastUser=data.messages.filter((m:any)=>m.role==='user').at(-1)?.content||'';
  const prompt=typeof lastUser==='string'?lastUser:JSON.stringify(lastUser);
  if(prompt.includes('provider failure')){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture provider rejected the request.'}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(delta:any,finish_reason?:string)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`);
  let toolCall=false;
  if(prompt.includes('ask fixture question')&&data.messages.at(-1)?.role!=='tool'){
    toolCall=true;emit({tool_calls:[{index:0,id:'fixture-question',type:'function',function:{name:'ask_user',arguments:JSON.stringify({question:'Which storage should this project use?',options:[{id:'sqlite',label:'SQLite',description:'A local database with no extra service.'},{id:'postgres',label:'PostgreSQL',description:'A separate database server.'}]})}}]});
  }else if(prompt.includes('ask fixture question')&&prompt.includes('then write')&&data.messages.at(-1)?.tool_call_id==='fixture-question'){
    toolCall=true;emit({tool_calls:[{index:0,id:'fixture-after-answer',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'answered.txt',content:'The answer did not grant tool permission.\n'})}}]});
  }else if(prompt.includes('create fixture')&&data.messages.at(-1)?.role!=='tool'){
    toolCall=true;emit({tool_calls:[{index:0,id:'fixture-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'result.txt',content:`Created by the browser test.\n${prompt}\n`})}}]});
  }else{
    emit({reasoning_content:'Checking the request and preparing a clear response.'});
    const text=prompt.includes('ask fixture question')?'Your answer is saved. Continuing with your choice.':prompt.includes('create fixture')?'The file operation is complete. Check the activity card for its result.':prompt.includes('Summarize this coding session')?'The user asked for a fixture response. A small test workspace is available. Continue from here.':'Hello from Lite.\n\nYour workspace is ready. Here is a small example:\n\n```typescript\nconst answer = 42;\n```';
    for(const part of text.match(/.{1,12}|\n/g)||[]){if(res.destroyed)return;emit({content:part});await new Promise(r=>setTimeout(r,prompt.includes('slow response')?150:15));}
  }
  emit({},toolCall?'tool_calls':'stop');res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:25,completion_tokens:35}})}\n\n`);res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve=>mock.listen(0,'127.0.0.1',resolve));
const store=new Store(join(root,'state'));
store.saveSettings({workspace:root,providers:[{id:'fixture',name:'Test gateway',kind:'openai',baseUrl:`http://127.0.0.1:${(mock.address() as any).port}`,apiKey:'fixture-key'}],defaultProvider:'fixture',defaultModel:'test-model'});
const{app,runner}=createApp({store});
app.get('/fixture/requests',(_req,res)=>res.json({count:providerRequests}));
const vite=await createViteServer({server:{middlewareMode:true,hmr:{port:24679}},appType:'spa'});app.use(vite.middlewares);
const server=app.listen(3211,'127.0.0.1',()=>console.log('Lite E2E ready at http://127.0.0.1:3211'));
const terminals=attachTerminals(server,store);
let closing=false;
async function close(){if(closing)return;closing=true;runner.stopAll();await Promise.all([runner.whenIdle(),terminals.close()]);server.closeAllConnections();server.close();mock.closeAllConnections();mock.close();await vite.close();store.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
