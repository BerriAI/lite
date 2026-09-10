import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { ToolDefinition } from '../shared/types.js';
import type { ExternalTools } from '../server/external.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for sidekick');await new Promise(resolve=>setTimeout(resolve,5));}};
const stream=(res:ServerResponse,delta:unknown,finish='stop')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);};
const text=(res:ServerResponse,content='Root done')=>stream(res,{content});
const tools=(res:ServerResponse,calls:{name:string,args?:Record<string,unknown>}[])=>stream(res,{tool_calls:calls.map((call,index)=>({index,id:`call-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args??{})}}))},'tool_calls');
const side=(body:any)=>body.model==='side-model';
const names=(body:any)=>body.tools.map((tool:ToolDefinition)=>tool.function.name);
const ARCHITECTURE={kind:'sidekick-fusion',sidekick:{providerId:'test',model:'side-model'}} as const;

describe('Sidekick Fusion persistent delegated executor',()=>{
  let directory:string,store:Store,server:Server,provider:Server,url:string,runner:ReturnType<typeof createApp>['runner'],calls:any[],respond:(body:any,res:ServerResponse)=>void;
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const create=async(extra:Record<string,unknown>={})=>{const result=await api('/sessions',{permissionMode:'auto',architecture:ARCHITECTURE,...extra});expect(result.status).toBe(201);return result.body;};
  const run=async(id:string,prompt='ROOT delegate')=>{runner.start(id,prompt);await runner.whenIdle();};
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'lite-sidekick-runner-')));store=new Store(join(directory,'state'));calls=[];
    respond=(body,res)=>{if(side(body)){if(body.messages.at(-1)?.role==='tool')text(res,'Sidekick report: wrote the file');else tools(res,[{name:'write_file',args:{path:'note.txt',content:`turn ${body.messages.filter((m:any)=>m.role==='user').length}`}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'sidekick',args:{description:'Write the note',prompt:`SIDE task ${body.messages.filter((m:any)=>m.role==='user').length}`}}]);};
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);respond(body,res);});
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider),apiKey:'fake-accepted-key'}],defaultProvider:'test',defaultModel:'model'});
    const external:ExternalTools={capture:vi.fn(()=>({definitions:[],scope:()=>'',assertCurrent:()=>{},execute:async()=>'',release:()=>{}}))} as any;const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();vi.restoreAllMocks();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it('advertises the sidekick tool only under the architecture and gives the child write tools on the sidekick model',async()=>{
    const plain=await create({architecture:null});await run(plain.id,'ROOT plain');expect(names(calls[0])).not.toContain('sidekick');
    calls=[];const s=await create();await run(s.id);
    expect(names(calls[0])).toContain('sidekick');expect(names(calls[0])).toContain('task');
    const childCall=calls.find(side);expect(childCall).toBeDefined();expect(childCall.model).toBe('side-model');
    const childNames=names(childCall);for(const name of['write_file','edit_file','bash','read_file','grep','history_search'])expect(childNames).toContain(name);
    for(const name of['task','sidekick','ask_user','update_goal'])expect(childNames).not.toContain(name);
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('turn 1');
    const delegation=runner.delegations.list(s.id)[0];expect(delegation.role).toBe('sidekick');expect(delegation.status).toBe('completed');
    expect(store.messages(s.id).find(m=>m.role==='tool')?.content).toContain('Sidekick report: wrote the file');
  });

  it('persists independent model effort, routes it to main and sidekick, and clears it', async () => {
    const mainKey = JSON.stringify(['test', 'model']), sideKey = JSON.stringify(['test', 'side-model']);
    const s = await create({ modelReasoning: { [mainKey]: 'high', [sideKey]: 'low' } });
    await run(s.id);
    expect(calls.filter(call => !side(call)).every(call => call.reasoning_effort === 'high')).toBe(true);
    expect(calls.filter(side).every(call => call.reasoning_effort === 'low')).toBe(true);
    const before = store.session(s.id)!;
    const changed = await api(`/sessions/${s.id}`, { modelReasoning: {}, expectedConfigRevision: before.configRevision }, 'PATCH');
    expect(changed.status).toBe(200);
    expect(changed.body.configRevision).toBe(before.configRevision! + 1);
    expect(store.session(s.id)?.modelReasoning).toEqual({});
    calls = []; await run(s.id);
    expect(calls.every(call => call.reasoning_effort === undefined)).toBe(true);
    const invalid = await api(`/sessions/${s.id}`, { modelReasoning: { [mainKey]: 'invalid' } }, 'PATCH');
    expect(invalid.status).toBe(400);
  });

  it('reuses one persistent child across turns: same session, continuous transcript, single re-pointed delegation row',async()=>{
    const s=await create();await run(s.id,'ROOT first');
    const first=runner.delegations.list(s.id)[0];expect(first.status).toBe('completed');
    await run(s.id,'ROOT second');
    const list=runner.delegations.list(s.id);expect(list).toHaveLength(1);
    expect(list[0].id).toBe(first.id);expect(list[0].childSessionId).toBe(first.childSessionId);expect(list[0].status).toBe('completed');
    const childCalls=calls.filter(side);expect(childCalls).toHaveLength(4);
    // The second task arrives inside the SAME transcript: earlier turns are real context.
    const last=childCalls.at(-1);expect(last.messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content)).toEqual(['SIDE task 1','SIDE task 2']);
    expect(JSON.stringify(last.messages)).toContain('Sidekick report: wrote the file');
    expect(store.messages(s.id).filter(m=>m.role==='tool')).toHaveLength(2);
    const transcript=runner.delegations.transcript(s.id,first.id);expect(transcript.messages.filter(m=>m.role==='user')).toHaveLength(2);
  });

  it('routes sidekick mutations through the parent permission flow under Ask',async()=>{
    const s=await create({permissionMode:'ask'});runner.start(s.id,'ROOT guarded');
    await until(()=>runner.permissions(s.id).length===1);
    const launch=runner.permissions(s.id)[0];expect(launch.sessionId).toBe(s.id);runner.decide(s.id,launch.id,'allow');
    await until(()=>runner.permissions(s.id).length===1&&runner.permissions(s.id)[0].id!==launch.id);
    const write=runner.permissions(s.id)[0];expect(write.sessionId).toBe(s.id);expect(write.description).toContain('sidekick');
    const childId=runner.delegations.list(s.id)[0].childSessionId;expect(runner.permissions(childId)).toEqual([]);
    runner.decide(s.id,write.id,'allow');await runner.whenIdle();
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('turn 1');
    expect(runner.delegations.list(s.id)[0].status).toBe('completed');
  });

  it('a denied sidekick mutation fails the task without writing and the next turn reuses the same child',async()=>{
    const s=await create({permissionMode:'ask'});runner.start(s.id,'ROOT guarded');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');
    await until(()=>runner.permissions(s.id).length===1);const write=runner.permissions(s.id)[0];runner.decide(s.id,write.id,'deny');await runner.whenIdle();
    await expect(readFile(join(directory,'note.txt'),'utf8')).rejects.toThrow();
    const first=runner.delegations.list(s.id)[0];expect(['failed','completed']).toContain(first.status);
    const before=first.childSessionId;
    runner.start(s.id,'ROOT retry');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    const after=runner.delegations.list(s.id);expect(after).toHaveLength(1);expect(after[0].childSessionId).toBe(before);
  });

  it('an interrupted sidekick is replaced by a fresh child instead of resuming a torn transcript',async()=>{
    let held:ServerResponse|undefined;respond=(body,res)=>{if(side(body)){held=res;return;}if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'sidekick',args:{description:'Hold',prompt:'SIDE hold'}}]);};
    const s=await create();runner.start(s.id,'ROOT hold');await until(()=>Boolean(held));
    runner.cancel(s.id);await runner.whenIdle();
    const first=runner.delegations.list(s.id)[0];expect(['cancelled','interrupted','failed']).toContain(first.status);held?.destroy();
    respond=(body,res)=>{if(side(body)){if(body.messages.at(-1)?.role==='tool')text(res,'Fresh child report');else tools(res,[{name:'read_file',args:{path:'note.txt'}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'sidekick',args:{description:'Retry',prompt:'SIDE retry'}}]);};
    await writeFile(join(directory,'note.txt'),'seed');
    await run(s.id,'ROOT after cancel');
    const list=runner.delegations.list(s.id);
    const active=list.find(d=>d.status==='completed');
    if(first.status==='interrupted'){expect(active).toBeDefined();expect(active!.childSessionId).not.toBe(first.childSessionId);}
    else{expect(list).toHaveLength(1);expect(list[0].status).toBe('completed');}
  });

  it('sidekick launch is refused in plan mode and without the architecture',async()=>{
    const s=await create({mode:'plan'});await run(s.id,'ROOT plan');
    expect(names(calls[0])).not.toContain('sidekick');expect(runner.delegations.list(s.id)).toEqual([]);
  });
});
