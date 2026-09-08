import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createViteServer } from 'vite';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { attachTerminals } from '../server/terminal.js';
import { McpManager } from '../server/mcp.js';

const root=await mkdtemp(join(tmpdir(),'lite-e2e-'));
await mkdir(join(root,'src'));await writeFile(join(root,'src','hello.ts'),'export const hello = "world";\n');await writeFile(join(root,'README.md'),'# Fixture project\nA small project for browser tests.\n');
let providerRequests=0;
const profileRequests:{model:string;messages:any[];tools:any[]}[]=[];
const pendingSummaries=new Set<()=>void>();
const delegationRequests:{model:string;messages:any[];tools:any[]}[]=[];
const pendingDelegations=new Set<()=>void>();
const mock=createServer(async(req,res)=>{
  if(req.url?.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'},{id:'test-fast'},{id:'budget-model',context_window:16384}]}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);let data:any;
  try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{res.writeHead(400);res.end();return;}
  providerRequests++;
  const lastUser=data.messages.filter((m:any)=>m.role==='user').at(-1)?.content||'';
  const prompt=typeof lastUser==='string'?lastUser:JSON.stringify(lastUser);
  if(prompt.includes('PROFILE_BROWSER')){profileRequests.push({model:data.model,messages:data.messages,tools:data.tools||[]});if(profileRequests.length>30)profileRequests.shift();}
  if(prompt.includes('DELEGATE_BROWSER')||prompt.includes('DELEGATE_CHILD')){delegationRequests.push({model:data.model,messages:data.messages,tools:data.tools||[]});if(delegationRequests.length>100)delegationRequests.shift();}
  if(prompt.includes('provider failure')||(prompt.includes('DELEGATE_CHILD')&&prompt.includes('CHILD_FAILURE'))){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture provider rejected the request.'}}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const emit=(delta:any,finish_reason?:string)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`);
  let toolCall=false;
  const summarizing=data.messages.some((message:any)=>message.role==='system'&&typeof message.content==='string'&&message.content.includes('Summarize the supplied conversation data'));
  if(summarizing){
    if(prompt.includes('WAIT_BUDGET_SUMMARY')) {
      await new Promise<void>(resolve=>{const release=()=>{pendingSummaries.delete(release);res.off('close',release);resolve();};pendingSummaries.add(release);res.once('close',release);});
      if(res.destroyed)return;
    }
    if(!prompt.includes('EMPTY_BUDGET_SUMMARY'))emit({content:'Earlier context: the user discussed a local fixture project and wants accurate, tested changes. Preserve the latest user request and continue. No tools or tests were run while summarizing.'});
  }else if(prompt.includes('DELEGATE_CHILD')){
    if(data.messages.at(-1)?.role!=='tool'){
      const name=prompt.includes('FORCE_WRITE')?'write_file':prompt.includes('FORCE_NESTED')?'task':prompt.includes('FORCE_QUESTION')?'ask_user':'read_file';
      const args=name==='write_file'?{path:'child-forbidden.txt',content:'Child writes must never execute.'}:name==='task'?{description:'Forbidden nested research',prompt:'This nested task must never run.'}:name==='ask_user'?{question:'This child must not ask.',options:[{id:'no',label:'No'}]}:{path:'research.txt'};
      toolCall=true;emit({tool_calls:[{index:0,id:'delegated-read',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    }else{
      emit({content:'Researcher is reviewing the observed tool result.\n\n'});
      if(prompt.includes('HOLD_CHILD')){
        await new Promise<void>(resolve=>{const release=()=>{pendingDelegations.delete(release);res.off('close',release);resolve();};pendingDelegations.add(release);res.once('close',release);});
        if(res.destroyed)return;
      }
      emit({content:`Research result: ${data.messages.at(-1).content}\n\nThis researcher made no file changes.`});
    }
  }else if(prompt.includes('DELEGATE_BROWSER')){
    if(data.messages.at(-1)?.role==='tool')emit({content:`Delegation outcome: ${data.messages.at(-1).content}`});
    else if(prompt.includes('ADVERTISE_ONLY'))emit({content:data.tools?.some((tool:any)=>tool.function.name==='task')?'Research task is available.':'Research task is unavailable under this profile.'});
    else{toolCall=true;emit({tool_calls:[{index:0,id:'browser-research-task',type:'function',function:{name:'task',arguments:JSON.stringify({description:'Inspect fixture project',prompt:prompt.replace('DELEGATE_BROWSER','DELEGATE_CHILD')})}}]});}
  }else if(prompt.includes('RULES_BROWSER')){
    // Actual rule-governed calls: one bash command and one file write drawn from
    // the prompt so tests can steer subjects; the run then reports its results.
    if(data.messages.at(-1)?.role==='tool')emit({content:`Rules outcome: ${data.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content).join(' | ')}`});
    else if(prompt.includes('RULES_ADVERTISE'))emit({content:`Advertised tools: ${(data.tools||[]).map((tool:any)=>tool.function.name).join(', ')}`});
    else{
      const command=/RUN_COMMAND\[(.+?)\]/.exec(prompt)?.[1];const target=/WRITE_PATH\[(.+?)\]/.exec(prompt)?.[1];
      const calls=[];if(command)calls.push({index:calls.length,id:'rules-bash',type:'function',function:{name:'bash',arguments:JSON.stringify({command})}});
      if(target)calls.push({index:calls.length,id:'rules-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:target,content:'Rule-governed write.\n'})}});
      if(calls.length){toolCall=true;emit({tool_calls:calls});}else emit({content:'No rule-governed call was requested.'});
    }
  }else if(prompt.includes('MCP_BROWSER')&&data.messages.at(-1)?.role!=='tool'){
    const external=data.tools?.find((tool:any)=>tool.function?.name.startsWith('mcp_'));
    if(external){toolCall=true;emit({tool_calls:[{index:0,id:'browser-mcp-call',type:'function',function:{name:external.function.name,arguments:JSON.stringify({text:prompt})}}]});}
    else emit({content:'No connected MCP tool is available for this turn.'});
  }else if(prompt.includes('MCP_BROWSER')){
    emit({content:'MCP tool finished. Inspect its activity card for the recorded result.'});
  }else if(prompt.includes('PROFILE_BROWSER forbidden write')&&data.messages.at(-1)?.role!=='tool'){
    toolCall=true;emit({tool_calls:[{index:0,id:'profile-forbidden-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'profile-forbidden.txt',content:'This excluded tool must never execute.\n'})}}]});
  }else if(prompt.includes('ask fixture question')&&data.messages.at(-1)?.role!=='tool'){
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
const mcp=new McpManager(()=>store.settings().mcpServers);
const{app,runner}=createApp({store,external:mcp});
app.get('/fixture/requests',(_req,res)=>res.json({count:providerRequests}));
app.get('/fixture/profiles',(_req,res)=>res.json({requests:profileRequests}));
app.get('/fixture/delegations',(_req,res)=>res.json({requests:delegationRequests,pending:pendingDelegations.size}));
app.post('/fixture/delegations/release',(_req,res)=>{for(const release of [...pendingDelegations])release();res.json({ok:true});});
app.get('/fixture/summaries',(_req,res)=>res.json({pending:pendingSummaries.size}));
app.post('/fixture/summaries/release',(_req,res)=>{for(const release of [...pendingSummaries])release();res.json({ok:true});});
const vite=await createViteServer({server:{middlewareMode:true,hmr:{port:24679}},appType:'spa'});app.use(vite.middlewares);
const server=app.listen(3211,'127.0.0.1',()=>console.log('Lite E2E ready at http://127.0.0.1:3211'));
const terminals=attachTerminals(server,store);
let closing=false;
async function close(){if(closing)return;closing=true;runner.stopAll();await Promise.all([runner.whenIdle(),terminals.close(),mcp.close()]);server.closeAllConnections();server.close();mock.closeAllConnections();mock.close();await vite.close();store.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
