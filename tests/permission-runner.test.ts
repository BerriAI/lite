import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { PermissionRuleSet } from '../shared/permissions.js';
import type { ToolDefinition, ToolCall } from '../shared/types.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for condition');await new Promise(resolve=>setTimeout(resolve,5));}};
const stream=(res:ServerResponse,delta:unknown,finish='stop')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);};
const text=(res:ServerResponse,content='Done')=>stream(res,{content});
const tools=(res:ServerResponse,calls:{name:string,args?:Record<string,unknown>}[])=>stream(res,{tool_calls:calls.map((call,index)=>({index,id:`call-${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args??{})}}))},'tool_calls');
const names=(body:any)=>body.tools.map((tool:ToolDefinition)=>tool.function.name);
const child=(body:any)=>body.messages.find((m:any)=>m.role==='user')?.content?.startsWith('CHILD');
const rules=(items:PermissionRuleSet['rules']):PermissionRuleSet=>({version:1,rules:items});

describe('fine-grained permission rules Runner/API integration',()=>{
  let directory:string,store:Store,server:Server,provider:Server,url:string,runner:ReturnType<typeof createApp>['runner'],calls:any[],respond:(body:any,res:ServerResponse)=>void;
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const create=async(extra:Record<string,unknown>={})=>{const result=await api('/sessions',{permissionMode:'ask',...extra});expect(result.status).toBe(201);return result.body;};
  const run=async(id:string)=>{runner.start(id,'Do the task');await runner.whenIdle();};
  const oneCallThenText=(name:string,args:Record<string,unknown>)=>(body:any,res:ServerResponse)=>body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name,args}]);
  const toolCalls=(id:string):ToolCall[]=>store.messages(id).flatMap(m=>m.toolCalls??[]);
  const prompts=(id:string)=>store.events(id,0).filter(e=>e.type==='permission');
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'litespeed-permission-runner-')));store=new Store(join(directory,'state'));calls=[];
    await writeFile(join(directory,'research.txt'),'Workspace evidence');
    respond=(body,res)=>text(res);
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);respond(body,res);});
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider),apiKey:'fake-key'}],defaultProvider:'test',defaultModel:'model'});
    const app=createApp({store});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it('updates the session task list without an approval in Ask first mode',async()=>{
    respond=oneCallThenText('todo_write',{todos:[{id:'inspect',content:'Inspect the project',status:'in_progress'}]});
    const s=await create();runner.start(s.id,'Plan the task');
    await until(()=>toolCalls(s.id)[0]?.status==='completed');await runner.whenIdle();
    expect(prompts(s.id)).toEqual([]);
    expect(store.todos(s.id)).toEqual([{id:'inspect',content:'Inspect the project',status:'in_progress'}]);
  });

  it.each(['ask','deny'] as const)('still respects an explicit %s rule for task-list updates',async decision=>{
    store.saveSettings({permissionRules:rules([{tool:'todo_write',decision}])});
    respond=oneCallThenText('todo_write',{todos:[{id:'inspect',content:'Inspect the project',status:'in_progress'}]});
    const s=await create({permissionMode:'auto'});runner.start(s.id,'Plan the task');
    if(decision==='ask'){
      await until(()=>runner.permissions(s.id).length===1);
      runner.decide(s.id,runner.permissions(s.id)[0].id,'deny');
    }
    await runner.whenIdle();
    expect(toolCalls(s.id)[0].status).toBe('denied');expect(store.todos(s.id)).toEqual([]);
  });

  it('an app allow rule skips the prompt in ask mode and records the decisive match',async()=>{
    store.saveSettings({permissionRules:rules([{tool:'write_file',decision:'allow'}])});
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create();await run(s.id);
    expect(prompts(s.id)).toEqual([]);
    expect(await readFile(join(directory,'hello.txt'),'utf8')).toBe('hi');
    const call=toolCalls(s.id)[0];expect(call.status).toBe('completed');
    expect(call.ruleMatch).toEqual({decision:'allow',source:'app',tool:'write_file'});
  });

  it('a project deny rule blocks in auto mode without prompting and reports the rule honestly',async()=>{
    await mkdir(join(directory,'.litespeed'),{recursive:true});
    await writeFile(join(directory,'.litespeed','permissions.json'),JSON.stringify(rules([{tool:'write_file',decision:'deny',patterns:['hello.txt']}])));
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create({permissionMode:'auto'});await run(s.id);
    expect(prompts(s.id)).toEqual([]);
    await expect(readFile(join(directory,'hello.txt'))).rejects.toThrow();
    const call=toolCalls(s.id)[0];expect(call.status).toBe('denied');
    expect(call.output).toContain('denied by an explicit project permission rule');
    expect(call.output).toContain('"hello.txt"');expect(call.output).toContain('not retry');
    expect(call.ruleMatch).toEqual({decision:'deny',source:'project',tool:'write_file',pattern:'hello.txt'});
  });

  it('a deny rule outranks a remembered Always grant',async()=>{
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create();runner.start(s.id,'First');
    await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'always');await runner.whenIdle();
    expect(await readFile(join(directory,'hello.txt'),'utf8')).toBe('hi');
    store.saveSettings({permissionRules:rules([{tool:'write_file',decision:'deny',patterns:['hello.txt']}])});
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'changed'});
    await run(s.id);
    expect(prompts(s.id)).toHaveLength(1); // Only the first turn prompted.
    expect(await readFile(join(directory,'hello.txt'),'utf8')).toBe('hi');
    const second=toolCalls(s.id).at(-1)!;expect(second.status).toBe('denied');
    expect(second.output).toContain('denied by an explicit app permission rule');
  });

  it('an ask rule forces a prompt in auto mode with an honest description',async()=>{
    store.saveSettings({permissionRules:rules([{tool:'write_file',decision:'ask'}])});
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create({permissionMode:'auto'});runner.start(s.id,'Write');
    await until(()=>runner.permissions(s.id).length===1);
    const request=runner.permissions(s.id)[0];
    expect(request.description).toContain('An explicit permission rule requires confirmation');
    runner.decide(s.id,request.id,'allow');await runner.whenIdle();
    expect(await readFile(join(directory,'hello.txt'),'utf8')).toBe('hi');
    expect(toolCalls(s.id)[0].ruleMatch).toEqual({decision:'ask',source:'app',tool:'write_file'});
  });

  it('a wildcard-free bash allow matches as a word-boundary command prefix only',async()=>{
    store.saveSettings({permissionRules:rules([{tool:'bash',decision:'allow',patterns:['git status']}])});
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'bash',args:{command:'git status --short'}},{name:'bash',args:{command:'git statusx'}}]);
    const s=await create();runner.start(s.id,'Status');
    await until(()=>runner.permissions(s.id).length===1);
    const [prefixed]=toolCalls(s.id);
    expect(prefixed.status).toBe('completed'); // Ran without a prompt.
    const pending=runner.permissions(s.id)[0];
    expect(pending.args.command).toBe('git statusx');
    runner.decide(s.id,pending.id,'deny');await runner.whenIdle();
    expect(prompts(s.id)).toHaveLength(1);
    expect(toolCalls(s.id)[1].status).toBe('denied');
  });

  it('a bash allow pattern with control operators downgrades to a prompt even in auto mode',async()=>{
    store.saveSettings({permissionRules:rules([{tool:'bash',decision:'allow',patterns:['echo **']}])});
    respond=oneCallThenText('bash',{command:'echo hi && echo bye'});
    const s=await create({permissionMode:'auto'});runner.start(s.id,'Echo');
    await until(()=>runner.permissions(s.id).length===1);
    const request=runner.permissions(s.id)[0];
    expect(request.description).toContain('An explicit permission rule requires confirmation');
    runner.decide(s.id,request.id,'allow');await runner.whenIdle();
    const call=toolCalls(s.id)[0];expect(call.status).toBe('completed');expect(call.output).toContain('hi');
    expect(call.ruleMatch?.decision).toBe('ask');
  });

  it('a pattern-free deny removes the tool from the advertised list; pattern-scoped denies do not',async()=>{
    store.saveSettings({permissionRules:rules([{tool:'bash',decision:'deny'},{tool:'write_file',decision:'deny',patterns:['secret.txt']}])});
    const s=await create({permissionMode:'auto'});await run(s.id);
    expect(names(calls[0])).not.toContain('bash');
    expect(names(calls[0])).toContain('write_file');
    expect(names(calls[0])).toContain('read_file');
    expect(names(calls[0])).toContain('ask_user');
  });

  it('an invalid project permissions.json is ignored with a visible notice and the turn completes',async()=>{
    await mkdir(join(directory,'.litespeed'),{recursive:true});
    await writeFile(join(directory,'.litespeed','permissions.json'),'{not valid json');
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create();runner.start(s.id,'Write');
    await until(()=>runner.permissions(s.id).length===1);
    expect(runner.permissions(s.id)[0].description).toContain('invalid and were ignored for this turn');
    runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    expect(await readFile(join(directory,'hello.txt'),'utf8')).toBe('hi');
    const notice=store.messages(s.id).find(m=>m.role==='system');
    expect(notice?.content).toContain('invalid and were ignored for this turn');
    expect(store.session(s.id).status).toBe('idle');
  });

  it('rules are captured at acceptance: later edits never change a pending approval',async()=>{
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create();runner.start(s.id,'Write');
    await until(()=>runner.permissions(s.id).length===1);
    const patched=await api('/settings',{permissionRules:rules([{tool:'write_file',decision:'deny'}])},'PATCH');
    expect(patched.status).toBe(200);
    expect(patched.body.permissionRules).toEqual(rules([{tool:'write_file',decision:'deny'}]));
    await mkdir(join(directory,'.litespeed'),{recursive:true});
    await writeFile(join(directory,'.litespeed','permissions.json'),JSON.stringify(rules([{tool:'write_file',decision:'deny'}])));
    runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    expect(await readFile(join(directory,'hello.txt'),'utf8')).toBe('hi');
    expect(toolCalls(s.id)[0].status).toBe('completed');
  });

  it('a child researcher inherits the parent turn\'s captured rules',async()=>{
    store.saveSettings({permissionRules:rules([{tool:'read_file',decision:'deny',patterns:['research.txt']}])});
    respond=(body,res)=>{if(child(body)){if(body.messages.at(-1)?.role==='tool')text(res,'Child report');else tools(res,[{name:'read_file',args:{path:'research.txt'}}]);}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'task',args:{description:'Inspect',prompt:'CHILD inspect'}}]);};
    const s=await create({permissionMode:'auto'});runner.start(s.id,'Research');
    // Removing the app rules after synchronous acceptance proves the child uses the captured copy.
    store.saveSettings({permissionRules:rules([])});
    await runner.whenIdle();
    const delegation=runner.delegations.list(s.id)[0];
    const attempt=runner.delegations.transcript(s.id,delegation.id).messages.flatMap(m=>m.toolCalls??[])[0];
    expect(attempt.status).toBe('denied');
    expect(attempt.output).toContain('denied by an explicit app permission rule');
    expect(await readFile(join(directory,'research.txt'),'utf8')).toBe('Workspace evidence');
  });

  it('PATCH /api/settings rejects an invalid rule set with 400 and passes valid rules through publicly',async()=>{
    const invalid=await api('/settings',{permissionRules:{version:1,rules:[{tool:'not_a_tool',decision:'allow'}]}},'PATCH');
    expect(invalid.status).toBe(400);expect(invalid.body.error).toContain('Invalid permission rules');
    expect(store.settings().permissionRules).toBeUndefined();
    const shape=await api('/settings',{permissionRules:{version:2,rules:[]}},'PATCH');
    expect(shape.status).toBe(400);
    const valid=await api('/settings',{permissionRules:rules([{tool:'bash',decision:'ask',patterns:['rm *']}])},'PATCH');
    expect(valid.status).toBe(200);
    expect((await api('/settings')).body.permissionRules).toEqual(rules([{tool:'bash',decision:'ask',patterns:['rm *']}]));
  });
  it('changes only the requested live permission mode, resolves its wait, and persists it', async () => {
    respond=oneCallThenText('write_file',{path:'live.txt',content:'allowed'});
    const s=await create(); runner.start(s.id,'Write');
    await until(()=>runner.permissions(s.id).length===1);
    const revision=store.session(s.id).configRevision ?? 0;
    expect((await api(`/sessions/${s.id}/permission-mode`,{permissionMode:'auto',expectedConfigRevision:revision+1},'PATCH')).status).toBe(409);
    expect(runner.permissions(s.id)).toHaveLength(1);
    expect((await api(`/sessions/${s.id}/permission-mode`,{permissionMode:'auto',expectedConfigRevision:revision},'PATCH')).status).toBe(200);
    await runner.whenIdle();
    expect(await readFile(join(directory,'live.txt'),'utf8')).toBe('allowed');
    expect(store.session(s.id).permissionMode).toBe('auto');
    await run(s.id); expect(prompts(s.id)).toHaveLength(1);
  });

  it('changing an idle session never changes another active session policy', async () => {
    const held: ServerResponse[]=[];
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):held.push(res);
    const idle=await create(), active=await create(); runner.start(active.id,'Write');
    await until(()=>held.length===1);
    runner.setPermissionMode(idle.id,'auto',store.session(idle.id).configRevision ?? 0);
    tools(held[0],[{name:'write_file',args:{path:'other.txt',content:'must ask'}}]);
    await until(()=>runner.permissions(active.id).length===1);
    expect(store.session(active.id).permissionMode).toBe('ask');
    runner.decide(active.id,runner.permissions(active.id)[0].id,'deny'); await runner.whenIdle();
    expect(toolCalls(active.id)[0].status).toBe('denied');
  });

  it('an explicit ask rule cannot be remembered or bypassed by Allow all tools', async () => {
    store.saveSettings({permissionRules:rules([{tool:'write_file',decision:'ask'}])});
    respond=oneCallThenText('write_file',{path:'hello.txt',content:'hi'});
    const s=await create();runner.start(s.id,'Write');await until(()=>runner.permissions(s.id).length===1);
    const request=runner.permissions(s.id)[0];expect(request.ruleMatch?.decision).toBe('ask');
    expect(()=>runner.decide(s.id,request.id,'always')).toThrow('explicit permission rule');
    runner.setPermissionMode(s.id,'auto',store.session(s.id).configRevision ?? 0);
    expect(runner.permissions(s.id)[0].id).toBe(request.id);
    runner.decide(s.id,request.id,'allow');await runner.whenIdle();
  });

  it.each(['always','auto'] as const)('shares %s approval with parallel and fresh isolated workers', async decision => {
    let batch=0;
    respond=(body,res)=> {
      if(body.model==='worker') {
        if(body.messages.at(-1)?.role==='tool') text(res,'Worker done');
        else tools(res,[{name:'write_file',args:{path:`worker-${++batch}.txt`,content:'worker edit'}}]);
      } else if(body.messages.at(-1)?.role==='tool') text(res);
      else tools(res,[{name:'delegate',args:{description:'First worker',prompt:'Write first'}},{name:'delegate',args:{description:'Second worker',prompt:'Write second'}}]);
    };
    const s=await create({architecture:{kind:'team-fusion',worker:{providerId:'test',model:'worker'}}});
    runner.start(s.id,'First round');await until(()=>runner.permissions(s.id).length>0);
    // Approving the delegation tool covers both sibling assignments.
    runner.decide(s.id,runner.permissions(s.id)[0].id,'always');
    await until(()=>runner.permissions(s.id).filter(p=>p.tool==='write_file').length===2);
    const requests=runner.permissions(s.id);expect(requests.every(p=>Boolean(p.invocationId))).toBe(true);
    if(decision==='auto') runner.setPermissionMode(s.id,'auto',store.session(s.id).configRevision ?? 0);
    else runner.decide(s.id,requests[0].id,'always');
    await runner.whenIdle();
    expect(runner.delegations.list(s.id)).toHaveLength(2);
    const count=prompts(s.id).length;
    runner.start(s.id,'Fresh round');
    await until(()=>!runner.active(s.id) || runner.permissions(s.id).length>0);
    expect(runner.permissions(s.id)).toHaveLength(0);
    await runner.whenIdle();expect(prompts(s.id)).toHaveLength(count);
    expect(batch).toBe(4);
  });

});
