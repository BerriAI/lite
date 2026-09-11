import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { DELEGATION_LIMITS } from '../server/runner.js';
import { captureProjectGuidance } from '../server/tools.js';
import { applyEvent } from '../client/src/api.js';
import type { ToolDefinition } from '../shared/types.js';
import type { ExternalTools } from '../server/external.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for delegation');await new Promise(resolve=>setTimeout(resolve,5));}};
const stream=(res:ServerResponse,delta:unknown,finish='stop')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);};
const text=(res:ServerResponse,content='Root done')=>stream(res,{content});
const tools=(res:ServerResponse,calls:{name:string,args?:Record<string,unknown>}[])=>stream(res,{tool_calls:calls.map((call,index)=>({index,id:`call-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args??{})}}))},'tool_calls');
const task=(res:ServerResponse,prompt='CHILD inspect')=>tools(res,[{name:'task',args:{description:'Inspect project',prompt}}]);
const child=(body:any)=>body.messages.find((m:any)=>m.role==='user')?.content?.startsWith('CHILD');
const names=(body:any)=>body.tools.map((tool:ToolDefinition)=>tool.function.name);

describe('foreground bounded researcher Runner/API integration',()=>{
  let directory:string,store:Store,server:Server,provider:Server,url:string,runner:ReturnType<typeof createApp>['runner'],calls:any[],respond:(body:any,res:ServerResponse)=>void;
  let external:ExternalTools & {capture:ReturnType<typeof vi.fn>};
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const create=async(extra:Record<string,unknown>={})=>{const result=await api('/sessions',{permissionMode:'auto',...extra});expect(result.status).toBe(201);return result.body;};
  const run=async(id:string)=>{runner.start(id,'ROOT research');await runner.whenIdle();};
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'speedrail-delegation-runner-')));store=new Store(join(directory,'state'));calls=[];
    await writeFile(join(directory,'research.txt'),'Verified workspace evidence');await writeFile(join(directory,'AGENTS.md'),'Accepted guidance');
    respond=(body,res)=>{if(child(body)){if(body.messages.at(-1)?.role==='tool')text(res,'Child final evidence');else tools(res,[{name:'read_file',args:{path:'research.txt'}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else task(res);};
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);respond(body,res);});
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider),apiKey:'fake-accepted-key'}],defaultProvider:'test',defaultModel:'model'});
    external={capture:vi.fn(()=>({definitions:[],scope:()=>'',assertCurrent:()=>{},execute:async()=>'',release:()=>{}}))};const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();vi.restoreAllMocks();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it('persists an independent read-only child and returns exactly one bounded report without MCP capture',async()=>{
    const s=await create();await run(s.id);expect(calls).toHaveLength(4);const detail=(await api(`/sessions/${s.id}`)).body,delegation=detail.delegations[0];expect(delegation.status).toBe('completed');
    expect(names(calls[1]).sort()).toEqual(['glob','grep','history_search','read_file','todo_read','tool_output_page','view_image','web_fetch','web_search']);expect(calls[1].messages.filter((m:any)=>m.role!=='system')).toEqual([{role:'user',content:'CHILD inspect'}]);expect(calls[1].model).toBe('model');expect(calls[1].messages[0].content).not.toContain('ROOT');
    const transcript=(await api(`/sessions/${s.id}/delegations/${delegation.id}`)).body;expect(transcript.readOnly).toBe(true);expect(transcript.messages.map((m:any)=>m.role)).toEqual(['user','assistant','tool','assistant']);expect(transcript.messages[2].content).toContain('Verified workspace evidence');
    expect(detail.messages.filter((m:any)=>m.role==='tool')).toHaveLength(1);expect(detail.messages.find((m:any)=>m.role==='tool').content).toContain('Child final evidence');expect(external.capture).toHaveBeenCalledOnce();expect(store.sessions()).toHaveLength(1);expect(store.changes(s.id)).toEqual([]);expect(store.changes(delegation.childSessionId)).toEqual([]);
  });

  it.each(['write_file','edit_file','bash','todo_write','mcp_forged','ask_user','task'])('child cannot advertise or dispatch %s even under Auto',async(name)=>{
    respond=(body,res)=>{if(child(body)){if(body.messages.at(-1)?.role==='tool')text(res,'Attempt rejected');else tools(res,[{name,args:{path:'research.txt',content:'MUTATED',command:'touch forbidden',description:'Nested',prompt:'CHILD nested'}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else task(res);};
    const s=await create();await run(s.id);const delegation=runner.delegations.list(s.id)[0],transcript=runner.delegations.transcript(s.id,delegation.id);expect(delegation.status).toBe('failed');expect(names(calls[1])).not.toContain(name);expect(transcript.messages.flatMap(m=>m.toolCalls??[])[0].status).toBe('denied');expect(await readFile(join(directory,'research.txt'),'utf8')).toBe('Verified workspace evidence');expect(runner.delegations.list(s.id)).toHaveLength(1);expect(runner.permissions(delegation.childSessionId)).toEqual([]);expect(runner.questions.pending(delegation.childSessionId)).toEqual([]);expect(store.queue(s.id).paused).toBe(true);
  });

  it('Plan ASK launches require permission while a remembered task grant remains effective',async()=>{
    const s=await create({mode:'plan',permissionMode:'ask'});runner.start(s.id,'ROOT first');await until(()=>runner.permissions(s.id).length===1);expect(calls).toHaveLength(1);runner.decide(s.id,runner.permissions(s.id)[0].id,'always');await runner.whenIdle();
    await run(s.id);expect(calls).toHaveLength(8);expect(runner.permissions(s.id)).toEqual([]);expect(runner.delegations.list(s.id)).toHaveLength(2);
  });

  it('Plan Auto authorizes launch without expanding the child read-only ceiling',async()=>{
    const s=await create({mode:'plan'});await run(s.id);expect(calls).toHaveLength(4);expect(runner.permissions(s.id)).toEqual([]);expect(names(calls[1]).sort()).toEqual(['glob','grep','history_search','read_file','todo_read','tool_output_page','view_image','web_fetch','web_search']);expect(runner.delegations.list(s.id)[0].status).toBe('completed');
  });

  it('accepted provider, model, project guidance and skills survive source and settings replacement before child launch',async()=>{
    await mkdir(join(directory,'.speedrail','skills','inspect'),{recursive:true});await writeFile(join(directory,'.speedrail','skills','inspect','SKILL.md'),'Pinned skill body');await writeFile(join(directory,'.speedrail','profiles.json'),JSON.stringify({version:1,profiles:[],skills:[{id:'inspect',name:'Inspect',description:'Inspect project'}]}));
    const catalog=(await api('/profiles')).body;const s=await create({permissionMode:'ask',profile:{profileId:null,skillIds:['inspect'],catalogRevision:catalog.revision}});runner.start(s.id,'ROOT pin');await until(()=>runner.permissions(s.id).length===1);
    store.saveSettings({providers:[{id:'test',name:'Replacement',kind:'openai',baseUrl:'http://127.0.0.1:1',apiKey:'fake-new-key'}]});await writeFile(join(directory,'AGENTS.md'),'Replacement guidance');await rm(join(directory,'.speedrail','skills','inspect','SKILL.md'));runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    expect(calls).toHaveLength(4);for(const body of calls){expect(JSON.stringify(body.messages)).not.toContain('fake-accepted-key');expect(JSON.stringify(body.messages)).not.toContain('Replacement guidance');expect(body.messages[0].role).toBe('system');expect(body.messages[0].content).toContain('Accepted guidance');expect(body.messages[0].content).toContain('Pinned skill body');}expect(runner.delegations.list(s.id)[0].status).toBe('completed');
  });

  it('every direct child read/mutation is blocked, wrong-parent bindings fail, viewing never starts work',async()=>{
    const s=await create();await run(s.id);const delegation=runner.delegations.list(s.id)[0],id=delegation.childSessionId,before=calls.length;
    for(const path of ['', '/events','/export','/profile','/history','/queue'])expect((await api(`/sessions/${id}${path}`)).status).toBe(404);
    for(const [method,path]of [['POST','/messages'],['POST','/queue'],['POST','/queue/pause'],['POST','/queue/resume'],['PATCH',''],['POST','/profile'],['DELETE',''],['POST','/fork'],['POST','/compact'],['POST','/history/undo'],['POST','/history/recover'],['POST','/cancel'],['DELETE','/tool-grants'],['POST','/questions/fake/answer'],['POST','/permissions/fake']] as const)expect((await api(`/sessions/${id}${path}`,{},method)).status).toBe(409);
    const other=await create();expect((await api(`/sessions/${other.id}/delegations/${delegation.id}`)).status).toBe(404);expect((await api(`/sessions/${s.id}/delegations/${delegation.id}`)).status).toBe(200);expect(calls).toHaveLength(before);expect(()=>runner.start(id,'Direct')).toThrow(/read-only/);expect(()=>runner.enqueue(id,'Direct')).toThrow(/read-only/);
  });

  it('child-only cancellation is idempotent, parent explains and queue stays held without late child output',async()=>{
    let held:ServerResponse|undefined;respond=(body,res)=>{if(child(body))held=res;else if(body.messages.at(-1)?.role==='tool')text(res,'Root explains cancellation');else task(res);};const s=await create();runner.start(s.id,'ROOT');await until(()=>Boolean(held));runner.enqueue(s.id,'Do not start');const delegation=runner.delegations.list(s.id)[0];
    const response=await api(`/sessions/${s.id}/delegations/${delegation.id}/cancel`,{});expect(response.status).toBe(200);expect(response.body.delegation.status).toBe('cancelled');expect((await api(`/sessions/${s.id}/delegations/${delegation.id}/cancel`,{})).body).toEqual(response.body);await runner.whenIdle();text(held!,'LATE');expect(store.messages(s.id).at(-1)?.content).toBe('Root explains cancellation');expect(store.queue(s.id).items).toHaveLength(1);expect(store.queue(s.id).paused).toBe(true);expect(runner.delegations.transcript(s.id,delegation.id).messages.some(m=>m.content.includes('LATE'))).toBe(false);
  });

  it('root cancellation waits for descendants and prevents queued follow-up',async()=>{
    let held=false;respond=(body,res)=>{if(child(body))held=true;else task(res);};const s=await create();runner.start(s.id,'ROOT');await until(()=>held);runner.enqueue(s.id,'Queued');const delegation=runner.delegations.list(s.id)[0];runner.cancel(s.id);await runner.whenIdle();expect(runner.active(s.id)).toBe(false);expect(runner.active(delegation.childSessionId)).toBe(false);expect(runner.delegations.get(s.id,delegation.id).status).toBe('cancelled');expect(calls).toHaveLength(2);expect(store.messages(s.id).filter(m=>m.role==='tool')).toHaveLength(1);expect(store.queue(s.id).items).toHaveLength(1);
  });

  it('a child deadline settles timed_out without killing parent explanation',async()=>{
    const original=DELEGATION_LIMITS.idleMs;(DELEGATION_LIMITS as {idleMs:number}).idleMs=30;
    try{respond=(body,res)=>{if(child(body))return;else if(body.messages.at(-1)?.role==='tool')text(res);else task(res);};const s=await create();await run(s.id);expect(runner.delegations.list(s.id)[0].status).toBe('timed_out');expect(store.messages(s.id).at(-1)?.content).toBe('Root done');}finally{(DELEGATION_LIMITS as {idleMs:number}).idleMs=original;}
  });

  it('parent undo/redo retain exact saved report and never rerun the child',async()=>{
    const s=await create();await run(s.id);const before=store.messages(s.id),delegation=runner.delegations.list(s.id)[0],count=calls.length;await runner.history.undo(s.id,runner.history.state(s.id).undoId!);expect(runner.delegations.list(s.id)).toEqual([]);expect((await api(`/sessions/${s.id}/delegations/${delegation.id}`)).status).toBe(404);await runner.history.redo(s.id,runner.history.state(s.id).redoId!);expect(store.messages(s.id)).toEqual(before);expect(runner.delegations.list(s.id)).toHaveLength(1);expect(calls).toHaveLength(count);
  });

  it('history reset replay alone restores delegation summaries after undo and redo',async()=>{
    const s=await create();await run(s.id);let detail=(await api(`/sessions/${s.id}`)).body;const before=detail.messages,count=calls.length;
    const unsubscribe=runner.bus.subscribe(s.id,event=>{detail=applyEvent(detail,event);});
    try {
      expect((await api(`/sessions/${s.id}/history/undo`,{checkpointId:runner.history.state(s.id).undoId})).status).toBe(200);expect(detail.delegations).toEqual([]);
      expect((await api(`/sessions/${s.id}/history/redo`,{checkpointId:runner.history.state(s.id).redoId})).status).toBe(200);expect(detail.delegations).toHaveLength(1);expect(detail.delegations[0].status).toBe('completed');expect(detail.messages).toEqual(before);expect(calls).toHaveLength(count);
    }finally{unsubscribe();}
  });

  it('strict task arguments reject endpoint/policy injection before permission or child acceptance',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'task',args:{description:'Inspect',prompt:'CHILD',mode:'build',providerId:'other'}}]);const s=await create({permissionMode:'ask'});await run(s.id);expect(runner.delegations.list(s.id)).toEqual([]);expect(runner.permissions(s.id)).toEqual([]);expect(calls).toHaveLength(2);
  });

  it('four-launch limit rejects excess task calls in one assistant group without duplicating results',async()=>{
    respond=(body,res)=>{if(child(body))text(res,'Child finished');else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,Array.from({length:5},(_,i)=>({name:'task',args:{description:`Inspect ${i}`,prompt:`CHILD ${i}`}})));};
    const s=await create();await run(s.id);expect(runner.delegations.list(s.id)).toHaveLength(4);const results=store.messages(s.id).filter(m=>m.role==='tool');expect(results).toHaveLength(5);expect(new Set(results.map(m=>m.id)).size).toBe(5);expect(results[4].content).toContain('research budget');expect(calls).toHaveLength(6);expect(store.messages(s.id).flatMap(m=>m.toolCalls??[]).filter(call=>call.delegationId)).toHaveLength(4);
  });

  it('global four-child cap rejects a fifth root before child provider dispatch',async()=>{
    respond=(body,res)=>{if(child(body))return;else if(body.messages.at(-1)?.role==='tool')text(res);else task(res);};const sessions=await Promise.all(Array.from({length:5},()=>create()));
    for(const s of sessions.slice(0,4)){runner.start(s.id,'ROOT');await until(()=>runner.delegations.list(s.id).length===1);}
    runner.start(sessions[4].id,'ROOT fifth');await until(()=>!runner.active(sessions[4].id));expect(runner.delegations.list(sessions[4].id)).toEqual([]);expect(store.messages(sessions[4].id).filter(m=>m.role==='tool')[0].content).toContain('Four researchers');runner.stopAll();await runner.whenIdle();expect(sessions.every(s=>!runner.active(s.id))).toBe(true);
  });

  it('researchers can exceed the former per-child and shared model-step ceilings',async()=>{
    respond=(body,res)=>{if(child(body)){if(body.messages.filter((m:any)=>m.role==='tool').length>=15)text(res,'Research complete');else tools(res,[{name:'read_file',args:{path:'research.txt',offset:body.messages.length}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,Array.from({length:3},(_,i)=>({name:'task',args:{description:`Inspect ${i}`,prompt:`CHILD ${i}`}})));};
    const s=await create();await run(s.id);expect(calls.filter(child)).toHaveLength(48);expect(runner.delegations.list(s.id)).toHaveLength(3);expect(runner.delegations.list(s.id).every(task=>task.status==='completed')).toBe(true);expect(store.messages(s.id).filter(m=>m.role==='tool')).toHaveLength(3);
  });

  it('child final report has a UTF8 byte bound and complete stored transcript',async()=>{
    respond=(body,res)=>child(body)?text(res,'é'.repeat(30000)):body.messages.at(-1)?.role==='tool'?text(res):task(res);const s=await create();await run(s.id);const delegation=runner.delegations.list(s.id)[0],result=store.messages(s.id).find(m=>m.role==='tool')!;expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(32768);expect(result.content).not.toContain('�');expect(result.content).toContain('[Researcher report truncated.]');expect(runner.delegations.transcript(s.id,delegation.id).messages.at(-1)?.content).toBe('é'.repeat(30000));
  });

  it('oversized streamed reasoning fails within transcript budget and never dispatches a child tool',async()=>{
    respond=(body,res)=>child(body)?stream(res,{reasoning_content:'x'.repeat(4*1024*1024)}):body.messages.at(-1)?.role==='tool'?text(res):task(res);const s=await create();await run(s.id);const delegation=runner.delegations.list(s.id)[0];expect(delegation.status).toBe('failed');expect(Buffer.byteLength(JSON.stringify(runner.delegations.transcript(s.id,delegation.id).messages))).toBeLessThanOrEqual(4*1024*1024);expect(calls).toHaveLength(3);
  });

  it('postcommit delegation event failure preserves exactly one parent result without replay',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});const s=await create();const unsubscribe=runner.bus.subscribe(s.id,event=>{if(event.type==='delegation'&&event.data.status==='completed')throw new Error('Subscriber failed after settlement');});try{await run(s.id);}finally{unsubscribe();}
    expect(runner.delegations.list(s.id)[0].status).toBe('completed');expect(store.messages(s.id).filter(m=>m.role==='tool')).toHaveLength(1);expect(calls).toHaveLength(3);expect(runner.active(s.id)).toBe(false);expect(runner.history.state(s.id).pendingRecovery).toBeUndefined();
  });

  it('failed atomic child creation does not dispatch or leave child evidence',async()=>{
    const s=await create();store.db.exec("CREATE TRIGGER reject_child BEFORE INSERT ON delegations BEGIN SELECT RAISE(ABORT,'no child'); END;");try{await run(s.id);}finally{store.db.exec('DROP TRIGGER reject_child');}expect(calls).toHaveLength(2);expect(store.sessions()).toHaveLength(1);expect(runner.delegations.list(s.id)).toEqual([]);expect(store.messages(s.id).filter(m=>m.role==='tool')).toHaveLength(1);expect(runner.history.state(s.id).pendingRecovery).toBeUndefined();
  });

  it('guidance capture skips symlink and oversized files instead of unbounded reads',async()=>{
    await writeFile(join(directory,'AGENTS.md'),'x'.repeat(300000));expect(captureProjectGuidance(directory)).toBe('');
  });
});
