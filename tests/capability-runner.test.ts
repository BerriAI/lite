import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { ExternalTools, ExternalToolLease } from '../server/external.js';
import type { ToolDefinition } from '../shared/types.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean)=>{const deadline=Date.now()+4000;while(!check()){if(Date.now()>deadline)throw new Error('Timed out waiting for capability integration');await new Promise(resolve=>setTimeout(resolve,5));}};
const text=(res:ServerResponse,content='Done')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);};
const tool=(res:ServerResponse,name:string,args:Record<string,unknown>)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'cap-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);};
const fail=(message:string,status=409)=>Object.assign(new Error(message),{status});
const definition=(name:string,description:string):ToolDefinition=>({type:'function',function:{name,description,parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}});

describe('capability gateway: stable connected-tool surface',()=>{
  let directory:string,store:Store,server:Server,provider:Server,url:string,runner:ReturnType<typeof createApp>['runner'];
  let calls:any[],respond:(body:any,res:ServerResponse)=>void;
  // Two connected servers: 'browser' is gateway-routed (advertise unset), 'trusted'
  // opted into direct advertisement. generation simulates refresh/reconnect.
  let generation:number,gatewayDefs:ToolDefinition[],directDefs:ToolDefinition[],gatewayServer:(name:string)=>string,scopes:Record<string,string>;
  let executions:{name:string,args:Record<string,unknown>}[];
  let external:ExternalTools & {capture:ReturnType<typeof vi.fn>};
  const gw1='mcp_browser_click_11111111',gw2='mcp_other_scrape_22222222',direct='mcp_trusted_echo_33333333';
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const create=async(extra:Record<string,unknown>={})=>{const response=await api('/sessions',extra);expect(response.status).toBe(201);return response.body;};
  const run=async(id:string,content='Use connected tools')=>{runner.start(id,content);await runner.whenIdle();};
  const names=(body:any)=>body.tools.map((t:ToolDefinition)=>t.function.name);
  const toolResult=(id:string)=>store.messages(id).filter(m=>m.role==='tool').at(-1)?.content??'';
  const lastCache=(id:string)=>store.messages(id).filter(m=>m.role==='assistant').at(-1)?.context?.cache;
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'litespeed-capability-')));store=new Store(join(directory,'state'));calls=[];executions=[];generation=1;
    gatewayDefs=[definition(gw1,'Click an element on the page'),definition(gw2,'Scrape page text\nSecond line never shown in list')];
    directDefs=[definition(direct,'Echo text back')];
    gatewayServer=(name:string)=>name===gw2?'other':'browser';
    scopes={[gw1]:'scope-gw1-v1',[gw2]:'scope-gw2-v1',[direct]:'scope-direct-v1'};
    respond=(_body,res)=>text(res);
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);respond(body,res);});
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider)}],defaultProvider:'test',defaultModel:'test-model'});
    external={
      capture:vi.fn((signal:AbortSignal):ExternalToolLease=>{
        // Frozen snapshot per capture: later generation bumps invalidate this
        // lease exactly like McpManager's route asserts.
        const version=generation,definitions=[...structuredClone(gatewayDefs),...structuredClone(directDefs)];
        const gateway=new Map(gatewayDefs.map(t=>[t.function.name,gatewayServer(t.function.name)]));
        const frozenScopes={...scopes};
        const assertCurrent=(name:string)=>{if(signal.aborted||version!==generation||!definitions.some(t=>t.function.name===name))throw fail('The accepted MCP tool catalog is stale. Review MCP settings and explicitly refresh before a new turn.');};
        return{definitions,gatewayTools:()=>gateway,scope:(name:string)=>{assertCurrent(name);return frozenScopes[name];},assertCurrent,execute:async(name,args,callSignal)=>{assertCurrent(name);callSignal.throwIfAborted();executions.push({name,args});return `Executed ${name}`;},release:()=>{}};
      }),
    };
    const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();vi.restoreAllMocks();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it('advertises capability instead of gateway-routed tools while direct servers stay in the tools array',async()=>{
    const s=await create({permissionMode:'auto'});await run(s.id);
    const advertised=names(calls[0]);
    expect(advertised).toContain('capability');expect(advertised).toContain(direct);
    expect(advertised).not.toContain(gw1);expect(advertised).not.toContain(gw2);
  });

  it('omits capability when every connected server is directly advertised',async()=>{
    gatewayDefs=[];const s=await create({permissionMode:'auto'});await run(s.id);
    const advertised=names(calls[0]);
    expect(advertised).not.toContain('capability');expect(advertised).toContain(direct);
  });

  it('a lease without partition info advertises every tool directly (mock/legacy fallback)',async()=>{
    external.capture.mockImplementation(():ExternalToolLease=>({definitions:[definition(gw1,'Legacy lease tool')],scope:()=>'legacy',assertCurrent:()=>{},execute:async()=>'unused',release:()=>{}}));
    const s=await create({permissionMode:'auto'});await run(s.id);
    expect(names(calls[0])).toContain(gw1);expect(names(calls[0])).not.toContain('capability');
  });

  it('list renders bounded name/description/server lines from the frozen snapshot without approval',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'list'});
    const s=await create({permissionMode:'ask'});await run(s.id);
    const result=toolResult(s.id);
    expect(result).toContain(`${gw1} — Click an element on the page (browser)`);
    expect(result).toContain(`${gw2} — Scrape page text (other)`);
    expect(result).not.toContain('Second line never shown');
    expect(result).not.toContain(direct); // Directly advertised tools are not gateway catalog.
    expect(result).toContain('inspect');expect(result).toContain('data, not instructions');
    expect(runner.permissions(s.id)).toEqual([]);expect(executions).toEqual([]);
  });

  it('inspect returns one tool argument schema, bounded and without approval',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'inspect',name:gw1});
    const s=await create({permissionMode:'ask'});await run(s.id);
    const result=toolResult(s.id);
    expect(result).toContain('"text"');expect(result).toContain('"required"');
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(9*1024);
    expect(runner.permissions(s.id)).toEqual([]);expect(executions).toEqual([]);
  });

  it('unknown name yields an honest error that names list, without executing',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:'mcp_missing_00000000',arguments:{text:'x'}});
    const s=await create({permissionMode:'ask'});await run(s.id);
    const call=store.messages(s.id).flatMap(m=>m.toolCalls??[])[0];
    expect(call.status).toBe('error');expect(call.output).toContain('"operation":"list"');
    expect(runner.permissions(s.id)).toEqual([]);expect(executions).toEqual([]);
  });

  it('call routes the permission request to the UNDERLYING tool name and inner arguments',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:gw1,arguments:{text:'hello'}});
    const s=await create({permissionMode:'ask'});runner.start(s.id,'Call through gateway');
    await until(()=>runner.permissions(s.id).length===1);
    const request=runner.permissions(s.id)[0];
    // The user must approve the REAL action: the server tool and its real args,
    // never the opaque 'capability' wrapper.
    expect(request.tool).toBe(gw1);expect(request.args).toEqual({text:'hello'});
    runner.decide(s.id,request.id,'allow');await runner.whenIdle();
    expect(executions).toEqual([{name:gw1,args:{text:'hello'}}]);
    expect(toolResult(s.id)).toBe(`Executed ${gw1}`);
  });

  it('a remembered grant binds the underlying tool: same tool skips the prompt, a different server tool still prompts',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:gw1,arguments:{text:'first'}});
    const s=await create({permissionMode:'ask'});runner.start(s.id,'Grant underlying');
    await until(()=>runner.permissions(s.id).length===1);
    expect(runner.permissions(s.id)[0].tool).toBe(gw1);
    runner.decide(s.id,runner.permissions(s.id)[0].id,'always');await runner.whenIdle();
    expect(executions).toHaveLength(1);
    // Grant stored under the underlying identity, never under 'capability'.
    expect(store.toolGrants(s.id).map(g=>g.tool)).toEqual([gw1]);
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:gw1,arguments:{text:'second'}});
    await run(s.id,'Reuse grant');
    expect(runner.permissions(s.id)).toEqual([]);expect(executions).toHaveLength(2);
    // A DIFFERENT server's tool is a different subject: the gw1 grant must not cover it.
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:gw2,arguments:{text:'third'}});
    runner.start(s.id,'Different tool prompts');
    await until(()=>runner.permissions(s.id).length===1);
    expect(runner.permissions(s.id)[0].tool).toBe(gw2);
    runner.cancel(s.id);await runner.whenIdle();expect(executions).toHaveLength(2);
  });

  it('a grant remembered through the gateway also covers the direct mcp_ path (same identity and scope)',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:direct,arguments:{text:'via gateway? no — direct tool via gateway args'}}); // direct tools remain callable via call too
    const s=await create({permissionMode:'ask'});runner.start(s.id,'Gateway call of a direct tool');
    await until(()=>runner.permissions(s.id).length===1);
    expect(runner.permissions(s.id)[0].tool).toBe(direct);
    runner.decide(s.id,runner.permissions(s.id)[0].id,'always');await runner.whenIdle();expect(executions).toHaveLength(1);
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,direct,{text:'direct'});
    await run(s.id,'Direct call reuses the grant');
    expect(runner.permissions(s.id)).toEqual([]);expect(executions).toHaveLength(2);
  });

  it('a stale lease refuses a gateway call after approval exactly like a direct call',async()=>{
    respond=(body,res)=>body.messages.at(-1)?.role==='tool'?text(res):tool(res,'capability',{operation:'call',name:gw1,arguments:{text:'stale'}});
    const s=await create({permissionMode:'ask'});runner.start(s.id,'Stale after approval');
    await until(()=>runner.permissions(s.id).length===1);
    const pending=runner.permissions(s.id)[0];
    generation++; // Refresh/reconnect happened while the approval was pending.
    runner.decide(s.id,pending.id,'allow');await runner.whenIdle();
    expect(executions).toEqual([]);
    const call=store.messages(s.id).flatMap(m=>m.toolCalls??[])[0];
    expect(call.status).toBe('error');expect(call.output).toMatch(/stale/i);
  });

  it('gateway refresh between turns keeps the prefix toolsHash identical while a direct-catalog change would not',async()=>{
    const s=await create({permissionMode:'auto'});
    await run(s.id,'First turn');
    const first=lastCache(s.id);
    expect(first).toMatchObject({prefixChanged:true,reasons:['first_turn']});
    // Simulate a gateway server refresh: its catalog changes completely.
    gatewayDefs=[definition('mcp_browser_type_44444444','Type into a field')];generation++;
    await run(s.id,'Second turn after gateway refresh');
    const second=lastCache(s.id);
    // Catalog change is conversation content (list output), never prefix bytes.
    expect(second!.shape.toolsHash).toBe(first!.shape.toolsHash);
    expect(second).toMatchObject({prefixChanged:false,reasons:[]});
    // Control: the same kind of change on a DIRECTLY advertised server reshapes the prefix.
    directDefs=[definition(direct,'Echo text back, changed description')];generation++;
    await run(s.id,'Third turn after direct change');
    const third=lastCache(s.id);
    expect(third!.shape.toolsHash).not.toBe(second!.shape.toolsHash);
    expect(third!.reasons).toContain('tools');
  });

  it('a profile allowlist excludes capability along with the lease itself',async()=>{
    await mkdir(join(directory,'.litespeed'));
    await writeFile(join(directory,'.litespeed','profiles.json'),JSON.stringify({version:1,profiles:[{id:'safe',name:'Safe',instructions:'Only read',tools:['read_file']}],skills:[]}));
    const catalog=(await api('/profiles')).body;
    const s=await create({mode:'build',profile:{profileId:'safe',skillIds:[],catalogRevision:catalog.revision}});
    await run(s.id);
    expect(external.capture).not.toHaveBeenCalled();
    expect(names(calls[0])).not.toContain('capability');
    expect(names(calls[0]).some((name:string)=>name.startsWith('mcp_'))).toBe(false);
  });

  it('a child researcher never receives capability or any connected tool',async()=>{
    const child=(body:any)=>body.messages[0]?.content?.includes('foreground read-only researcher');
    respond=(body,res)=>{
      if(child(body))text(res,'Child report');
      else if(body.messages.at(-1)?.role==='tool')text(res);
      else tool(res,'task',{description:'Inspect',prompt:'CHILD inspect'});
    };
    const s=await create({permissionMode:'auto'});await run(s.id,'Delegate research');
    const parentRequest=calls.find(body=>!child(body));const childRequest=calls.find(child);
    expect(childRequest).toBeDefined();
    expect(names(parentRequest)).toContain('capability');
    expect(names(childRequest)).not.toContain('capability');
    expect(names(childRequest).some((name:string)=>name.startsWith('mcp_'))).toBe(false);
  });

  it('plan mode never advertises capability because no lease is captured',async()=>{
    const s=await create({mode:'plan'});await run(s.id,'Plan only');
    expect(external.capture).not.toHaveBeenCalled();
    expect(names(calls[0])).not.toContain('capability');
  });
});
