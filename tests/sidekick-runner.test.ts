import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
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

  it.each(['team-fusion', 'expert-fusion'] as const)('%s starts fresh workers from bounded briefs, preserves root history, and verifies on the driver', async kind => {
    await writeFile(join(directory,'package.json'), JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
    respond=(body,res)=>{
      if(side(body)) {
        if(body.messages.some((m:any)=>m.role==='tool'))text(res,'Worker implemented the note. Driver should run npm test.');
        else tools(res,[{name:'write_file',args:{path:'note.txt',content:body.messages.find((m:any)=>m.role==='user').content}}]);
      } else {
        const count=body.messages.filter((m:any)=>m.role==='tool').length;
        if(count===0)tools(res,[{name:'delegate',args:{description:'First assignment',prompt:'Implement note version one.'}}]);
        else if(count===1)tools(res,[{name:'delegate',args:{description:'Second assignment',prompt:'Repair note to version two.'}}]);
        else if(count===2)tools(res,[{name:'verify',args:{command:'npm test'}}]);
        else text(res,'Implemented and verified.');
      }
    };
    const architecture=kind==='team-fusion'?{kind,worker:ARCHITECTURE.sidekick}:{kind,expert:ARCHITECTURE.sidekick};
    const session=await create({architecture});await run(session.id,'ROOT private planning detail; implement the note.');
    const records=runner.delegations.list(session.id);expect(records).toHaveLength(2);
    expect(records.every(record=>record.status==='completed')).toBe(true);
    expect(records.map(record=>record.role)).toEqual(kind==='team-fusion'?['worker','worker']:['expert','expert']);
    expect(new Set(records.map(record=>record.childSessionId)).size).toBe(2);
    const workerCalls=calls.filter(side);
    expect(workerCalls.every(body=>body.messages.filter((m:any)=>m.role==='user').length===1)).toBe(true);
    expect(JSON.stringify(workerCalls)).not.toContain('ROOT private planning');
    expect(names(calls[0])).toContain('delegate');expect(names(calls[0])).toContain('verify');
    for(const body of calls.filter(body=>!side(body)))for(const tool of ['bash','capability','sidekick','write_file','edit_file'])expect(names(body)).not.toContain(tool);
    for(const body of workerCalls)for(const tool of ['delegate','task','takeover','verify'])expect(names(body)).not.toContain(tool);
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('Repair note to version two.');
    expect(store.messages(session.id).at(-1)?.receipts).toMatchObject({filesChanged:['note.txt'],checksRun:['npm test'],unresolvedChecks:[]});
    await runner.history.undo(session.id,runner.history.state(session.id).undoId!);
    await expect(readFile(join(directory,'note.txt'),'utf8')).rejects.toThrow();
  });

  it('runs independent Team assignments concurrently in private snapshots and integrates one undoable result',async()=>{
    await writeFile(join(directory,'seed.txt'),'Uncommitted user baseline');
    await writeFile(join(directory,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
    const waiting=new Map<string,ServerResponse>();
    respond=(body,res)=>{
      if(side(body)) {
        const brief=body.messages.find((m:any)=>m.role==='user').content;
        if(body.messages.some((m:any)=>m.role==='tool'))text(res,`Implemented ${brief}`);
        else {
          waiting.set(brief,res);
          if(waiting.size===2)for(const [name,response] of waiting)tools(response,[{name:'write_file',args:{path:`${name}.txt`,content:`result ${name}`}}]);
        }
      }else {
        const results=body.messages.filter((m:any)=>m.role==='tool');
        if(!results.length)tools(res,[{name:'delegate',args:{description:'Component A',prompt:'alpha'}},{name:'delegate',args:{description:'Component B',prompt:'beta'}}]);
        else if(results.length===2)tools(res,[{name:'verify',args:{command:'npm test'}}]);else text(res,'Both integrated and verified.');
      }
    };
    const session=await create({architecture:{kind:'team-fusion',worker:ARCHITECTURE.sidekick,concurrency:2}});await run(session.id);
    const records=runner.delegations.list(session.id);expect(records).toHaveLength(2);expect(waiting.size).toBe(2);
    expect(records.every(record=>record.status==='completed'&&record.isolated)).toBe(true);
    expect(new Set(records.map(record=>store.session(record.childSessionId).workspace)).size).toBe(2);
    expect(await readFile(join(directory,'alpha.txt'),'utf8')).toBe('result alpha');
    expect(await readFile(join(directory,'beta.txt'),'utf8')).toBe('result beta');
    expect(await readFile(join(directory,'seed.txt'),'utf8')).toBe('Uncommitted user baseline');
    expect(store.messages(session.id).at(-1)?.receipts).toMatchObject({filesChanged:['alpha.txt','beta.txt'],checksRun:['npm test'],unresolvedChecks:[]});
    await runner.history.undo(session.id,runner.history.state(session.id).undoId!);
    await expect(readFile(join(directory,'alpha.txt'),'utf8')).rejects.toThrow();await expect(readFile(join(directory,'beta.txt'),'utf8')).rejects.toThrow();
    expect(await readFile(join(directory,'seed.txt'),'utf8')).toBe('Uncommitted user baseline');
  });

  it('preserves root files when isolated Team patches conflict',async()=>{
    await writeFile(join(directory,'shared.txt'),'user baseline');
    respond=(body,res)=>{
      if(side(body)) {
        if(body.messages.some((m:any)=>m.role==='tool'))text(res,'Changed shared file.');
        else tools(res,[{name:'write_file',args:{path:'shared.txt',content:body.messages.find((m:any)=>m.role==='user').content}}]);
      }else if(body.messages.some((m:any)=>m.role==='tool'))text(res,'Integration conflicts need a fresh repair.');
      else tools(res,[{name:'delegate',args:{description:'First',prompt:'first'}},{name:'delegate',args:{description:'Second',prompt:'second'}}]);
    };
    const session=await create({architecture:{kind:'team-fusion',worker:ARCHITECTURE.sidekick,concurrency:2}});await run(session.id);
    expect(runner.delegations.list(session.id).map(record=>record.status)).toEqual(['failed','failed']);
    expect(await readFile(join(directory,'shared.txt'),'utf8')).toBe('user baseline');
    expect(store.changes(session.id)).toEqual([]);
    expect(store.messages(session.id).at(-1)?.receipts?.filesChanged).toEqual([]);
    expect(store.messages(session.id).filter(message=>message.role==='tool').every(message=>message.content.includes('Integration conflict'))).toBe(true);
  });

  it('strict drivers cannot silently edit source or execute arbitrary commands', async()=>{
    respond=(body,res)=>body.messages.some((m:any)=>m.role==='tool')?text(res):tools(res,[
      {name:'write_file',args:{path:'forbidden.txt',content:'no'}},
      {name:'bash',args:{command:'touch forbidden.txt'}},
      {name:'verify',args:{command:'npm test; touch forbidden.txt'}},
      {name:'takeover',args:{reason:'I prefer to code',files:['forbidden.txt']}},
    ]);
    const session=await create({architecture:{kind:'team-fusion',worker:ARCHITECTURE.sidekick}});await run(session.id);
    await expect(readFile(join(directory,'forbidden.txt'),'utf8')).rejects.toThrow();
    const outcomes=store.messages(session.id).flatMap(message=>message.toolCalls??[]);expect(outcomes.every(call=>call.status==='denied'||call.status==='error')).toBe(true);
    expect(calls.filter(side)).toHaveLength(0);
  });

  it('a repaired command failure remains in evidence but no longer fails the worker', async()=>{
    let steps=0;
    respond=(body,res)=>{
      if(side(body)) {
        if(steps++===0)tools(res,[{name:'bash',args:{command:'npm test'}}]);
        else if(steps===2)tools(res,[{name:'write_file',args:{path:'package.json',content:JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}})}}]);
        else if(steps===3)tools(res,[{name:'bash',args:{command:'npm test'}}]);
        else text(res,'Fixed the test script and reran npm test successfully.');
      }else if(body.messages.some((m:any)=>m.role==='tool'))text(res);else tools(res,[{name:'sidekick',args:{description:'Repair tests',prompt:'Run and repair npm test'}}]);
    };
    await writeFile(join(directory,'package.json'), JSON.stringify({scripts:{test:'node -e "process.exit(1)"'}}));
    const session=await create();await run(session.id);
    expect(runner.delegations.list(session.id)[0].status).toBe('completed');
    expect(store.messages(session.id).at(-1)?.receipts).toMatchObject({checksFailed:['npm test'],unresolvedChecks:[],checksRun:['npm test','npm test']});
  });

  it.each(['repair', 'takeover'] as const)('resolves a failed Expert invocation through explicit %s and root verification', async recovery => {
    await writeFile(join(directory,'note.txt'),'before');
    await writeFile(join(directory,'package.json'),JSON.stringify({scripts:{test:'node -e "if(require(\'fs\').readFileSync(\'note.txt\',\'utf8\')!==\'fixed\')process.exit(1)"'}}));
    let sessionId='';
    respond=(body,res)=>{
      if(side(body)) {
        const brief=body.messages.find((message:any)=>message.role==='user').content;
        if(body.messages.at(-1)?.role==='tool')text(res,'Worker report.');
        else if(brief==='first')tools(res,[{name:'edit_file',args:{path:'note.txt',old_string:'missing text',new_string:'fixed'}}]);
        else tools(res,[{name:'write_file',args:{path:'note.txt',content:'fixed'}}]);
      }else {
        const count=body.messages.filter((message:any)=>message.role==='tool').length;
        if(count===0)tools(res,[{name:'delegate',args:{description:'First attempt',prompt:'first'}}]);
        else if(count===1) {
          const failed=runner.delegations.list(sessionId)[0];
          tools(res,[recovery==='repair'?{name:'delegate',args:{description:'Fresh repair',prompt:'repair',repairOf:failed.id}}:{name:'takeover',args:{reason:'The worker could not perform the exact edit.',files:['note.txt'],invocationId:failed.id}}]);
        }else if(recovery==='takeover'&&count===2)tools(res,[{name:'write_file',args:{path:'note.txt',content:'fixed'}}]);
        else if(count===(recovery==='repair'?2:3))tools(res,[{name:'verify',args:{command:'npm test'}}]);
        else text(res,'Repaired and verified.');
      }
    };
    const session=await create({architecture:{kind:'expert-fusion',expert:ARCHITECTURE.sidekick}});sessionId=session.id;
    await run(session.id);
    const records=runner.delegations.list(session.id);
    expect(records[0].status).toBe('failed');
    if(recovery==='repair') {expect(records[1].status).toBe('completed');expect(records[1].childSessionId).not.toBe(records[0].childSessionId);}
    else {
      expect(store.messages(session.id).flatMap(message=>message.toolCalls??[]).find(call=>call.name==='takeover')?.status).toBe('completed');
      const driverCalls=calls.filter(body=>!side(body));
      expect(names(driverCalls[0])).not.toContain('write_file');
      expect(names(driverCalls[1])).not.toContain('write_file');
      expect(names(driverCalls[2])).toContain('write_file');
    }
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('fixed');
    expect(store.messages(session.id).at(-1)?.content).not.toMatch(/unresolved|incomplete/);
    expect(store.messages(session.id).at(-1)?.receipts).toMatchObject({checksRun:['npm test'],unresolvedChecks:[]});
  });

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

  it('reuses one context with immutable per-call records and transcript slices',async()=>{
    const s=await create();await run(s.id,'ROOT first');
    const first=runner.delegations.list(s.id)[0];expect(first.status).toBe('completed');
    await run(s.id,'ROOT second');
    const list=runner.delegations.list(s.id);expect(list).toHaveLength(2);
    expect(list[0]).toEqual(first);expect(list[1].id).not.toBe(first.id);expect(list[1].childSessionId).toBe(first.childSessionId);expect(list[1].status).toBe('completed');
    const childCalls=calls.filter(side);expect(childCalls).toHaveLength(4);
    // The second task arrives inside the SAME transcript: earlier turns are real context.
    const last=childCalls.at(-1);expect(last.messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content)).toEqual(['SIDE task 1','SIDE task 2']);
    expect(JSON.stringify(last.messages)).toContain('Sidekick report: wrote the file');
    expect(store.messages(s.id).filter(m=>m.role==='tool')).toHaveLength(2);
    const transcript=runner.delegations.transcript(s.id,first.id);expect(transcript.messages.filter(m=>m.role==='user').map(m=>m.content)).toEqual(['SIDE task 1']);
    expect(runner.delegations.transcript(s.id,list[1].id).messages.filter(m=>m.role==='user').map(m=>m.content)).toEqual(['SIDE task 2']);
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

  it('a denied mutation preserves its failed record and a later assignment gets a fresh context',async()=>{
    const s=await create({permissionMode:'ask'});runner.start(s.id,'ROOT guarded');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');
    await until(()=>runner.permissions(s.id).length===1);const write=runner.permissions(s.id)[0];runner.decide(s.id,write.id,'deny');await runner.whenIdle();
    await expect(readFile(join(directory,'note.txt'),'utf8')).rejects.toThrow();
    const first=runner.delegations.list(s.id)[0];expect(first.status).toBe('failed');
    const before=first.childSessionId;
    runner.start(s.id,'ROOT retry');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    const after=runner.delegations.list(s.id);expect(after).toHaveLength(2);expect(after[0]).toEqual(first);expect(after[1].childSessionId).not.toBe(before);
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
    expect(list).toHaveLength(2);expect(active).toBeDefined();expect(active!.childSessionId).not.toBe(first.childSessionId);
  });

  it('uses current Ask policy and a new workspace after a completed Auto assignment',async()=>{
    const s=await create();await run(s.id);
    const first=runner.delegations.list(s.id)[0];
    const next=join(directory,'next');await mkdir(next);
    store.updateSession(s.id,{workspace:next,permissionMode:'ask'});
    runner.start(s.id,'ROOT new workspace');
    await until(()=>runner.permissions(s.id).length===1);
    runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');
    await until(()=>runner.permissions(s.id).length===1);
    expect(runner.permissions(s.id)[0].tool).toBe('write_file');
    await expect(readFile(join(next,'note.txt'),'utf8')).rejects.toThrow();
    runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    expect(await readFile(join(next,'note.txt'),'utf8')).toBe('turn 1');
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('turn 1');
    expect(runner.delegations.list(s.id)[1].childSessionId).not.toBe(first.childSessionId);
  });

  it('records delegated files and receipts in the root turn and safely undoes/redoes them',async()=>{
    const s=await create();await run(s.id);
    const first=runner.delegations.list(s.id)[0];
    expect(store.changes(first.childSessionId)).toEqual([]);
    expect(store.changes(s.id)).toEqual([expect.objectContaining({path:'note.txt',before:null,after:'turn 1',actorSessionId:first.childSessionId,invocationId:first.id})]);
    expect(store.messages(s.id).at(-1)?.receipts?.filesChanged).toEqual(['note.txt']);
    const undone=await runner.history.undo(s.id,runner.history.state(s.id).undoId!);
    await expect(readFile(join(directory,'note.txt'),'utf8')).rejects.toThrow();
    expect(runner.delegations.list(s.id)).toEqual([]);
    await runner.history.redo(s.id,undone.redoId!);
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('turn 1');
    expect(runner.delegations.get(s.id,first.id)).toEqual(first);
    await run(s.id,'ROOT after redo');
    expect(runner.delegations.list(s.id)[1].childSessionId).not.toBe(first.childSessionId);
    await run(s.id,'ROOT another edit');
    const head=runner.history.state(s.id).undoId!;
    await writeFile(join(directory,'note.txt'),'external edit');
    await expect(runner.history.undo(s.id,head)).rejects.toThrow(/changed outside/);
    expect(await readFile(join(directory,'note.txt'),'utf8')).toBe('external edit');
  });

  it('sidekick launch is refused in plan mode and without the architecture',async()=>{
    const s=await create({mode:'plan'});await run(s.id,'ROOT plan');
    expect(names(calls[0])).not.toContain('sidekick');expect(runner.delegations.list(s.id)).toEqual([]);
  });

  it('applies captured mutation hooks to the worker with root and actor attribution',async()=>{
    store.saveSettings({hooks:[{event:'PreToolUse',matcher:'write_file',command:'exit 2'}]});
    const observed=vi.spyOn(runner.hooks,'run');const s=await create();await run(s.id);
    await expect(readFile(join(directory,'note.txt'),'utf8')).rejects.toThrow();
    const d=runner.delegations.list(s.id)[0];expect(d.status).toBe('failed');
    expect(observed.mock.calls[0][0]).toMatchObject({sessionId:s.id,actorSessionId:d.childSessionId,invocationId:d.id,tool:'write_file'});
  });

  it('gives the sidekick the interface of the parent user input',async()=>{
    const session=await create();runner.start(session.id,'ROOT delegate',[],undefined,'web');await runner.whenIdle();
    expect(calls.filter(side).length).toBeGreaterThan(0);
    for(const call of calls.filter(side))expect(JSON.stringify(call.messages)).toContain('Interface: Lite web UI');
  });

  it('returns steering to the driver immediately while the sidekick provider is still streaming',async()=>{
    let held:ServerResponse|undefined;
    respond=(body,res)=>{if(side(body))held=res;else if(body.messages.some((m:any)=>m.role==='tool'))text(res,'Driver followed the new instruction');else tools(res,[{name:'sidekick',args:{description:'Steered work',prompt:'SIDE work'}}]);};
    const s=await create();runner.start(s.id,'ROOT work');await until(()=>Boolean(held));
    runner.steer(s.id,'Inspect README only.');
    await runner.whenIdle();
    expect(calls.filter(side)).toHaveLength(1);
    expect(calls.filter(side).some(body=>JSON.stringify(body.messages).includes('Inspect README only.'))).toBe(false);
    const driver=calls.filter(body=>!side(body)).at(-1);
    expect(driver.messages.at(-1)).toMatchObject({role:'user',content:expect.stringContaining('Inspect README only.')});
    const callIndex=driver.messages.findIndex((m:any)=>m.tool_calls?.length);
    expect(driver.messages[callIndex+1].role).toBe('tool');
    const d=runner.delegations.list(s.id)[0];expect(d.status).toBe('cancelled');
    expect(runner.delegations.transcript(s.id,d.id).messages.some(m=>m.content.includes('[Steering]'))).toBe(false);
    expect(store.messages(s.id).at(-1)?.content).toBe('Driver followed the new instruction');
    expect(runner.history.state(s.id).canUndo).toBe(true);
  });

  it('stops unfinished worker jobs before settling and reports incomplete verification',async()=>{
    respond=(body,res)=>{if(side(body)){if(body.messages.at(-1)?.role==='tool')text(res,'All done');else tools(res,[{name:'bash',args:{command:'sleep 60',run_in_background:true}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'sidekick',args:{description:'Background work',prompt:'SIDE run'}}]);};
    const s=await create();await run(s.id);
    const d=runner.delegations.list(s.id)[0];expect(d.status).toBe('failed');
    expect(runner.jobs.list(d.childSessionId)).toHaveLength(1);
    expect(runner.jobs.list(d.childSessionId)[0].status).not.toBe('running');
    expect(store.messages(s.id).find(m=>m.role==='tool')?.content).toContain('unfinished background');
  });

  it('compacts persistent worker context while retaining immutable earlier evidence',async()=>{
    const settings=store.settings();store.saveSettings({providers:settings.providers.map(p=>({...p,contextWindows:{'side-model':16000}}))});
    let summaries=0,assignments=0;
    respond=(body,res)=>{
      if(body.messages.some((m:any)=>m.role==='system'&&String(m.content).includes('Summarize the supplied conversation'))){summaries++;text(res,'The first assignment finished. No files changed.');}
      else if(side(body))text(res,++assignments===1?'Earlier evidence. '+ 'x'.repeat(90000):'Second assignment complete.');
      else if(body.messages.at(-1)?.role==='tool')text(res);
      else tools(res,[{name:'sidekick',args:{description:'Inspect',prompt:`SIDE ${body.messages.filter((m:any)=>m.role==='user').length}`}}]);
    };
    const s=await create();await run(s.id,'ROOT first');const first=runner.delegations.list(s.id)[0];
    const before=runner.delegations.transcript(s.id,first.id);
    await run(s.id,'ROOT second');
    expect(summaries).toBe(1);const list=runner.delegations.list(s.id);expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({status:'completed',childSessionId:first.childSessionId});
    expect(runner.delegations.transcript(s.id,first.id).messages).toEqual(before.messages);
    expect(store.messages(first.childSessionId).some(m=>m.content.startsWith('Session context summary'))).toBe(true);
  });
});
