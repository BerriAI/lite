import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean) => { const deadline=Date.now()+5000; while (!check()) { if (Date.now()>deadline) throw new Error('Timed out waiting for run'); await new Promise(resolve=>setTimeout(resolve,10)); } };

describe('turn history API', () => {
  let directory: string, store: Store, server: Server, provider: Server, base: string, runner: ReturnType<typeof createApp>['runner'];
  let providerCalls: number, behavior: 'write'|'text'|'slow'|'error';
  async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  const detail = async (id: string) => (await request(`/sessions/${id}`)).data;
  const history = async (id: string) => (await request(`/sessions/${id}/history`)).data;
  async function send(id: string, content: string) { expect((await request(`/sessions/${id}/messages`,{content})).status).toBe(202); await until(()=>!runner.active(id)); }
  beforeEach(async () => {
    directory=await mkdtemp(join(tmpdir(),'litespeed-history-api-'));store=new Store(join(directory,'state'));providerCalls=0;behavior='write';
    provider=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());providerCalls++;
      if(behavior==='error'){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":{"code":"invalid_api_key"}}');return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const emit=(delta:unknown)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`);
      if(behavior==='slow'){emit({content:'Partial response'});res.on('close',()=>res.end());return;}
      const content=body.messages.filter((message:any)=>message.role==='user').at(-1)?.content;
      if(behavior==='write'&&body.messages.at(-1)?.role!=='tool')emit({tool_calls:[{index:0,id:`write-${providerCalls}`,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'result.txt',content})}}]});
      else emit({content:behavior==='text'?'Text response.':'Saved and verified.'});
      res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:behavior==='write'&&body.messages.at(-1)?.role!=='tool'?'tool_calls':'stop'}]})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    store.saveSettings({workspace:directory,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider)}],defaultProvider:'test',defaultModel:'test-model'});
    const app=createApp({store});runner=app.runner;server=createServer(app.app);base=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await until(()=>!store.sessions().some(session=>runner.active(session.id)));await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});
  const session = async () => (await request('/sessions',{permissionMode:'auto'})).data;
  async function move(id: string, direction:'undo'|'redo') {
    const state=await history(id);return request(`/sessions/${id}/history/${direction}`,{checkpointId:state[direction+'Id']});
  }

  it('restores two turns of exact files, transcript and aggregate review without another model call',async()=>{
    const s=await session();await writeFile(join(directory,'result.txt'),'original');
    await send(s.id,'first');const first=await detail(s.id);const firstChanges=store.changes(s.id);
    await send(s.id,'second');const second=await detail(s.id);const calls=providerCalls;
    expect((await move(s.id,'undo')).status).toBe(200);expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('first');expect((await detail(s.id)).messages).toEqual(first.messages);expect(store.changes(s.id)).toEqual(firstChanges);
    expect((await move(s.id,'undo')).status).toBe(200);expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('original');expect((await detail(s.id)).messages).toEqual([]);expect(store.changes(s.id)).toEqual([]);
    expect((await move(s.id,'redo')).status).toBe(200);expect((await detail(s.id)).messages).toEqual(first.messages);
    expect((await move(s.id,'redo')).status).toBe(200);expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('second');expect((await detail(s.id)).messages).toEqual(second.messages);expect(providerCalls).toBe(calls);
    expect((await detail(s.id)).history).toEqual(await history(s.id));
  });
  it('validates expected checkpoint IDs and cannot use legacy undo against a turn stack',async()=>{
    const s=await session();await send(s.id,'one');
    expect((await request(`/sessions/${s.id}/history/undo`,{checkpointId:'stale'})).status).toBe(409);
    expect((await request(`/sessions/${s.id}/history/undo`,{})).status).toBe(400);
    expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(409);
    expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('one');
  });
  it('rejects external file conflicts without cutting the transcript or replacing the edit',async()=>{
    const s=await session();await send(s.id,'one');const original=(await detail(s.id)).messages;
    await writeFile(join(directory,'result.txt'),'external work');const result=await move(s.id,'undo');expect(result.status).toBe(409);
    expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('external work');expect((await detail(s.id)).messages).toEqual(original);
  });
  it('pauses queued work through undo and redo and clears redo only when a new turn is accepted',async()=>{
    const s=await session();await send(s.id,'one');await move(s.id,'undo');const redoId=(await history(s.id)).redoId;
    await request(`/sessions/${s.id}/queue`,{content:'queued new branch'});expect((await history(s.id)).redoId).toBe(redoId);
    expect((await request(`/sessions/${s.id}/messages`,{content:'cannot skip queue'})).status).toBe(409);expect((await history(s.id)).redoId).toBe(redoId);
    expect((await move(s.id,'redo')).status).toBe(200);await move(s.id,'undo');expect((await detail(s.id)).queue.paused).toBe(true);
    await request(`/sessions/${s.id}/queue/resume`,{});await until(()=>!runner.active(s.id));expect((await history(s.id)).canRedo).toBe(false);expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('queued new branch');
  });
  it('records text-only, provider-error, and cancelled turns without inventing file changes',async()=>{
    const s=await session();behavior='text';await send(s.id,'first text');const first=(await detail(s.id)).messages;
    behavior='error';await send(s.id,'error turn');expect((await history(s.id)).canUndo).toBe(true);await move(s.id,'undo');expect((await detail(s.id)).messages).toEqual(first);
    behavior='slow';await request(`/sessions/${s.id}/messages`,{content:'cancel turn'});await until(()=>providerCalls===3);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));
    await move(s.id,'undo');expect((await detail(s.id)).messages).toEqual(first);expect(store.changes(s.id)).toEqual([]);
  });
  it('holds history operations during a run and keeps forked/imported histories independent of files',async()=>{
    const s=await session();await send(s.id,'one');const id=(await history(s.id)).undoId;
    behavior='slow';await request(`/sessions/${s.id}/messages`,{content:'waiting'});expect((await request(`/sessions/${s.id}/history/undo`,{checkpointId:id})).status).toBe(409);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));
    const fork=(await request(`/sessions/${s.id}/fork`,{})).data;expect((await history(fork.id)).canUndo).toBe(false);
    const exported=(await request(`/sessions/${s.id}/export`)).data;const imported=(await request('/sessions/import',exported)).data;expect((await history(imported.id)).canUndo).toBe(false);expect(await readFile(join(directory,'result.txt'),'utf8')).toBe('one');
  });
  it('protects redo from manual compaction and publishes reset events for history changes',async()=>{
    const s=await session();await send(s.id,'one');await send(s.id,'two');await move(s.id,'undo');
    expect((await request(`/sessions/${s.id}/compact`,{})).status).toBe(409);
    const resets=store.events(s.id,0).filter(event=>event.type==='reset');expect(resets.at(-1)?.data.messages).toEqual((await detail(s.id)).messages);
  });
});
