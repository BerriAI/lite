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

describe('native Shunt integration',()=>{
  let directory:string,store:Store,server:Server,provider:Server,url:string,runner:ReturnType<typeof createApp>['runner'],calls:any[],respond:(body:any,res:ServerResponse)=>void;
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const create=async(extra:Record<string,unknown>={})=>{const result=await api('/sessions',{permissionMode:'auto',shunt:{enabled:true,model:{providerId:'test',model:'shunt-model'}},...extra});expect(result.status).toBe(201);return result.body;};
  const run=async(id:string,prompt='ROOT delegate')=>{runner.start(id,prompt);await runner.whenIdle();};
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'litespeed-shunt-runner-')));store=new Store(join(directory,'state'));calls=[];
    respond=(body,res)=>{if(body.model==='shunt-model')text(res,'The entry point exports start.');else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'bulk_read',args:{paths:['source.ts'],question:'What is exported?'}}]);};
    await writeFile(join(directory,'source.ts'),'SOURCE_ONLY_SENTINEL\n'+Array.from({length:400},(_,i)=>`export const item${i} = ${i};`).join('\n'));
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push({...body,_sessionId:req.headers['x-litellm-session-id']});respond(body,res);});
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider),apiKey:'fake-accepted-key'}],defaultProvider:'test',defaultModel:'model'});
    const external:ExternalTools={capture:vi.fn(()=>({definitions:[],scope:()=>'',assertCurrent:()=>{},execute:async()=>'',release:()=>{}}))} as any;const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();vi.restoreAllMocks();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it('uses a fresh tool-free model request, keeps source out of caller history, and charges the root session',async()=>{
    const session=await create();await run(session.id,'PRIVATE_DRIVER_HISTORY');
    const shunt=calls.find(body=>body.model==='shunt-model');
    expect(shunt).toBeDefined();expect(shunt.tools).toBeUndefined();expect(shunt.max_completion_tokens).toBe(2048);
    expect(shunt._sessionId).toBe(session.id);expect(JSON.stringify(shunt)).not.toContain('PRIVATE_DRIVER_HISTORY');
    expect(JSON.stringify(shunt)).toContain('SOURCE_ONLY_SENTINEL');
    expect(JSON.stringify(calls.filter(body=>body.model!=='shunt-model'))).not.toContain('SOURCE_ONLY_SENTINEL');
    expect(JSON.stringify(store.messages(session.id))).not.toContain('SOURCE_ONLY_SENTINEL');
    expect(runner.delegations.list(session.id)).toEqual([]);
    const call=store.messages(session.id).flatMap(m=>m.toolCalls??[])[0];
    expect(call).toMatchObject({status:'completed',shunt:{kind:'reader',model:'shunt-model',phase:'completed',sources:[{path:'source.ts',lines:401}]}});
    const usage=store.messages(session.id).at(-1)?.turnUsage;
    expect(usage?.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({role:'shunt',phase:'shunt_read',operationId:call.shunt!.id,rootSessionId:session.id})]));
  });

  it('leaves disabled requests without Shunt tools, instructions or routing',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'read_file',args:{path:'source.ts'}}]);
    const session=await create({shunt:{enabled:false}});await run(session.id);
    expect(names(calls[0])).not.toContain('bulk_read');expect(names(calls[0])).not.toContain('code_write');
    expect(JSON.stringify(calls[0])).not.toContain('direct_reason');
    expect(JSON.stringify(calls[1])).toContain('SOURCE_ONLY_SENTINEL');
  });

  it.each([{}, {offset:2}, {limit:351}])('routes broad reads without a permission denial: %j',async extra=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'read_file',args:{path:'source.ts',...extra}}]);
    const session=await create();await run(session.id);
    expect(JSON.stringify(calls)).not.toContain('SOURCE_ONLY_SENTINEL');
    expect(store.messages(session.id).flatMap(m=>m.toolCalls??[])[0]).toMatchObject({status:'completed',routing:{kind:'shunt'}});
    expect(store.session(session.id).status).toBe('idle');
  });

  it.each([{limit:3},{direct_reason:'Need exact implementation to debug this branch.'}])('permits agent-selected exact reads: %j',async extra=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'read_file',args:{path:'source.ts',...extra}}]);
    const session=await create();await run(session.id);
    expect(JSON.stringify(calls[1])).toContain('SOURCE_ONLY_SENTINEL');expect(calls).toHaveLength(2);
  });

  it('returns a small generation receipt, records real changes, and supports Undo',async()=>{
    respond=(body,res)=>body.model==='shunt-model'?text(res,'export const GENERATED_ONLY_SENTINEL = true;'):body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'code_write',args:{spec:'Generate a constant',reference:'source.ts',target:'generated.ts'}}]);
    const session=await create();await run(session.id);
    expect(await readFile(join(directory,'generated.ts'),'utf8')).toBe('export const GENERATED_ONLY_SENTINEL = true;');
    expect(JSON.stringify(calls.filter(body=>body.model!=='shunt-model'))).not.toContain('GENERATED_ONLY_SENTINEL');
    expect(store.messages(session.id).at(-1)?.receipts).toMatchObject({filesChanged:['generated.ts'],unreadFilesChanged:['generated.ts']});
    await runner.history.undo(session.id,runner.history.state(session.id).undoId!);
    await expect(readFile(join(directory,'generated.ts'),'utf8')).rejects.toThrow();
  });

  it('does not overwrite a target changed during generation',async()=>{
    await writeFile(join(directory,'generated.ts'),'original');
    respond=async(body,res)=>{if(body.model==='shunt-model'){await writeFile(join(directory,'generated.ts'),'concurrent user edit');text(res,'generated');}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'code_write',args:{spec:'Generate',reference:'source.ts',target:'generated.ts'}}]);};
    const session=await create();await run(session.id);
    expect(await readFile(join(directory,'generated.ts'),'utf8')).toBe('concurrent user edit');
    expect(store.messages(session.id).flatMap(m=>m.toolCalls??[])[0]).toMatchObject({status:'error',output:expect.stringContaining('target changed')});
    expect(store.changes(session.id)).toEqual([]);
  });

  it.each(['single','sidekick-fusion','team-fusion','expert-fusion'] as const)('keeps Shunt independent in %s',async kind=>{
    respond=(body,res)=>{
      if(body.model==='shunt-model')text(res,'The module exports constants.');
      else if(body.messages.at(-1)?.role==='tool')text(res);
      else if(kind==='single'||side(body))tools(res,[{name:'bulk_read',args:{paths:['source.ts'],question:'What does this do?'}}]);
      else tools(res,[{name:kind==='sidekick-fusion'?'sidekick':'delegate',args:{description:'Read source',prompt:'Analyze source.ts'}}]);
    };
    const architecture=kind==='single'?null:kind==='sidekick-fusion'?ARCHITECTURE:kind==='team-fusion'?{kind,worker:ARCHITECTURE.sidekick}:{kind,expert:ARCHITECTURE.sidekick};
    const session=await create({architecture});await run(session.id);
    expect(calls.filter(body=>body.model==='shunt-model')).toHaveLength(1);
    expect(JSON.stringify(calls.filter(body=>body.model!=='shunt-model'))).not.toContain('SOURCE_ONLY_SENTINEL');
    expect(runner.delegations.list(session.id)).toHaveLength(kind==='single'?0:1);
    expect(calls.every(body=>body._sessionId===session.id)).toBe(true);
  });

  it('honors denied sources before sending them to Shunt',async()=>{
    store.saveSettings({...store.settings(),permissionRules:{version:1,rules:[{tool:'read_file',decision:'deny',patterns:['source.ts']}]} } as any);
    const session=await create();await run(session.id);
    expect(calls.filter(body=>body.model==='shunt-model')).toHaveLength(0);
    expect(store.messages(session.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('denied');
  });

  it('recovers from a Shunt failure with an explicitly justified direct read',async()=>{
    respond=(body,res)=>{if(body.model==='shunt-model')text(res,'');else {const count=body.messages.filter((m:any)=>m.role==='tool').length;if(!count)tools(res,[{name:'bulk_read',args:{paths:['source.ts'],question:'Explain'}}]);else if(count===1)tools(res,[{name:'read_file',args:{path:'source.ts',direct_reason:'Shunt returned empty; inspect the implementation directly.'}}]);else text(res);}};
    const session=await create();await run(session.id);
    const outcomes=store.messages(session.id).flatMap(m=>m.toolCalls??[]);
    expect(outcomes.map(c=>c.status)).toEqual(['error','completed']);
    expect(outcomes[0].output).toContain('empty');expect(JSON.stringify(calls.at(-1))).toContain('SOURCE_ONLY_SENTINEL');
    expect(store.session(session.id).status).toBe('idle');
  });

  it('exposes only the reader in Plan mode and rejects missing Shunt routes',async()=>{
    const invalid=await api('/sessions',{shunt:{enabled:true,model:{providerId:'missing',model:'x'}}});expect(invalid.status).toBe(400);
    const session=await create({mode:'plan'});await run(session.id);
    expect(names(calls[0])).toContain('bulk_read');expect(names(calls[0])).not.toContain('code_write');
  });

  it.each(['length','missing-stop','tool-call'])('never writes incomplete or non-text generation: %s',async failure=>{
    respond=(body,res)=>{if(body.model==='shunt-model'){
      if(failure==='tool-call')tools(res,[{name:'write_file',args:{path:'forbidden',content:'bad'}}]);
      else stream(res,{content:'partial generated content'},failure==='length'?'length':'');
    }else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'code_write',args:{spec:'Generate',reference:'source.ts',target:'generated.ts'}}]);};
    const session=await create();await run(session.id);
    expect(store.messages(session.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('error');
    await expect(readFile(join(directory,'generated.ts'))).rejects.toThrow();
  });

  it('asks for the actual generated write, accepts a denial, and exposes no code in the caller context',async()=>{
    respond=(body,res)=>body.model==='shunt-model'?text(res,'GENERATED_CONTENT'):body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'code_write',args:{spec:'Generate',reference:'source.ts',target:'generated.ts'}}]);
    const session=await create({permissionMode:'ask'});runner.start(session.id,'Generate');
    await until(()=>runner.permissions(session.id).length===1);
    const permission=runner.permissions(session.id)[0];expect(permission).toMatchObject({tool:'write_file',args:{path:'generated.ts',content:'GENERATED_CONTENT'}});
    runner.decide(session.id,permission.id,'deny');await runner.whenIdle();
    expect(JSON.stringify(calls.filter(body=>body.model!=='shunt-model'))).not.toContain('GENERATED_CONTENT');
    await expect(readFile(join(directory,'generated.ts'))).rejects.toThrow();
    expect(store.messages(session.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('denied');
  });

  it('cancels an in-flight model request without writing its partial output',async()=>{
    respond=(body,res)=>{if(body.model==='shunt-model'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'unfinished'}}]})+'\n\n');}else tools(res,[{name:'code_write',args:{spec:'Generate',reference:'source.ts',target:'generated.ts'}}]);};
    const session=await create();runner.start(session.id,'Generate');
    await until(()=>calls.some(body=>body.model==='shunt-model'));runner.cancel(session.id);await runner.whenIdle();
    await expect(readFile(join(directory,'generated.ts'))).rejects.toThrow();expect(runner.permissions(session.id)).toEqual([]);
  });

  it('publishes the last text chunk while the model is still running',async()=>{
    let pending:ServerResponse|undefined;
    respond=(body,res)=>{if(body.model==='shunt-model'){pending=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'Visible before completion'}}]})+'\n\n');}else if(body.messages.at(-1)?.role==='tool')text(res);else tools(res,[{name:'bulk_read',args:{paths:['source.ts'],question:'Explain'}}]);};
    const session=await create();runner.start(session.id,'Read');
    await until(()=>store.messages(session.id).some(m=>m.toolCalls?.some(c=>c.output==='Visible before completion')));
    expect(store.session(session.id).status).toBe('running');
    pending!.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    await runner.whenIdle();
  });

  it.each(['source','target'])('honors a %s hook veto on the underlying file action',async subject=>{
    store.saveSettings({hooks:[{event:'PreToolUse',command:'exit 2',matcher:subject==='source'?'read_file':'write_file'}]});
    respond=(body,res)=>body.model==='shunt-model'?text(res,'generated'):body.messages.at(-1)?.role==='tool'?text(res):tools(res,[{name:'code_write',args:{spec:'Generate',reference:'source.ts',target:'generated.ts'}}]);
    const session=await create();await run(session.id);
    expect(calls.filter(body=>body.model==='shunt-model')).toHaveLength(subject==='source'?0:1);
    expect(store.messages(session.id).flatMap(m=>m.toolCalls??[])[0]).toMatchObject({status:'denied',output:expect.stringContaining('PreToolUse')});
    await expect(readFile(join(directory,'generated.ts'))).rejects.toThrow();
  });

  it('keeps selection across revisions and workspace defaults, but disables it for imports',async()=>{
    const session=await create();
    const off={enabled:false,model:{providerId:'test',model:'shunt-model'}};
    const updated=await api(`/sessions/${session.id}`,{shunt:off,expectedConfigRevision:session.configRevision??0},'PATCH');expect(updated.status).toBe(200);expect(updated.body.shunt).toEqual(off);
    const stale=await api(`/sessions/${session.id}`,{shunt:{enabled:true,model:off.model},expectedConfigRevision:session.configRevision??0},'PATCH');expect(stale.status).toBe(409);
    const preference=await api('/workspace-preferences',{workspace:directory,providerId:'test',model:'model',shunt:{enabled:true,model:off.model},setupComplete:true});expect(preference.status).toBe(200);
    const fresh=await api('/sessions',{});expect(fresh.body.shunt).toEqual({enabled:true,model:off.model});
    const imported=await api('/sessions/import',{session:{...fresh.body,title:'Shunt import'},messages:[{id:'one',role:'user',content:'Hi',createdAt:1}]});expect(imported.status).toBe(201);expect(imported.body.shunt).toBeUndefined();
  });

  it('reads each parallel worker’s own version of a file',async()=>{
    respond=(body,res)=>{
      if(body.model==='shunt-model'){text(res,'The selected file contains a private worker value.');return;}
      const count=body.messages.filter((m:any)=>m.role==='tool').length;
      if(side(body)) {
        const brief=body.messages.find((m:any)=>m.role==='user').content;
        if(!count)tools(res,[{name:'write_file',args:{path:'local.txt',content:`PRIVATE_WORKER_${brief}`}}]);
        else if(count===1)tools(res,[{name:'bulk_read',args:{paths:['local.txt'],question:'Describe my local value'}}]);else text(res);
      }else if(!count)tools(res,['alpha','beta'].map(name=>({name:'delegate',args:{description:name,prompt:name}})));else text(res);
    };
    const session=await create({architecture:{kind:'team-fusion',worker:ARCHITECTURE.sidekick}});await run(session.id);
    const shunts=calls.filter(body=>body.model==='shunt-model').map(body=>JSON.stringify(body));
    expect(shunts).toHaveLength(2);expect(shunts.filter(body=>body.includes('PRIVATE_WORKER_alpha'))).toHaveLength(1);expect(shunts.filter(body=>body.includes('PRIVATE_WORKER_beta'))).toHaveLength(1);
    expect(shunts.every(body=>!(body.includes('PRIVATE_WORKER_alpha')&&body.includes('PRIVATE_WORKER_beta')))).toBe(true);
    await expect(readFile(join(directory,'local.txt'))).rejects.toThrow();
  });

  it.each(['sidekick-fusion','team-fusion','expert-fusion'] as const)('integrates and undoes Shunt-generated %s changes through the ordinary worker path',async kind=>{
    await writeFile(join(directory,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
    respond=(body,res)=>{
      if(body.model==='shunt-model'){text(res,'export const generated = 42;');return;}
      const count=body.messages.filter((m:any)=>m.role==='tool').length;
      if(side(body)){if(!count)tools(res,[{name:'code_write',args:{spec:'Generate a constant',reference:'source.ts',target:'generated.ts'}}]);else text(res,'Generated the file. Verify it.');}
      else if(!count)tools(res,[{name:kind==='sidekick-fusion'?'sidekick':'delegate',args:{description:'Generate',prompt:'Generate generated.ts'}}]);
      else if(count===1)tools(res,[{name:kind==='sidekick-fusion'?'bash':'verify',args:{command:'npm test'}}]);else text(res);
    };
    const architecture=kind==='sidekick-fusion'?ARCHITECTURE:kind==='team-fusion'?{kind,worker:ARCHITECTURE.sidekick}:{kind,expert:ARCHITECTURE.sidekick};
    const session=await create({architecture});await run(session.id);
    expect(await readFile(join(directory,'generated.ts'),'utf8')).toBe('export const generated = 42;');
    expect(runner.delegations.list(session.id)[0].status).toBe('completed');
    expect(store.messages(session.id).at(-1)?.receipts).toMatchObject({filesChanged:['generated.ts'],unresolvedChecks:[]});
    await runner.history.undo(session.id,runner.history.state(session.id).undoId!);await expect(readFile(join(directory,'generated.ts'))).rejects.toThrow();
  });
});
