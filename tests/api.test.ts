import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as any).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean|Promise<boolean>,timeout=5000)=>{const start=Date.now();while(!(await check())){if(Date.now()-start>timeout)throw new Error('Timed out waiting for condition');await new Promise(r=>setTimeout(r,15));}};

describe('local API and agent loop',()=>{
  let dir:string,store:Store,server:Server,provider:Server,base:string,runner:ReturnType<typeof createApp>['runner'];
  let calls:any[],mode:'text'|'tool'|'slow'|'error';
  async function request(path:string,body?:unknown,method?:string){const response=await fetch(base+'/api'+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
  async function session(extra:Record<string,unknown>={}){return(await request('/sessions',extra)).data;}
  beforeEach(async()=>{
    dir=await mkdtemp(join(tmpdir(),'lite-api-'));store=new Store(join(dir,'state'));calls=[];mode='text';
    provider=createServer(async(req,res)=>{
      if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'}]}));return;}
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString());calls.push(data);
      if(mode==='error'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Invalid credential'}}));return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const emit=(delta:any)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`);
      if(mode==='slow'){emit({content:'Starting'});const timer=setTimeout(()=>{emit({content:' finished'});res.end('data: [DONE]\n\n');},10000);res.on('close',()=>clearTimeout(timer));return;}
      if(mode==='tool'&&!data.messages.some((m:any)=>m.role==='tool')){
        emit({tool_calls:[{index:0,id:'call_write',type:'function',function:{name:'write_file',arguments:'{"path":"hello.txt","content":"hello from agent"}'}}]});
      }else{emit({content:'Hello '});emit({content:mode==='tool'?'file saved.':'world.'});}
      res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:mode==='tool'&&!data.messages.some((m:any)=>m.role==='tool')?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:5}})}\n\n`);res.end('data: [DONE]\n\n');
    });
    const providerUrl=await listen(provider);
    store.saveSettings({workspace:dir,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:providerUrl,apiKey:'test-private-secret'}],defaultProvider:'test',defaultModel:'test-model'});
    const created=createApp({store});runner=created.runner;server=createServer(created.app);base=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await until(()=>!store.sessions().some(s=>runner.active(s.id))).catch(()=>{});await close(server);await close(provider);store.close();await rm(dir,{recursive:true,force:true});});
  it('serves health and never exposes configured keys',async()=>{expect((await request('/health')).data.ok).toBe(true);const result=await request('/settings');expect(JSON.stringify(result.data)).not.toContain('test-private-secret');expect(result.data.providers[0].configured).toBe(true);});
  it('blocks cross-origin and DNS-rebinding requests',async()=>{
    const foreign=await fetch(base+'/api/settings',{headers:{Origin:'https://evil.example'}});expect(foreign.status).toBe(403);
    const rebound=await new Promise<number>(resolve=>{httpRequest(base+'/api/settings',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);}).end();});expect(rebound).toBe(403);
    const cross=await fetch(base+'/api/settings',{headers:{'Sec-Fetch-Site':'cross-site'}});expect(cross.status).toBe(403);
  });
  it('validates inputs and returns actionable not-found errors',async()=>{expect((await request('/sessions',{mode:'invalid'})).status).toBe(400);expect((await request('/sessions/missing')).status).toBe(404);expect((await request('/settings',{maxSteps:0},'PATCH')).status).toBe(400);});
  it('streams and persists a real multi-chunk provider response',async()=>{
    const s=await session();expect((await request(`/sessions/${s.id}/messages`,{content:'Hello'})).status).toBe(202);
    await until(()=>!runner.active(s.id));const result=(await request(`/sessions/${s.id}`)).data;
    expect(result.session.status).toBe('idle');expect(result.messages.at(-1).content).toBe('Hello world.');expect(result.messages.at(-1).usage.inputTokens).toBe(12);expect(calls).toHaveLength(1);
    expect(store.events(s.id,0).filter(e=>e.type==='delta').map(e=>e.data.delta).join('')).toBe('Hello world.');
  });
  it('executes an approved write and continues with matching tool results',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Create a file'});
    await until(()=>runner.permissions(s.id).length===1);expect(store.session(s.id).status).toBe('waiting');
    const permission=runner.permissions(s.id)[0];expect(permission.tool).toBe('write_file');
    expect((await request(`/sessions/${s.id}/permissions/${permission.id}`,{decision:'allow'})).status).toBe(200);
    await until(()=>!runner.active(s.id));expect(await readFile(join(dir,'hello.txt'),'utf8')).toBe('hello from agent');
    expect(calls[1].messages.find((m:any)=>m.role==='tool').tool_call_id).toBe('call_write');expect(store.changes(s.id)).toHaveLength(1);
  });
  it('does not execute denied tools and terminates waiting state',async()=>{mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Create file'});await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'deny'});await until(()=>!runner.active(s.id));await expect(readFile(join(dir,'hello.txt'))).rejects.toThrow();expect(store.messages(s.id).find(m=>m.toolCalls)?.toolCalls?.[0].status).toBe('denied');});
  it('cancels while waiting and can prompt again',async()=>{mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Write'});await until(()=>runner.permissions(s.id).length>0);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));expect(runner.permissions(s.id)).toEqual([]);mode='text';await request(`/sessions/${s.id}/messages`,{content:'Hello again'});await until(()=>!runner.active(s.id));expect(store.messages(s.id).at(-1)?.content).toBe('Hello world.');});
  it('cancels an active stream and rejects overlapping runs',async()=>{mode='slow';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Slow'});await until(()=>calls.length===1);expect((await request(`/sessions/${s.id}/messages`,{content:'Conflict'})).status).toBe(409);expect((await request(`/sessions/${s.id}`,undefined,'DELETE')).status).toBe(409);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));expect(store.session(s.id).status).toBe('idle');});
  it('enforces plan mode server-side even if the model calls a write tool',async()=>{mode='tool';const s=await session({mode:'plan'});await request(`/sessions/${s.id}/messages`,{content:'Write'});await until(()=>!runner.active(s.id));await expect(readFile(join(dir,'hello.txt'))).rejects.toThrow();expect(calls[0].tools.some((t:any)=>t.function.name==='write_file')).toBe(false);expect(runner.permissions(s.id)).toEqual([]);});
  it('returns model failures without leaving running sessions',async()=>{mode='error';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Hello'});await until(()=>!runner.active(s.id));expect(store.session(s.id).status).toBe('error');expect(store.messages(s.id).at(-1)?.error).toBeTruthy();});
  it('restores recorded files but refuses external-edit conflicts',async()=>{
    const s=await session();await writeFile(join(dir,'x.txt'),'new');store.recordChange(s.id,{path:'x.txt',before:'old',after:'new'});
    expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(200);expect(await readFile(join(dir,'x.txt'),'utf8')).toBe('old');
    store.recordChange(s.id,{path:'x.txt',before:'old',after:'agent'});await writeFile(join(dir,'x.txt'),'external');expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(409);expect(await readFile(join(dir,'x.txt'),'utf8')).toBe('external');
  });
  it('exports and imports history without executing tools',async()=>{const s=await session();store.saveMessage({id:'m1',sessionId:s.id,role:'user',content:'Saved conversation',createdAt:1});const exported=(await request(`/sessions/${s.id}/export`)).data;const imported=await request('/sessions/import',exported);expect(imported.status).toBe(201);expect(imported.data.id).not.toBe(s.id);expect(store.messages(imported.data.id)[0].content).toBe('Saved conversation');expect(calls).toHaveLength(0);});
});
