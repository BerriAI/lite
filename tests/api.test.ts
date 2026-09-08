import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsPromises, { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
  let calls:any[],mode:'text'|'tool'|'repeat'|'slow'|'error'|'overflow'|'summary-error'|'summary-slow'|'overflow-always';
  async function request(path:string,body?:unknown,method?:string){const response=await fetch(base+'/api'+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
  async function session(extra:Record<string,unknown>={}){return(await request('/sessions',extra)).data;}
  beforeEach(async()=>{
    dir=await mkdtemp(join(tmpdir(),'lite-api-'));store=new Store(join(dir,'state'));calls=[];mode='text';
    provider=createServer(async(req,res)=>{
      if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model'}]}));return;}
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString());calls.push(data);
      const summarizing=data.messages[0]?.content?.startsWith('Summarize the supplied conversation data');
      if((['overflow','summary-error','summary-slow'].includes(mode)&&calls.length===1)||(mode==='overflow-always'&&!summarizing)){
        res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'context_length_exceeded'}}));return;
      }
      if(mode==='error'||(mode==='summary-error'&&summarizing)){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Invalid credential'}}));return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const emit=(delta:any)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`);
      if(mode==='slow'||(mode==='summary-slow'&&summarizing)){emit({content:'Starting'});const timer=setTimeout(()=>{emit({content:' finished'});res.end('data: [DONE]\n\n');},10000);res.on('close',()=>clearTimeout(timer));return;}
      if(mode==='repeat'||(mode==='tool'&&data.messages.at(-1)?.role!=='tool')){
        emit({tool_calls:[{index:0,id:'call_write',type:'function',function:{name:'write_file',arguments:'{"path":"hello.txt","content":"hello from agent"}'}}]});
      }else{emit({content:'Hello '});emit({content:mode==='tool'?'file saved.':'world.'});}
      res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:mode==='repeat'||(mode==='tool'&&data.messages.at(-1)?.role!=='tool')?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:5}})}\n\n`);res.end('data: [DONE]\n\n');
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
    const s=await session();const accepted=await request(`/sessions/${s.id}/messages`,{content:'Hello'});expect(accepted.status).toBe(202);
    await until(()=>!runner.active(s.id));const result=(await request(`/sessions/${s.id}`)).data;
    expect(accepted.data.messageId).toBe(result.messages[0].id);expect(store.events(s.id,0).some(e=>e.type==='message'&&e.data.role==='user'&&e.data.id===accepted.data.messageId)).toBe(true);
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
  it('remembers approvals across runs and allows explicit revocation',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Write once'});
    await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'always'});await until(()=>!runner.active(s.id));
    expect((await request(`/sessions/${s.id}/tool-grants`)).data.tools).toEqual(['write_file']);
    await request(`/sessions/${s.id}/messages`,{content:'Write again'});await until(()=>!runner.active(s.id));expect(calls).toHaveLength(4);
    await request(`/sessions/${s.id}/tool-grants`,undefined,'DELETE');
    await request(`/sessions/${s.id}/messages`,{content:'Ask again'});await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));
  });
  it('stops identical tool batches before the third execution with matching results',async()=>{
    mode='repeat';const s=await session({permissionMode:'auto'});await request(`/sessions/${s.id}/messages`,{content:'Do the task'});await until(()=>!runner.active(s.id));
    const messages=store.messages(s.id),tools=messages.flatMap(m=>m.toolCalls||[]);
    expect(calls).toHaveLength(3);expect(tools.map(t=>t.status)).toEqual(['completed','completed','denied']);expect(messages.filter(m=>m.role==='tool')).toHaveLength(3);expect(messages.at(-1)?.content).toContain('third batch was not executed');expect(store.session(s.id).status).toBe('idle');
  });
  it('does not execute denied tools and terminates waiting state',async()=>{mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Create file'});await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'deny'});await until(()=>!runner.active(s.id));await expect(readFile(join(dir,'hello.txt'))).rejects.toThrow();expect(store.messages(s.id).find(m=>m.toolCalls)?.toolCalls?.[0].status).toBe('denied');});
  it('cancels while waiting and can prompt again',async()=>{mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Write'});await until(()=>runner.permissions(s.id).length>0);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));expect(runner.permissions(s.id)).toEqual([]);mode='text';await request(`/sessions/${s.id}/messages`,{content:'Hello again'});await until(()=>!runner.active(s.id));expect(store.messages(s.id).at(-1)?.content).toBe('Hello world.');});
  it('cancels an active stream and rejects overlapping runs',async()=>{mode='slow';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Slow'});await until(()=>calls.length===1);expect((await request(`/sessions/${s.id}/messages`,{content:'Conflict'})).status).toBe(409);expect((await request(`/sessions/${s.id}`,undefined,'DELETE')).status).toBe(409);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));expect(store.session(s.id).status).toBe('idle');});
  it('enforces plan mode server-side even if the model calls a write tool',async()=>{mode='tool';const s=await session({mode:'plan'});await request(`/sessions/${s.id}/messages`,{content:'Write'});await until(()=>!runner.active(s.id));await expect(readFile(join(dir,'hello.txt'))).rejects.toThrow();expect(calls[0].tools.some((t:any)=>t.function.name==='write_file')).toBe(false);expect(runner.permissions(s.id)).toEqual([]);});
  it('returns model failures without leaving running sessions',async()=>{mode='error';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Hello'});await until(()=>!runner.active(s.id));expect(store.session(s.id).status).toBe('error');expect(store.messages(s.id).at(-1)?.error).toBeTruthy();});
  function history(id:string){for(let i=0;i<4;i++)store.saveMessage({id:`${id}-${i}`,sessionId:id,role:i%2?'assistant':'user',content:i%2?'Prior answer.':'Earlier requirement.',createdAt:i});}
  it('recovers an explicit context overflow once and preserves the latest user turn',async()=>{
    const s=await session();history(s.id);mode='overflow';await request(`/sessions/${s.id}/messages`,{content:'Keep this latest task exact.'});await until(()=>!runner.active(s.id));
    const messages=store.messages(s.id);expect(calls).toHaveLength(3);expect(messages.map(m=>m.role)).toEqual(['system','user','assistant']);expect(messages[1].content).toBe('Keep this latest task exact.');expect(messages.at(-1)?.content).toBe('Hello world.');
    expect(calls[1].tools).toBeUndefined();expect(JSON.stringify(calls[1])).not.toContain('Keep this latest task exact.');expect(calls[2].messages.some((m:any)=>m.content==='Keep this latest task exact.')).toBe(true);
    const archives=store.sessions('',true);expect(archives).toHaveLength(1);expect(store.messages(archives[0].id).slice(0,4).map(m=>m.content)).toEqual(['Earlier requirement.','Prior answer.','Earlier requirement.','Prior answer.']);expect(store.events(s.id,0).some(e=>e.type==='reset')).toBe(true);
  });
  it('leaves original history intact when context summarization fails',async()=>{
    const s=await session();history(s.id);mode='summary-error';await request(`/sessions/${s.id}/messages`,{content:'Latest task'});await until(()=>!runner.active(s.id));expect(calls).toHaveLength(2);expect(store.messages(s.id)).toHaveLength(6);expect(store.sessions('',true)).toHaveLength(0);expect(store.messages(s.id).at(-1)?.error).toContain('Original history is unchanged');
  });
  it('cancels context summarization without replacing history',async()=>{
    const s=await session();history(s.id);mode='summary-slow';await request(`/sessions/${s.id}/messages`,{content:'Latest task'});await until(()=>calls.length===2);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));expect(store.messages(s.id)).toHaveLength(6);expect(store.session(s.id).status).toBe('idle');expect(store.sessions('',true)).toHaveLength(0);
  });
  it('does not loop context recovery when the retained turn is still too large',async()=>{
    const s=await session();history(s.id);mode='overflow-always';await request(`/sessions/${s.id}/messages`,{content:'Latest task'});await until(()=>!runner.active(s.id));expect(calls).toHaveLength(3);expect(store.session(s.id).status).toBe('error');expect(store.sessions('',true)).toHaveLength(1);
  });
  it('manual compaction archives complete history and keeps the session usable',async()=>{
    const s=await session();history(s.id);expect((await request(`/sessions/${s.id}/compact`,{})).status).toBe(200);expect(store.messages(s.id)).toHaveLength(1);expect(store.messages(s.id)[0].role).toBe('system');expect(store.messages(store.sessions('',true)[0].id)).toHaveLength(4);
    await request(`/sessions/${s.id}/messages`,{content:'Continue'});await until(()=>!runner.active(s.id));expect(store.messages(s.id).at(-1)?.content).toBe('Hello world.');
  });
  it('restores recorded files but refuses external-edit conflicts',async()=>{
    const s=await session();await writeFile(join(dir,'x.txt'),'new');store.recordChange(s.id,{path:'x.txt',before:'old',after:'new'});
    expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(200);expect(await readFile(join(dir,'x.txt'),'utf8')).toBe('old');
    store.recordChange(s.id,{path:'x.txt',before:'old',after:'agent'});await writeFile(join(dir,'x.txt'),'external');expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(409);expect(await readFile(join(dir,'x.txt'),'utf8')).toBe('external');
  });
  it('drains explicitly queued follow-ups in order only after successful completion',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'First task'});await until(()=>runner.permissions(s.id).length===1);
    const permission=runner.permissions(s.id)[0];
    expect((await request(`/sessions/${s.id}/queue`,{content:'Second task'})).status).toBe(202);await request(`/sessions/${s.id}/queue`,{content:'Third task'});
    expect(store.queue(s.id).items.map(i=>i.content)).toEqual(['Second task','Third task']);expect(store.queue(s.id).paused).toBe(false);
    mode='text';await request(`/sessions/${s.id}/permissions/${permission.id}`,{decision:'allow'});await until(()=>!runner.active(s.id));
    expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['First task','Second task','Third task']);expect(store.queue(s.id).items).toHaveLength(0);
  });
  it('cancellation holds queued snapshots until explicit resume',async()=>{
    mode='slow';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Initial'});await until(()=>calls.length===1);
    await writeFile(join(dir,'queued.txt'),'QUEUED_SNAPSHOT');await request(`/sessions/${s.id}/queue`,{content:'Follow-up',attachments:[{name:'queued',path:'queued.txt'}]});await writeFile(join(dir,'queued.txt'),'NEW_DISK_VALUE');
    await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));expect(calls).toHaveLength(1);expect(store.queue(s.id).paused).toBe(true);expect(store.queue(s.id).items[0].attachments[0].content).toBe('QUEUED_SNAPSHOT');
    expect((await request(`/sessions/${s.id}/messages`,{content:'Skip queue'})).status).toBe(409);mode='text';await request(`/sessions/${s.id}/queue/resume`,{});await until(()=>!runner.active(s.id));expect(calls).toHaveLength(2);expect(JSON.stringify(calls[1])).toContain('QUEUED_SNAPSHOT');expect(JSON.stringify(calls[1])).not.toContain('NEW_DISK_VALUE');
  });
  it('pauses remaining queue after provider errors and denied tools',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Initial'});await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/queue`,{content:'Pending'});
    const permission=runner.permissions(s.id)[0];mode='error';await request(`/sessions/${s.id}/permissions/${permission.id}`,{decision:'allow'});await until(()=>!runner.active(s.id));expect(store.queue(s.id).paused).toBe(true);expect(store.queue(s.id).items).toHaveLength(1);expect(store.session(s.id).status).toBe('error');
    mode='tool';await request(`/sessions/${s.id}/queue/resume`,{});await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/queue`,{content:'After denial'});await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'deny'});await until(()=>!runner.active(s.id));expect(store.queue(s.id).paused).toBe(true);expect(store.queue(s.id).items[0].content).toBe('After denial');
  });
  it('idle enqueue requires resume, allows removal and isolates sessions',async()=>{
    const a=await session(),b=await session();const queued=await request(`/sessions/${a.id}/queue`,{content:'Waiting'});expect(queued.data.paused).toBe(true);expect(calls).toHaveLength(0);
    await request(`/sessions/${a.id}/queue`,{content:'Keep'});await request(`/sessions/${a.id}/queue/${queued.data.items[0].id}`,undefined,'DELETE');expect((await request(`/sessions/${a.id}/queue/missing`,undefined,'DELETE')).status).toBe(404);expect(store.queue(b.id).items).toHaveLength(0);
    const [one,two]=await Promise.all([request(`/sessions/${a.id}/queue/resume`,{}),request(`/sessions/${a.id}/queue/resume`,{})]);expect(one.status).toBe(200);expect(two.status).toBe(200);await until(()=>!runner.active(a.id));expect(store.messages(a.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Keep']);
  });
  it('explicit pause survives current success and rejects protected queued attachments',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Initial'});await until(()=>runner.permissions(s.id).length===1);await request(`/sessions/${s.id}/queue`,{content:'Pending'});await request(`/sessions/${s.id}/queue/pause`,{});
    await writeFile(join(dir,'.env'),'PRIVATE');expect((await request(`/sessions/${s.id}/queue`,{content:'Bad',attachments:[{name:'secret',path:'.env'}]})).status).toBeGreaterThanOrEqual(400);
    mode='text';await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'allow'});await until(()=>!runner.active(s.id));expect(store.queue(s.id).items).toHaveLength(1);expect(store.queue(s.id).paused).toBe(true);expect(store.messages(s.id).filter(m=>m.role==='user')).toHaveLength(1);
  });
  it.each([false,true])('keeps explicit Pause until Resume even when the live queue was emptied, removed prior item=%s',async removedPriorItem=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Initial'});
    await until(()=>runner.permissions(s.id).length===1);
    const permission=runner.permissions(s.id)[0];
    if(removedPriorItem)await request(`/sessions/${s.id}/queue`,{content:'Remove before replacement'});
    const paused=await request(`/sessions/${s.id}/queue/pause`,{});expect(paused.data.manualPause).toBe(true);
    if(removedPriorItem){const item=store.queue(s.id).items[0];await request(`/sessions/${s.id}/queue/${item.id}`,undefined,'DELETE');}
    expect(store.queue(s.id).items).toEqual([]);
    const queued=await request(`/sessions/${s.id}/queue`,{content:'Held until explicit resume'});
    expect(queued.data).toMatchObject({paused:true,manualPause:true});
    mode='text';await request(`/sessions/${s.id}/permissions/${permission.id}`,{decision:'allow'});
    await until(()=>!runner.active(s.id));
    expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Initial']);
    expect(store.queue(s.id).items.map(item=>item.content)).toEqual(['Held until explicit resume']);
    expect(store.queue(s.id)).toMatchObject({paused:true,manualPause:true});
    expect(calls).toHaveLength(2);
    const resumed=await request(`/sessions/${s.id}/queue/resume`,{});expect(resumed.status).toBe(200);expect(resumed.data.manualPause).toBe(false);
    await until(()=>!runner.active(s.id));
    expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Initial','Held until explicit resume']);
    expect(store.queue(s.id).items).toEqual([]);expect(calls).toHaveLength(3);
  });
  it('keeps a manual empty-queue hold through cancellation and a later direct run',async()=>{
    mode='slow';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Cancel initial'});
    await until(()=>calls.length===1);await request(`/sessions/${s.id}/queue/pause`,{});
    await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));
    expect(store.queue(s.id)).toMatchObject({items:[],paused:true,manualPause:true});
    mode='tool';await request(`/sessions/${s.id}/messages`,{content:'Later direct run'});
    await until(()=>runner.permissions(s.id).length===1);
    const queue=await request(`/sessions/${s.id}/queue`,{content:'Still explicitly paused'});
    expect(queue.data).toMatchObject({paused:true,manualPause:true});
    mode='text';await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'allow'});
    await until(()=>!runner.active(s.id));expect(store.queue(s.id).items.map(item=>item.content)).toEqual(['Still explicitly paused']);
    expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Cancel initial','Later direct run']);
  });
  it('does not turn automatic cancellation holds into manual pauses on a future direct run',async()=>{
    mode='slow';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Cancel initial'});
    await until(()=>calls.length===1);await request(`/sessions/${s.id}/cancel`,{});await until(()=>!runner.active(s.id));
    expect(store.queue(s.id).manualPause).not.toBe(true);
    mode='tool';await request(`/sessions/${s.id}/messages`,{content:'Later direct run'});
    await until(()=>runner.permissions(s.id).length===1);
    const queue=await request(`/sessions/${s.id}/queue`,{content:'Automatically follow the new successful run'});
    expect(queue.data.paused).toBe(false);
    mode='text';await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'allow'});
    await until(()=>!runner.active(s.id));expect(store.queue(s.id).items).toEqual([]);
    expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Cancel initial','Later direct run','Automatically follow the new successful run']);
  });
  it('cancels pending attachment preparation, reserves mutations and permits a later retry',async()=>{
    const s=await session();history(s.id);const original=store.messages(s.id);
    await writeFile(join(dir,'pending-snapshot.txt'),'PREPARED_ATTACHMENT');
    let release!:()=>void,reached=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const originalOpen=fsPromises.open;
    const open=vi.spyOn(fsPromises,'open').mockImplementation(async(...args)=>{
      if(String(args[0]).endsWith('/pending-snapshot.txt')){reached=true;await gate;}
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    let pending:ReturnType<typeof request>|undefined;
    try {
      pending=request(`/sessions/${s.id}/messages`,{content:'Cancelled before acceptance',attachments:[{name:'pending-snapshot.txt',path:'pending-snapshot.txt'}]});
      await until(()=>reached);
      expect((await request(`/sessions/${s.id}/messages`,{content:'Overlapping send'})).status).toBe(409);
      expect((await request(`/sessions/${s.id}/compact`,{})).status).toBe(409);
      expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(409);
      expect((await request(`/sessions/${s.id}`,undefined,'DELETE')).status).toBe(409);
      expect((await request(`/sessions/${s.id}`,{mode:'plan'},'PATCH')).status).toBe(409);
      expect((await request(`/sessions/${s.id}/queue/resume`,{})).status).toBe(409);
      expect((await request(`/sessions/${s.id}/cancel`,{})).status).toBe(200);
      expect(store.messages(s.id)).toEqual(original);expect(calls).toHaveLength(0);
      release();const cancelled=await pending;expect(cancelled.status).toBe(409);
      expect(store.messages(s.id)).toEqual(original);expect(store.sessions('',true)).toHaveLength(0);
      expect(store.queue(s.id).items).toEqual([]);expect(calls).toHaveLength(0);expect(runner.active(s.id)).toBe(false);
    } finally {
      release();open.mockRestore();syncBuiltinESMExports();await pending?.catch(()=>{});
    }
    const retry=await request(`/sessions/${s.id}/messages`,{content:'Explicit retry after cancellation',attachments:[{name:'pending-snapshot.txt',path:'pending-snapshot.txt'}]});
    expect(retry.status).toBe(202);await until(()=>!runner.active(s.id));
    expect(calls).toHaveLength(1);expect(JSON.stringify(calls)).toContain('PREPARED_ATTACHMENT');
    expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Earlier requirement.','Earlier requirement.','Explicit retry after cancellation']);
  });
  it('rejects a pending queued snapshot cancelled during A even if B starts before the read finishes',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Run A'});
    await until(()=>runner.permissions(s.id).length===1);
    await writeFile(join(dir,'late-queue.txt'),'SNAPSHOT_FROM_A');
    let release!:()=>void,reached=false;
    const gate=new Promise<void>(resolve=>{release=resolve;}),originalOpen=fsPromises.open;
    const open=vi.spyOn(fsPromises,'open').mockImplementation(async(...args)=>{
      if(String(args[0]).endsWith('/late-queue.txt')){reached=true;await gate;}
      return originalOpen(...args);
    });syncBuiltinESMExports();
    let pending:ReturnType<typeof request>|undefined;
    try {
      pending=request(`/sessions/${s.id}/queue`,{content:'Cancelled follow-up from A',attachments:[{name:'late-queue.txt',path:'late-queue.txt'}]});
      await until(()=>reached);expect(store.queue(s.id).items).toEqual([]);
      expect((await request(`/sessions/${s.id}/cancel`,{})).status).toBe(200);await until(()=>!runner.active(s.id));
      expect((await request(`/sessions/${s.id}/messages`,{content:'Run B'})).status).toBe(202);
      await until(()=>runner.permissions(s.id).length===1);
      release();const result=await pending;expect(result.status).toBe(409);
      expect(store.queue(s.id).items).toEqual([]);
      mode='text';await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'allow'});
      await until(()=>!runner.active(s.id));
      expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Run A','Run B']);
      expect(calls).toHaveLength(3);expect(JSON.stringify(calls)).not.toContain('SNAPSHOT_FROM_A');
    } finally {release();open.mockRestore();syncBuiltinESMExports();await pending?.catch(()=>{});}
    const retry=await request(`/sessions/${s.id}/queue`,{content:'Explicit retry of follow-up',attachments:[{name:'late-queue.txt',path:'late-queue.txt'}]});
    expect(retry.status).toBe(202);expect(retry.data.paused).toBe(true);
    expect((await request(`/sessions/${s.id}/queue/resume`,{})).status).toBe(200);await until(()=>!runner.active(s.id));
    expect(calls).toHaveLength(4);expect(JSON.stringify(calls.at(-1))).toContain('SNAPSHOT_FROM_A');
    expect(store.messages(s.id).filter(m=>m.role==='user').at(-1)?.content).toBe('Explicit retry of follow-up');
  });
  it('holds a queued snapshot for review if its original run completes and another run starts during the read',async()=>{
    mode='tool';const s=await session();await request(`/sessions/${s.id}/messages`,{content:'Successful run A'});
    await until(()=>runner.permissions(s.id).length===1);const firstPermission=runner.permissions(s.id)[0];
    await writeFile(join(dir,'changed-run-queue.txt'),'ORIGINAL_RUN_SNAPSHOT');
    let release!:()=>void,reached=false;
    const gate=new Promise<void>(resolve=>{release=resolve;}),originalOpen=fsPromises.open;
    const open=vi.spyOn(fsPromises,'open').mockImplementation(async(...args)=>{
      if(String(args[0]).endsWith('/changed-run-queue.txt')){reached=true;await gate;}
      return originalOpen(...args);
    });syncBuiltinESMExports();
    let pending:ReturnType<typeof request>|undefined;
    try {
      pending=request(`/sessions/${s.id}/queue`,{content:'Late follow-up bound to A',attachments:[{name:'changed-run-queue.txt',path:'changed-run-queue.txt'}]});
      await until(()=>reached);mode='text';await request(`/sessions/${s.id}/permissions/${firstPermission.id}`,{decision:'allow'});
      await until(()=>!runner.active(s.id));mode='tool';
      expect((await request(`/sessions/${s.id}/messages`,{content:'Independent run B'})).status).toBe(202);
      await until(()=>runner.permissions(s.id).length===1);
      release();const result=await pending;expect(result.status).toBe(202);expect(result.data.paused).toBe(true);
      expect(result.data.items[0]).toMatchObject({content:'Late follow-up bound to A',attachments:[{content:'ORIGINAL_RUN_SNAPSHOT'}]});
      mode='text';await request(`/sessions/${s.id}/permissions/${runner.permissions(s.id)[0].id}`,{decision:'allow'});
      await until(()=>!runner.active(s.id));expect(calls).toHaveLength(4);
      expect(store.messages(s.id).filter(m=>m.role==='user').map(m=>m.content)).toEqual(['Successful run A','Independent run B']);
      expect(store.queue(s.id).paused).toBe(true);expect(store.queue(s.id).items).toHaveLength(1);
    } finally {release();open.mockRestore();syncBuiltinESMExports();await pending?.catch(()=>{});}
    await request(`/sessions/${s.id}/queue/resume`,{});await until(()=>!runner.active(s.id));
    expect(calls).toHaveLength(5);expect(store.queue(s.id).items).toEqual([]);
    expect(store.messages(s.id).filter(m=>m.role==='user').at(-1)?.content).toBe('Late follow-up bound to A');
  });
  it('never follows imported or legacy attachment paths on continuation',async()=>{
    await writeFile(join(dir,'private-notes.txt'),'LOCAL_ONLY_SENTINEL');
    const imported=await request('/sessions/import',{session:{title:'Attachments'},messages:[{id:'imported',role:'user',content:'Context',createdAt:1,attachments:[{name:'notes',path:'private-notes.txt'},{name:'snapshot',path:'private-notes.txt',content:'EXPORTED_SNAPSHOT'}]}]});
    const id=imported.data.id;expect(store.messages(id)[0].attachments?.every(a=>!a.path)).toBe(true);
    store.saveMessage({id:'legacy',sessionId:id,role:'user',content:'Legacy context',createdAt:2,attachments:[{name:'legacy',path:'private-notes.txt'}]});
    await request(`/sessions/${id}/messages`,{content:'Continue'});await until(()=>!runner.active(id));
    expect(JSON.stringify(calls)).not.toContain('LOCAL_ONLY_SENTINEL');expect(JSON.stringify(calls)).toContain('EXPORTED_SNAPSHOT');expect(JSON.stringify(calls)).toContain('Reattach this file');
  });
  it('uses attachment snapshots after the selected file changes',async()=>{
    await writeFile(join(dir,'notes.txt'),'SNAPSHOT_ORIGINAL');const s=await session();
    await request(`/sessions/${s.id}/messages`,{content:'Read',attachments:[{name:'notes',path:'notes.txt'}]});await until(()=>!runner.active(s.id));
    await writeFile(join(dir,'notes.txt'),'NEW_UNSELECTED_CONTENT');await request(`/sessions/${s.id}/messages`,{content:'Continue'});await until(()=>!runner.active(s.id));
    expect(JSON.stringify(calls[1])).toContain('SNAPSHOT_ORIGINAL');expect(JSON.stringify(calls[1])).not.toContain('NEW_UNSELECTED_CONTENT');
  });
  it('reads commands safely without exposing protected symlink targets',async()=>{
    await mkdir(join(dir,'.lite','commands'),{recursive:true});await writeFile(join(dir,'.lite','commands','safe.md'),'# Review\nRead the tests.');await writeFile(join(dir,'.env'),'COMMAND_SECRET_SENTINEL');await symlink('../../.env',join(dir,'.lite','commands','unsafe.md'));
    const result=await request('/commands');expect(result.status).toBe(200);expect(result.data.commands.map((c:any)=>c.name)).toEqual(['safe']);expect(JSON.stringify(result)).not.toContain('COMMAND_SECRET_SENTINEL');
  });
  it('refuses undo redirected to a protected file and preserves the snapshot',async()=>{
    const s=await session();await writeFile(join(dir,'.env'),'expected after');await symlink('.env',join(dir,'alias.txt'));store.recordChange(s.id,{path:'alias.txt',before:'ordinary old text',after:'expected after'});
    const result=await request(`/sessions/${s.id}/undo`,{});expect(result.status).toBeGreaterThanOrEqual(400);expect(await readFile(join(dir,'.env'),'utf8')).toBe('expected after');expect(store.changes(s.id)).toHaveLength(1);
  });
  it('reserves session mutations while an exclusive operation awaits I/O',async()=>{
    const s=await session();let release!:()=>void;const work=runner.exclusive(s.id,()=>new Promise<void>(resolve=>{release=resolve;}));
    expect((await request(`/sessions/${s.id}/messages`,{content:'Overlap'})).status).toBe(409);expect((await request(`/sessions/${s.id}/undo`,{})).status).toBe(409);expect((await request(`/sessions/${s.id}`,undefined,'DELETE')).status).toBe(409);expect((await request(`/sessions/${s.id}`,{mode:'plan'},'PATCH')).status).toBe(409);
    release();await work;await expect(runner.exclusive(s.id,async()=>{throw new Error('failed operation');})).rejects.toThrow('failed operation');await request(`/sessions/${s.id}/messages`,{content:'After lock release'});await until(()=>!runner.active(s.id));expect(calls).toHaveLength(1);
  });
  it('exports and imports history without executing tools',async()=>{const s=await session();store.saveMessage({id:'m1',sessionId:s.id,role:'user',content:'Saved conversation',createdAt:1});const exported=(await request(`/sessions/${s.id}/export`)).data;const imported=await request('/sessions/import',exported);expect(imported.status).toBe(201);expect(imported.data.id).not.toBe(s.id);expect(store.messages(imported.data.id)[0].content).toBe('Saved conversation');expect(calls).toHaveLength(0);});
});
