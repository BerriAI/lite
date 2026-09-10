import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { McpManager } from '../server/mcp.js';
import type { ExternalTools, ExternalToolLease } from '../server/external.js';
import type { McpServerStatus } from '../shared/mcp.js';
import type { ToolDefinition } from '../shared/types.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean)=>{const deadline=Date.now()+4000;while(!check()){if(Date.now()>deadline)throw new Error('Timed out waiting for MCP integration');await new Promise(resolve=>setTimeout(resolve,5));}};
const text=(res:ServerResponse,content='Done')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);};
const tool=(res:ServerResponse,name='mcp_demo_echo',args:Record<string,unknown>={text:'hello'})=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'mcp-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);};
const fail=(message:string,status=409)=>Object.assign(new Error(message),{status});

describe('immutable MCP turn lease and explicit lifecycle API integration',()=>{
  let directory:string,store:Store,server:Server,provider:Server,url:string,runner:ReturnType<typeof createApp>['runner'];
  let realManager:McpManager|undefined;
  let calls:any[],respond:(body:any,res:ServerResponse)=>void,generation:number,scopeValue:string,connected:boolean,definition:ToolDefinition;
  let captured:ReturnType<typeof vi.fn>[],executions:{generation:number,args:Record<string,unknown>}[],releaseError:boolean;
  let external:ExternalTools & {capture:ReturnType<typeof vi.fn>;status:ReturnType<typeof vi.fn>;refresh:ReturnType<typeof vi.fn>;reconnect:ReturnType<typeof vi.fn>};
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const create=async(extra:Record<string,unknown>={})=>{const response=await api('/sessions',extra);expect(response.status).toBe(201);return response.body;};
  const run=async(id:string)=>{runner.start(id,'Use the connected tool');await runner.whenIdle();};
  const realFixture=async()=>{
    runner.stopAll();await runner.whenIdle();await close(server);
    const script=join(directory,'audit-mcp.mjs'),log=join(directory,'audit-mcp.log'),catalog=join(directory,'catalog.json'),notification=join(directory,'notify.txt');
    await writeFile(catalog,JSON.stringify([{name:'echo',description:'Original catalog',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]));await writeFile(notification,'0');
    await writeFile(script,`import {appendFileSync,readFileSync,watchFile} from 'node:fs';import {createInterface} from 'node:readline';const [log,catalog,notification]=process.argv.slice(2);const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const reply=(id,result)=>send({jsonrpc:'2.0',id,result});appendFileSync(log,'spawn\\n');watchFile(notification,{interval:10},(now,old)=>{if(now.mtimeMs!==old.mtimeMs)send({jsonrpc:'2.0',method:'notifications/tools/list_changed'});});createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;appendFileSync(log,m.method+'\\n');if(m.method==='initialize')reply(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}});else if(m.method==='tools/list')reply(m.id,{tools:JSON.parse(readFileSync(catalog,'utf8'))});else if(m.method==='tools/call')reply(m.id,{content:[{type:'text',text:'Executed once'}]});else reply(m.id,{});});process.stdin.on('end',()=>process.exit(0));`);
    // advertise:true — these fixtures exercise the DIRECT advertisement path,
    // which Phase 4.6 made per-server opt-in (default routes via the gateway).
    store.saveSettings({mcpServers:{demo:{command:process.execPath,args:[script,log,catalog,notification],advertise:true}}});realManager=new McpManager(()=>store.settings().mcpServers);const app=createApp({store,external:realManager});runner=app.runner;server=createServer(app.app);url=await listen(server);
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,body.tools.find((t:ToolDefinition)=>t.function.name.startsWith('mcp_')).function.name);
    return{log,catalog,notification,records:async()=>{try{return(await readFile(log,'utf8')).trim().split('\n');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}}};
  };
  const lifecycle=async(action:'refresh'|'reconnect')=>{const status=(await api('/mcp')).body;const response=await api(`/mcp/demo/${action}`,{expectedRevision:status.servers[0].revision,expectedConfigRevision:status.configRevision});expect(response.status).toBe(200);return response.body;};
  const configRevision=()=>createHash('sha256').update(JSON.stringify(store.settings().mcpServers)).digest('hex');
  const statuses=():McpServerStatus[]=>[{name:'demo',revision:String(generation),status:connected?'connected':'disconnected',tools:connected?[{name:definition.function.name,remoteName:'echo',description:definition.function.description}]:[]}];
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'speedrail-mcp-runner-')));store=new Store(join(directory,'state'));calls=[];captured=[];executions=[];generation=1;scopeValue='demo-schema-one';connected=true;releaseError=false;
    definition={type:'function',function:{name:'mcp_demo_echo',description:'Original description',parameters:{type:'object',properties:{text:{type:'string'}}}}};
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res);
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);respond(body,res);});
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider)}],defaultProvider:'test',defaultModel:'test-model',mcpServers:{demo:{command:'reviewed-command',env:{TOKEN:'fake-token-for-test'}}}});
    external={
      capture:vi.fn((signal:AbortSignal):ExternalToolLease=>{
        const version=generation,token=configRevision(),scope=scopeValue,definitions=connected?[structuredClone(definition)]:[];let released=false;
        const assertCurrent=(name:string)=>{if(released||signal.aborted||version!==generation||token!==configRevision()||!connected||!definitions.some(tool=>tool.function.name===name))throw fail('Connected tools changed. Refresh and start a new turn.');};
        const release=vi.fn(()=>{released=true;if(releaseError)throw new Error('Release failed');});captured.push(release);
        return{definitions,scope:()=>scope,assertCurrent,execute:async(name,args,callSignal)=>{assertCurrent(name);callSignal.throwIfAborted();executions.push({generation:version,args});return 'Executed once';},release};
      }),
      status:vi.fn(()=>statuses()),configRevision,
      refresh:vi.fn(async(name:string,expected:string,signal:AbortSignal)=>{signal.throwIfAborted();if(name!=='demo')throw fail('Server not found',404);if(expected!==String(generation))throw fail('Server revision changed');generation++;connected=true;return statuses();}),
      reconnect:vi.fn(async(name:string,expected:string,signal:AbortSignal)=>{signal.throwIfAborted();if(name!=='demo')throw fail('Server not found',404);if(expected!==String(generation))throw fail('Server revision changed');generation++;connected=true;return statuses();}),
    };
    const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();await realManager?.close();realManager=undefined;vi.restoreAllMocks();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it('captures cache-only once before acceptance and releases once after ordinary completion',async()=>{
    const s=await create({permissionMode:'auto'}),accept=vi.spyOn(runner.history,'accept');await run(s.id);
    expect(external.capture).toHaveBeenCalledOnce();expect(external.capture.mock.invocationCallOrder[0]).toBeLessThan(accept.mock.invocationCallOrder[0]);expect(captured[0]).toHaveBeenCalledOnce();expect(executions).toHaveLength(1);expect(external.refresh).not.toHaveBeenCalled();expect(external.reconnect).not.toHaveBeenCalled();expect(calls).toHaveLength(2);
  });

  it('cold cached state advertises no tools and cannot silently connect during generation',async()=>{
    connected=false;respond=(_body,res)=>text(res);const s=await create();await run(s.id);expect(calls[0].tools.some((t:ToolDefinition)=>t.function.name.startsWith('mcp_'))).toBe(false);expect(external.refresh).not.toHaveBeenCalled();expect(external.reconnect).not.toHaveBeenCalled();expect(captured[0]).toHaveBeenCalledOnce();
  });

  it.each(['plan','profile'])('%s never captures a connected-tool lease or advertises MCP',async(kind)=>{
    let input:Record<string,unknown>={mode:'plan'};
    if(kind==='profile'){await mkdir(join(directory,'.speedrail'));await writeFile(join(directory,'.speedrail','profiles.json'),JSON.stringify({version:1,profiles:[{id:'safe',name:'Safe',instructions:'Only read',tools:['read_file']}],skills:[]}));const catalog=(await api('/profiles')).body;input={mode:'build',profile:{profileId:'safe',skillIds:[],catalogRevision:catalog.revision}};}
    respond=(_body,res)=>text(res);const s=await create(input);await run(s.id);expect(external.capture).not.toHaveBeenCalled();expect(calls[0].tools.some((t:ToolDefinition)=>t.function.name.startsWith('mcp_'))).toBe(false);
  });

  it('failed capture rejects before accepting user input or consuming queued work',async()=>{
    const s=await create();external.capture.mockImplementation(()=>{throw fail('Catalog snapshot unavailable');});
    expect((await api(`/sessions/${s.id}/messages`,{content:'Not accepted'})).status).toBe(409);expect(store.messages(s.id)).toEqual([]);expect(runner.history.state(s.id).canUndo).toBe(false);
    runner.enqueue(s.id,'Queued');runner.resumeQueue(s.id);expect(store.queue(s.id).items).toHaveLength(1);expect(store.queue(s.id).paused).toBe(true);expect(store.messages(s.id)).toEqual([]);expect(calls).toEqual([]);
  });

  it.each(['accept','startup-event','seal'])('releases captured lease despite %s persistence failure',async(failure)=>{
    const s=await create({permissionMode:'auto'});vi.spyOn(console,'error').mockImplementation(()=>{});
    if(failure==='accept')vi.spyOn(runner.history,'accept').mockImplementation(()=>{throw new Error('Acceptance failed');});
    else if(failure==='startup-event')store.db.exec("CREATE TRIGGER fail_mcp_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event failed'); END;");
    else vi.spyOn(runner.history,'seal').mockImplementation(()=>{throw new Error('Seal failed');});
    try{if(failure==='seal')await run(s.id);else expect(()=>runner.start(s.id,'Attempt')).toThrow();await runner.whenIdle();}finally{if(failure==='startup-event')store.db.exec('DROP TRIGGER fail_mcp_event');}
    expect(captured).toHaveLength(1);expect(captured[0]).toHaveBeenCalledOnce();expect(runner.active(s.id)).toBe(false);
  });

  it('release failure does not strand the active run or prevent whenIdle',async()=>{
    const s=await create({permissionMode:'auto'});releaseError=true;vi.spyOn(console,'error').mockImplementation(()=>{});await run(s.id);expect(runner.active(s.id)).toBe(false);expect(captured[0]).toHaveBeenCalledOnce();
  });

  it('pending approval never executes on either original or replacement generation after reconnect',async()=>{
    const s=await create();runner.start(s.id,'Use tool');await until(()=>runner.permissions(s.id).length===1);const pending=runner.permissions(s.id)[0];
    generation++;runner.decide(s.id,pending.id,'allow');await runner.whenIdle();expect(executions).toEqual([]);expect(store.messages(s.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('error');expect(captured[0]).toHaveBeenCalledOnce();expect(calls).toHaveLength(2);
  });

  it('auto mode cannot bypass stale captured catalog after provider request began',async()=>{
    const s=await create({permissionMode:'auto'});let finish!:()=>void;respond=(body,res)=>{if(body.messages.at(-1)?.role==='tool')text(res);else finish=()=>tool(res);};
    runner.start(s.id,'Use tool');await until(()=>Boolean(finish));generation++;finish();await runner.whenIdle();expect(executions).toEqual([]);expect(runner.permissions(s.id)).toEqual([]);expect(calls).toHaveLength(2);
  });

  it('allow-always grants bind captured tool scope, not a subsequently changed configuration',async()=>{
    const s=await create();runner.start(s.id,'Use tool');await until(()=>runner.permissions(s.id).length===1);const pending=runner.permissions(s.id)[0];
    store.saveSettings({mcpServers:{demo:{command:'replacement-command'}}});generation++;scopeValue='demo-schema-two';runner.decide(s.id,pending.id,'always');await runner.whenIdle();expect(executions).toEqual([]);
    runner.start(s.id,'Try reviewed replacement');await until(()=>runner.permissions(s.id).length===1);expect(executions).toEqual([]);runner.cancel(s.id);await runner.whenIdle();expect(captured.every(release=>release.mock.calls.length===1)).toBe(true);
  });

  it('unchanged captured per-tool scope reuses grants without tying permission to unrelated server config',async()=>{
    const s=await create();runner.start(s.id,'Use tool');await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'always');await runner.whenIdle();expect(executions).toHaveLength(1);
    store.saveSettings({mcpServers:{...store.settings().mcpServers,unrelated:{command:'other-server',enabled:false}}});await run(s.id);expect(executions).toHaveLength(2);expect(runner.permissions(s.id)).toEqual([]);expect(captured).toHaveLength(2);
  });

  it('provider schemas stay captured across a multi-step turn and queued work gets a fresh lease',async()=>{
    const s=await create({permissionMode:'auto'});let releaseFirst!:()=>void;respond=(body,res)=>{if(calls.length===1)releaseFirst=()=>tool(res);else text(res);};
    runner.start(s.id,'First');await until(()=>Boolean(releaseFirst));runner.enqueue(s.id,'Next turn');definition.function.description='Updated description';releaseFirst();await until(()=>calls.length===3);await runner.whenIdle();
    expect(calls).toHaveLength(3);expect(calls[0].tools.find((t:ToolDefinition)=>t.function.name==='mcp_demo_echo').function.description).toBe('Original description');expect(calls[1].tools.find((t:ToolDefinition)=>t.function.name==='mcp_demo_echo').function.description).toBe('Original description');expect(calls[2].tools.find((t:ToolDefinition)=>t.function.name==='mcp_demo_echo').function.description).toBe('Updated description');expect(external.capture).toHaveBeenCalledTimes(2);expect(captured.every(release=>release.mock.calls.length===1)).toBe(true);
  });

  it('cancel releases a waiting approval and never dispatches, while undo/redo never captures or replays',async()=>{
    const s=await create();runner.start(s.id,'Use tool');await until(()=>runner.permissions(s.id).length===1);runner.cancel(s.id);await runner.whenIdle();expect(executions).toEqual([]);expect(captured[0]).toHaveBeenCalledOnce();const after=store.messages(s.id),count=calls.length;
    await runner.history.undo(s.id,runner.history.state(s.id).undoId!);await runner.history.redo(s.id,runner.history.state(s.id).redoId!);expect(store.messages(s.id)).toEqual(after);expect(external.capture).toHaveBeenCalledOnce();expect(calls).toHaveLength(count);
  });

  it('real manager API reconnect cannot redirect a tool already awaiting permission to replacement stdio server',async()=>{
    runner.stopAll();await runner.whenIdle();await close(server);
    const script=join(directory,'mcp-server.mjs'),counter=join(directory,'calls.log');
    await writeFile(script,`import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';const marker=process.argv[2],counter=process.argv[3];const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='initialize')reply(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}});else if(m.method==='tools/list')reply(m.id,{tools:[{name:'echo',inputSchema:{type:'object'}}]});else if(m.method==='tools/call'){appendFileSync(counter,marker+'\\n');reply(m.id,{content:[{type:'text',text:marker}]});}else reply(m.id,{});});`);
    // advertise:true keeps this scenario on the direct path (Phase 4.6 default is gateway).
    store.saveSettings({mcpServers:{demo:{command:process.execPath,args:[script,'original',counter],advertise:true}}});realManager=new McpManager(()=>store.settings().mcpServers);const app=createApp({store,external:realManager});runner=app.runner;server=createServer(app.app);url=await listen(server);
    const cold=(await api('/mcp')).body;expect(cold.servers[0].status).toBe('disconnected');
    expect((await api('/mcp/demo/reconnect',{expectedRevision:cold.servers[0].revision,expectedConfigRevision:cold.configRevision})).status).toBe(200);
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,body.tools.find((t:ToolDefinition)=>t.function.name.startsWith('mcp_')).function.name);
    const s=await create();runner.start(s.id,'Original advertised tool');await until(()=>runner.permissions(s.id).length===1);const permission=runner.permissions(s.id)[0];
    const previous=(await api('/settings')).body;expect((await api('/settings',{mcpServers:{demo:{command:process.execPath,args:[script,'replacement',counter],advertise:true}},expectedMcpConfigRevision:previous.mcpConfigRevision},'PATCH')).status).toBe(200);
    const replacement=(await api('/mcp')).body;expect((await api('/mcp/demo/reconnect',{expectedRevision:replacement.servers[0].revision,expectedConfigRevision:replacement.configRevision})).status).toBe(200);
    runner.decide(s.id,permission.id,'always');await runner.whenIdle();expect(store.messages(s.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('error');
    await expect(readFile(counter,'utf8')).rejects.toMatchObject({code:'ENOENT'});
    runner.start(s.id,'Use reviewed replacement');await until(()=>runner.permissions(s.id).length===1);await expect(readFile(counter,'utf8')).rejects.toMatchObject({code:'ENOENT'});runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();expect(await readFile(counter,'utf8')).toBe('replacement\n');expect(calls).toHaveLength(4);
  });

  it('real manager cold status and a Build turn never spawn a configured process',async()=>{
    const fixture=await realFixture();await api('/settings');await api('/mcp');respond=(_body,res)=>text(res);const s=await create();await run(s.id);
    expect(await fixture.records()).toEqual([]);expect(calls[0].tools.some((t:ToolDefinition)=>t.function.name.startsWith('mcp_'))).toBe(false);
    await lifecycle('reconnect');expect((await fixture.records()).filter(line=>line==='spawn')).toHaveLength(1);expect((await fixture.records()).filter(line=>line==='tools/list')).toHaveLength(1);
  });

  it.each(['refresh','reconnect'] as const)('real manager %s invalidates pending approval but stable catalog retains captured remembered grant on the next turn',async(action)=>{
    const fixture=await realFixture();await lifecycle('reconnect');const s=await create();runner.start(s.id,'Capture original generation');await until(()=>runner.permissions(s.id).length===1);const pending=runner.permissions(s.id)[0];
    await lifecycle(action);runner.decide(s.id,pending.id,'always');await runner.whenIdle();expect((await fixture.records()).filter(line=>line==='tools/call')).toEqual([]);expect(store.messages(s.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('error');
    runner.start(s.id,'Use fresh stable catalog');await until(()=>!runner.active(s.id)||runner.permissions(s.id).length>0);expect(runner.permissions(s.id)).toEqual([]);await runner.whenIdle();
    const records=await fixture.records();expect(records.filter(line=>line==='tools/call')).toHaveLength(1);expect(records.filter(line=>line==='spawn')).toHaveLength(action==='refresh'?1:2);expect(records.filter(line=>line==='tools/list')).toHaveLength(2);
  });

  it('real listChanged immediately rejects pending approval without automatic discovery, then requires new approval for changed catalog',async()=>{
    const fixture=await realFixture();await lifecycle('reconnect');const s=await create();runner.start(s.id,'Await permission');await until(()=>runner.permissions(s.id).length===1);const pending=runner.permissions(s.id)[0];
    await writeFile(fixture.catalog,JSON.stringify([{name:'echo',description:'Changed catalog',inputSchema:{type:'object',properties:{text:{type:'string'},changed:{type:'boolean'}}}}]));await writeFile(fixture.notification,'1');await until(()=>realManager!.status()[0].status==='stale');
    await api('/mcp');expect((await fixture.records()).filter(line=>line==='tools/list')).toHaveLength(1);runner.decide(s.id,pending.id,'always');await runner.whenIdle();expect((await fixture.records()).filter(line=>line==='tools/call')).toEqual([]);
    await lifecycle('refresh');runner.start(s.id,'Use reviewed changed catalog');await until(()=>runner.permissions(s.id).length===1);expect((await fixture.records()).filter(line=>line==='tools/call')).toEqual([]);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');await runner.whenIdle();
    expect((await fixture.records()).filter(line=>line==='tools/call')).toHaveLength(1);expect(calls[0].tools.find((t:ToolDefinition)=>t.function.name.startsWith('mcp_')).function.description).toContain('Original catalog');expect(calls[1].tools.find((t:ToolDefinition)=>t.function.name.startsWith('mcp_')).function.description).toContain('Original catalog');expect(calls[2].tools.find((t:ToolDefinition)=>t.function.name.startsWith('mcp_')).function.description).toContain('Changed catalog');
  });

  it('real catalog schema change invalidates an established grant while unrelated saved configuration does not',async()=>{
    const fixture=await realFixture();await lifecycle('reconnect');const s=await create();runner.start(s.id,'Remember original tool');await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'always');await runner.whenIdle();
    const previous=(await api('/settings')).body;expect((await api('/settings',{mcpServers:{...store.settings().mcpServers,unrelated:{command:'unused',enabled:false}},expectedMcpConfigRevision:previous.mcpConfigRevision},'PATCH')).status).toBe(200);
    runner.start(s.id,'Reuse original grant');await until(()=>!runner.active(s.id)||runner.permissions(s.id).length>0);expect(runner.permissions(s.id)).toEqual([]);await runner.whenIdle();expect((await fixture.records()).filter(line=>line==='tools/call')).toHaveLength(2);
    await writeFile(fixture.catalog,JSON.stringify([{name:'echo',description:'Original catalog',inputSchema:{type:'object',properties:{newField:{type:'string'}}}}]));await lifecycle('refresh');runner.start(s.id,'Changed schema needs permission');await until(()=>runner.permissions(s.id).length===1);expect((await fixture.records()).filter(line=>line==='tools/call')).toHaveLength(2);runner.cancel(s.id);await runner.whenIdle();
  });

  it('real saved configuration invalidation blocks pending call before any replacement connection',async()=>{
    const fixture=await realFixture();await lifecycle('reconnect');const s=await create();runner.start(s.id,'Await permission');await until(()=>runner.permissions(s.id).length===1);const pending=runner.permissions(s.id)[0],previous=(await api('/settings')).body;
    expect((await api('/settings',{mcpServers:{demo:{...store.settings().mcpServers.demo,env:{NEW:'replacement'}}},expectedMcpConfigRevision:previous.mcpConfigRevision},'PATCH')).status).toBe(200);expect((await api('/mcp')).body.servers[0].status).toBe('disconnected');runner.decide(s.id,pending.id,'allow');await runner.whenIdle();
    expect((await fixture.records()).filter(line=>line==='tools/call')).toEqual([]);expect((await fixture.records()).filter(line=>line==='spawn')).toHaveLength(1);
  });

  it('settings and MCP status expose the same config token without connection or discovery side effects',async()=>{
    const settings=await api('/settings'),status=await api('/mcp');expect(settings.body.mcpConfigRevision).toBe(status.body.configRevision);expect(JSON.stringify(settings.body)).not.toContain('fake-token-for-test');expect(external.capture).not.toHaveBeenCalled();expect(external.refresh).not.toHaveBeenCalled();expect(external.reconnect).not.toHaveBeenCalled();
  });

  it('explicit lifecycle actions require both reviewed-config and current-server revisions',async()=>{
    const status=(await api('/mcp')).body;
    expect((await api('/mcp/demo/reconnect',{expectedRevision:status.servers[0].revision})).status).toBe(400);
    expect((await api('/mcp/demo/reconnect',{expectedRevision:status.servers[0].revision,expectedConfigRevision:'stale'})).status).toBe(409);expect(external.reconnect).not.toHaveBeenCalled();
    const result=await api('/mcp/demo/reconnect',{expectedRevision:status.servers[0].revision,expectedConfigRevision:status.configRevision});expect(result.status).toBe(200);expect(result.body.servers[0].revision).not.toBe(status.servers[0].revision);
    expect((await api('/mcp/demo/refresh',{expectedRevision:status.servers[0].revision,expectedConfigRevision:status.configRevision})).status).toBe(409);expect(calls).toEqual([]);
  });

  it('cross-tab MCP save conflicts without overwriting config or accepting revision fields as settings',async()=>{
    const old=(await api('/settings')).body;const saved=await api('/settings',{mcpServers:{demo:{command:'replacement'}},expectedMcpConfigRevision:old.mcpConfigRevision,mcpConfigRevision:'forged'},'PATCH');expect(saved.status).toBe(200);expect(saved.body.mcpConfigRevision).not.toBe(old.mcpConfigRevision);expect(saved.body.mcpConfigRevision).not.toBe('forged');expect(store.settings().mcpConfigRevision).toBeUndefined();
    expect((await api('/settings',{mcpServers:{demo:{command:'stale'}},expectedMcpConfigRevision:old.mcpConfigRevision},'PATCH')).status).toBe(409);expect(store.settings().mcpServers.demo.command).toBe('replacement');
    expect((await api('/mcp/demo/reconnect',{expectedRevision:String(generation),expectedConfigRevision:old.mcpConfigRevision})).status).toBe(409);expect(external.reconnect).not.toHaveBeenCalled();
    expect((await api('/settings',{mcpServers:Object.fromEntries(Array.from({length:31},(_,index)=>[`server${index}`,{command:'noop'}]))},'PATCH')).status).toBe(400);
  });

  it('shutdown aborts lifecycle operations, waits for cleanup, and gates further reconnects',async()=>{
    let observed:AbortSignal|undefined,release!:()=>void;external.refresh.mockImplementation(async(_name,_revision,signal)=>{observed=signal;await new Promise<void>(resolve=>{release=resolve;});signal.throwIfAborted();return statuses();});const status=(await api('/mcp')).body;
    const pending=api('/mcp/demo/refresh',{expectedRevision:status.servers[0].revision,expectedConfigRevision:status.configRevision});await until(()=>Boolean(observed));runner.stopAll();expect(observed!.aborted).toBe(true);let idle=false;const wait=runner.whenIdle().then(()=>{idle=true;});await new Promise(resolve=>setTimeout(resolve,10));expect(idle).toBe(false);expect((await api('/mcp/demo/reconnect',{expectedRevision:status.servers[0].revision,expectedConfigRevision:status.configRevision})).status).toBe(409);release();expect((await pending).status).toBeGreaterThanOrEqual(400);await wait;expect(calls).toEqual([]);
  });

  it('disconnected HTTP lifecycle request aborts the manager signal and releases tracked work',async()=>{
    let observed:AbortSignal|undefined,release!:()=>void;external.reconnect.mockImplementation(async(_name,_revision,signal)=>{observed=signal;await new Promise<void>(resolve=>{release=resolve;});signal.throwIfAborted();return statuses();});const status=(await api('/mcp')).body,controller=new AbortController();
    const request=fetch(url+'/api/mcp/demo/reconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:status.servers[0].revision,expectedConfigRevision:status.configRevision}),signal:controller.signal}).catch(error=>error);await until(()=>Boolean(observed));controller.abort();await request;await until(()=>Boolean(observed?.aborted));release();await runner.whenIdle();expect(calls).toEqual([]);
  });
});
