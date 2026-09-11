import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import * as profiles from '../server/profiles.js';
import { estimateRequest } from '../server/budget.js';
import type { ExternalToolLease } from '../server/external.js';
import type { ProfileChoice, Session, ToolDefinition } from '../shared/types.js';

const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const until=async(check:()=>boolean)=>{const deadline=Date.now()+4000;while(!check()){if(Date.now()>deadline)throw new Error('Timed out waiting for profile integration');await new Promise(resolve=>setTimeout(resolve,5));}};
const reply=(res:ServerResponse,content='Done')=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);};
const tool=(res:ServerResponse,name:string,args:unknown)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'profile-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);};

describe('profile Runner and API integration',()=>{
  let directory:string,store:Store,server:Server,providerServer:Server,url:string,runner:ReturnType<typeof createApp>['runner'];
  let calls:any[],respond:(body:any,res:ServerResponse)=>void;
  const external={capture:vi.fn<()=>ExternalToolLease>(),execute:vi.fn()};
  const manifest={version:1,profiles:[
    {id:'review',name:'Reviewer',description:'Review only',instructions:'PINNED_PROFILE: inspect carefully, never invent tests.',tools:['read_file','todo_read'],defaultModel:{providerId:'secondary',model:'profile-model'},defaultMode:'plan',skills:['testing']},
    {id:'writer',name:'Writer',instructions:'PINNED_WRITER',tools:['read_file','write_file','bash','todo_write']},
    {id:'empty',name:'No execution',instructions:'Only converse',tools:[]},
  ],skills:[{id:'testing',name:'Testing',description:'Inspect actual test outcomes'}]};
  const api=async(path:string,data?:unknown,method?:string)=>{const response=await fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
  const catalog=async()=>{const response=await api('/profiles');expect(response.status).toBe(200);return response.body;};
  const choice=async(profileId:string|null='review',skillIds:string[]=[]):Promise<ProfileChoice>=>({profileId,skillIds,catalogRevision:(await catalog()).revision});
  const create=async(profile?:ProfileChoice,extra:Record<string,unknown>={})=>{const response=await api('/sessions',{...extra,...(profile?{profile}:{})});expect(response.status).toBe(201);return response.body as Session;};
  const run=async(id:string)=>{runner.start(id,'Do the requested work');await runner.whenIdle();};
  const restart=async()=>{runner.stopAll();await runner.whenIdle();await close(server);store.close();store=new Store(join(directory,'state'));const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);};
  beforeEach(async()=>{
    directory=await realpath(await mkdtemp(join(tmpdir(),'litespeed-profile-integration-')));calls=[];
    await mkdir(join(directory,'.litespeed','skills','testing'),{recursive:true});await writeFile(join(directory,'.litespeed','profiles.json'),JSON.stringify(manifest));await writeFile(join(directory,'.litespeed','skills','testing','SKILL.md'),'PINNED_SKILL: report exact executed tests.');
    respond=(_body,res)=>reply(res);
    providerServer=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body);respond(body,res);});
    const baseUrl=await listen(providerServer);store=new Store(join(directory,'state'));
    store.saveSettings({workspace:directory,providers:[{id:'primary',name:'Primary',kind:'openai',baseUrl},{id:'secondary',name:'Secondary',kind:'openai',baseUrl}],defaultProvider:'primary',defaultModel:'app-model'});
    external.execute.mockReset().mockResolvedValue('External completed');
    external.capture.mockReset().mockImplementation(()=>({definitions:[{type:'function',function:{name:'mcp_example',description:'External tool',parameters:{type:'object'}}}],scope:()=> 'profile-fixture',assertCurrent:()=>{},execute:external.execute,release:()=>{}}));
    const app=createApp({store,external});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();vi.restoreAllMocks();await close(server);await close(providerServer);store.close();await rm(directory,{recursive:true,force:true});});

  it('catalog and preactivation preview are explicit bounded reads with no session, grants or provider work',async()=>{
    const source=await catalog();expect(source.workspace).toBe(directory);expect(source.profiles[0].instructions).toBeUndefined();expect(source.skills[0].body).toBeUndefined();
    const preview=await api('/profiles/preview',{workspace:directory,choice:{profileId:'review',skillIds:['testing'],catalogRevision:source.revision}});
    expect(preview.status).toBe(200);expect(preview.body.active.tools).toEqual(['read_file','todo_read']);expect(preview.body.pinned.instructions).toContain('PINNED_PROFILE');expect(preview.body.pinned.skills[0].body).toContain('PINNED_SKILL');expect(preview.body.source.status).toBe('current');expect(store.sessions()).toEqual([]);expect(calls).toEqual([]);expect(external.capture).not.toHaveBeenCalled();
  });

  it('new profiles use complete explicit pair then profile defaults then app defaults, with explicit mode precedence',async()=>{
    const review=await choice();const inherited=await create(review);expect(inherited).toMatchObject({providerId:'secondary',model:'profile-model',mode:'plan',permissionMode:'ask',configRevision:0});expect(inherited.profile?.skillIds).toEqual([]);
    const explicit=await create(review,{providerId:'primary',model:'explicit-model',mode:'build'});expect(explicit).toMatchObject({providerId:'primary',model:'explicit-model',mode:'build'});
    const writer=await create(await choice('writer'));expect(writer).toMatchObject({providerId:'primary',model:'app-model',mode:'build'});
    for(const partial of [{providerId:'primary'},{model:'other'}])expect((await api('/sessions',{profile:review,...partial})).status).toBe(400);
    expect(store.sessions()).toHaveLength(3);expect(calls).toEqual([]);
  });

  it('requires fresh catalog revision for every nonempty choice and drops imported activation/provenance',async()=>{
    for(const profile of [{profileId:'review',skillIds:[]},{profileId:null,skillIds:['testing']}])expect((await api('/sessions',{profile})).status).toBe(400);
    const stale=await choice();await writeFile(join(directory,'.litespeed','profiles.json'),JSON.stringify({...manifest,version:1,profiles:manifest.profiles.map(p=>({...p,description:'Changed'}))}));
    expect((await api('/sessions',{profile:stale})).status).toBe(409);expect(store.sessions()).toHaveLength(0);
    const s=await create(await choice());const imported=await api('/sessions/import',{session:{...s,profile:{...s.profile,instructions:'FORGED'},configRevision:44},messages:[]});
    expect(imported.status).toBe(201);expect(imported.body.profile).toBeUndefined();expect(imported.body.configRevision).toBe(0);expect(store.profileSnapshot(imported.body.id)).toBeNull();expect(calls).toEqual([]);
  });

  it('preview and activation reject absent/stale catalog revision without changing profile, session or queue',async()=>{
    const s=await create();runner.enqueue(s.id,'Queued task');const before=store.session(s.id),queue=store.queue(s.id),fresh=await choice();
    const missing={profileId:'review',skillIds:[]};
    for(const selected of [missing,{...fresh,catalogRevision:'0'.repeat(64)}]) {
      const expected='catalogRevision' in selected?409:400;
      expect((await api('/profiles/preview',{workspace:directory,choice:selected})).status).toBe(expected);
      expect((await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:selected})).status).toBe(expected);
      expect(store.session(s.id)).toEqual(before);expect(store.queue(s.id)).toEqual(queue);expect(store.profileSnapshot(s.id)).toBeNull();
    }
    expect(store.sessions()).toHaveLength(1);expect(calls).toEqual([]);
  });

  it('explicit activation preserves current selection, permissions and grants while atomically holding queued work',async()=>{
    const s=await create(undefined,{mode:'build',permissionMode:'auto'});store.grantTool(s.id,'write_file','remembered');runner.enqueue(s.id,'Queued task');const before=store.toolGrants(s.id);
    const applied=await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:await choice()});
    expect(applied.status).toBe(200);expect(applied.body.session).toMatchObject({providerId:'primary',model:'app-model',mode:'build',permissionMode:'auto',configRevision:1});expect(applied.body.queue.paused).toBe(true);expect(applied.body.queue.items).toHaveLength(1);expect(store.toolGrants(s.id)).toEqual(before);
    const defaults=await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:1,choice:await choice(),selection:{providerId:'secondary',model:'profile-model',mode:'plan'}});
    expect(defaults.status).toBe(200);expect(defaults.body.session).toMatchObject({providerId:'secondary',model:'profile-model',mode:'plan',permissionMode:'auto',configRevision:2});expect(calls).toEqual([]);
  });

  it('existing PATCH revisions reject stale tabs and pause queue only for actual configuration changes',async()=>{
    const s=await create();runner.enqueue(s.id,'Queued');store.saveQueue(s.id,{...store.queue(s.id),paused:false});
    const first=await api(`/sessions/${s.id}`,{model:'another',expectedConfigRevision:0},'PATCH');expect(first.status).toBe(200);expect(first.body.configRevision).toBe(1);expect(store.queue(s.id).paused).toBe(true);
    const after=store.session(s.id);expect((await api(`/sessions/${s.id}`,{mode:'plan',expectedConfigRevision:0},'PATCH')).status).toBe(409);expect(store.session(s.id)).toEqual(after);
    expect((await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:await choice()})).status).toBe(409);expect(store.profileSnapshot(s.id)).toBeNull();
    expect((await api(`/sessions/${s.id}`,{title:'Renamed',expectedConfigRevision:1},'PATCH')).body.configRevision).toBe(1);expect((await api(`/sessions/${s.id}`,{model:'legacy-compatible'},'PATCH')).body.configRevision).toBe(2);
  });

  it('missing sources do not alter pinned instructions, and explicit clear works without source files',async()=>{
    const s=await create(await choice('review',['testing']));await rm(join(directory,'.litespeed'),{recursive:true,force:true});
    const detail=await api(`/sessions/${s.id}/profile`);expect(detail.body.source.status).toBe('missing');expect(detail.body.pinned.skills[0].body).toContain('PINNED_SKILL');
    await run(s.id);expect(calls[0].messages[0].content).toContain('PINNED_PROFILE');expect(calls[0].messages[0].content).toContain('PINNED_SKILL');
    await restart();await run(s.id);expect(calls[1].messages[0].content).toContain('PINNED_PROFILE');expect(calls[1].messages[0].content).toContain('PINNED_SKILL');
    const clear=await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:{profileId:null,skillIds:[]}});expect(clear.status).toBe(200);expect(clear.body.session.profile).toBeUndefined();expect((await api(`/sessions/${s.id}/profile`)).body.source.status).toBe('inactive');expect(store.profileSnapshot(s.id)).toBeNull();
  });

  it('pinned instruction framing is below constraints, counted once, and included in actual request estimate',async()=>{
    const s=await create(await choice('review',['testing']));await run(s.id);const sent=calls[0],system=sent.messages[0].content as string;
    expect(system.indexOf('Pinned project profile')).toBeGreaterThan(system.indexOf('Never reveal API keys'));expect(system.match(/PINNED_PROFILE/g)).toHaveLength(1);expect(system.match(/PINNED_SKILL/g)).toHaveLength(1);
    const context=store.messages(s.id).at(-1)!.context!,estimated=estimateRequest({system,messages:sent.messages.slice(1),tools:sent.tools});expect(context.estimatedInputTokens).toBe(estimated.estimatedInputTokens);expect(external.capture).not.toHaveBeenCalled();
  });

  it.each(['write_file','bash','mcp_example','task'])('profile advertisement and dispatch deny malicious omitted %s even with auto and existing grants',async(name)=>{
    const s=await create(await choice(),{providerId:'primary',model:'app-model',mode:'build',permissionMode:'auto'});store.grantTool(s.id,name,'remembered');
    respond=(body,res)=>body.messages.at(-1).role==='tool'?reply(res):tool(res,name,{path:'forbidden.txt',content:'bad',command:'printf bad > forbidden.txt',prompt:'Do it'});
    await run(s.id);expect(calls[0].tools.map((t:ToolDefinition)=>t.function.name)).toEqual(['read_file','todo_read','ask_user']);expect(store.messages(s.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('denied');expect(runner.permissions(s.id)).toEqual([]);expect(store.changes(s.id)).toEqual([]);expect(external.execute).not.toHaveBeenCalled();expect(external.capture).not.toHaveBeenCalled();await expect(readFile(join(directory,'forbidden.txt'))).rejects.toMatchObject({code:'ENOENT'});expect(calls).toHaveLength(2);
  });

  it('Plan intersects allowed mutable tools while skills-only leaves Build tools and MCP available',async()=>{
    const s=await create(await choice('writer'),{mode:'plan'});await run(s.id);expect(calls[0].tools.map((t:ToolDefinition)=>t.function.name)).toEqual(['read_file','ask_user']);
    const skills=await create(await choice(null,['testing']));await run(skills.id);expect(skills.profile?.tools).toBeNull();expect(calls[1].tools.map((t:ToolDefinition)=>t.function.name)).toEqual(expect.arrayContaining(['write_file','bash','mcp_example','ask_user']));expect(external.capture).toHaveBeenCalledOnce();
  });

  it('ask_user remains an explicit interaction with an empty profile allowlist in Plan and auto mode',async()=>{
    const s=await create(await choice('empty'),{mode:'plan',permissionMode:'auto'});respond=(body,res)=>body.messages.at(-1).role==='tool'?reply(res):tool(res,'ask_user',{question:'Which next step?'});
    runner.start(s.id,'Ask me');await until(()=>runner.questions.pending(s.id).length===1);expect(calls[0].tools.map((t:ToolDefinition)=>t.function.name)).toEqual(['ask_user']);expect(runner.permissions(s.id)).toEqual([]);
    const question=runner.questions.pending(s.id)[0];expect((await api(`/sessions/${s.id}/questions/${question.id}/answer`,{kind:'text',text:'Inspect only'})).status).toBe(200);await runner.whenIdle();expect(store.messages(s.id).flatMap(m=>m.toolCalls??[])[0].status).toBe('completed');expect(calls).toHaveLength(2);
  });

  it('cancelled activation ignores late resolver completion and keeps original configuration/snapshot',async()=>{
    const s=await create();const resolved=await profiles.resolveProfileChoice(directory,await choice());let release!:(value:profiles.ResolvedProfile)=>void;
    vi.spyOn(profiles,'resolveProfileChoice').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const pending=api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:resolved.snapshot!.choice});await until(()=>Boolean(release));
    expect((await api(`/sessions/${s.id}/messages`,{content:'Must not start'})).status).toBe(409);expect((await api(`/sessions/${s.id}`,{mode:'plan'},'PATCH')).status).toBe(409);
    let idle=false;const wait=runner.whenIdle().then(()=>{idle=true;});runner.cancel(s.id);await new Promise(resolve=>setTimeout(resolve,10));expect(idle).toBe(false);release(resolved);expect((await pending).status).toBe(409);await wait;
    expect(store.session(s.id)).toMatchObject({configRevision:0,mode:'build'});expect(store.profileSnapshot(s.id)).toBeNull();expect(calls).toEqual([]);
  });

  it('shutdown gates new profile creation and waits for delayed resolution without partial session',async()=>{
    const resolved=await profiles.resolveProfileChoice(directory,await choice());let release!:(value:profiles.ResolvedProfile)=>void;vi.spyOn(profiles,'resolveProfileChoice').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const pending=api('/sessions',{profile:resolved.snapshot!.choice});await until(()=>Boolean(release));runner.stopAll();expect((await api('/sessions',{})).status).toBe(409);let idle=false;const wait=runner.whenIdle().then(()=>{idle=true;});await new Promise(resolve=>setTimeout(resolve,10));expect(idle).toBe(false);release(resolved);expect((await pending).status).toBe(409);await wait;expect(store.sessions()).toEqual([]);expect(calls).toEqual([]);
  });

  it('HTTP-disconnected profile creation cannot commit after a late resolver returns',async()=>{
    const resolved=await profiles.resolveProfileChoice(directory,await choice());let release!:(value:profiles.ResolvedProfile)=>void,observed:AbortSignal|undefined;
    vi.spyOn(profiles,'resolveProfileChoice').mockImplementation((_root,_choice,signal)=>{observed=signal;return new Promise(resolve=>{release=resolve;});});
    const controller=new AbortController();const pending=fetch(url+'/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:resolved.snapshot!.choice}),signal:controller.signal}).catch(error=>error);
    await until(()=>Boolean(release));controller.abort();await pending;await until(()=>Boolean(observed?.aborted));release(resolved);await runner.whenIdle();expect(store.sessions()).toEqual([]);expect(calls).toEqual([]);
  });

  it('activation rejects incomplete turn history until explicit recovery, with no source resolution',async()=>{
    const s=await create(),selected=await choice();runner.history.accept(s.id,{id:'unfinished-user',sessionId:s.id,role:'user',content:'Accepted before crash',createdAt:Date.now()});await restart();
    const resolve=vi.spyOn(profiles,'resolveProfileChoice');const before=store.session(s.id);
    expect((await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:selected})).status).toBe(409);expect(resolve).not.toHaveBeenCalled();expect(store.session(s.id)).toEqual(before);expect(store.profileSnapshot(s.id)).toBeNull();expect(calls).toEqual([]);
  });

  it('profile pins survive fork, archive and undo/redo without reloading source or replaying tools',async()=>{
    const s=await create(await choice('review',['testing'])),pinned=store.profileSnapshot(s.id);store.grantTool(s.id,'read_file','remembered');await run(s.id);await run(s.id);const original=store.messages(s.id),count=calls.length;
    await rm(join(directory,'.litespeed'),{recursive:true,force:true});const fork=await api(`/sessions/${s.id}/fork`,{});expect(fork.status).toBe(201);expect(store.profileSnapshot(fork.body.id)).toEqual(pinned);expect(store.toolGrants(fork.body.id)).toEqual([]);
    const compact=await api(`/sessions/${s.id}/compact`,{});expect(compact.status).toBe(200);expect(calls).toHaveLength(count+1);const archive=store.sessions('',true)[0];expect(store.profileSnapshot(archive.id)).toEqual(pinned);expect(store.toolGrants(archive.id)).toEqual([]);expect(store.messages(archive.id).map(m=>({...m,sessionId:s.id,id:undefined}))).toEqual(original.map(m=>({...m,id:undefined})));
    const after=store.messages(s.id),history=runner.history.state(s.id);expect(history.canUndo).toBe(true);expect((await api(`/sessions/${s.id}/history/undo`,{checkpointId:history.undoId})).status).toBe(200);expect(store.profileSnapshot(s.id)).toEqual(pinned);
    expect((await api(`/sessions/${s.id}/history/redo`,{checkpointId:runner.history.state(s.id).redoId})).status).toBe(200);expect(store.messages(s.id)).toEqual(after);expect(store.profileSnapshot(s.id)).toEqual(pinned);expect(calls).toHaveLength(count+1);
  });

  it('revision is rechecked after async sources resolve, before any profile or queue commit',async()=>{
    const s=await create();runner.enqueue(s.id,'Held');const resolved=await profiles.resolveProfileChoice(directory,await choice());let release!:(value:profiles.ResolvedProfile)=>void;vi.spyOn(profiles,'resolveProfileChoice').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const pending=api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:resolved.snapshot!.choice});await until(()=>Boolean(release));store.updateSession(s.id,{model:'other-tab'});const after=store.session(s.id),queue=store.queue(s.id);release(resolved);
    expect((await pending).status).toBe(409);expect(store.session(s.id)).toEqual(after);expect(store.queue(s.id)).toEqual(queue);expect(store.profileSnapshot(s.id)).toBeNull();expect(calls).toEqual([]);
  });

  it('profile activation transaction failure preserves exact configuration and queue',async()=>{
    const s=await create();runner.enqueue(s.id,'Held');const before=store.session(s.id),queue=store.queue(s.id),selected=await choice();
    store.db.exec("CREATE TRIGGER fail_profile BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'profile SQL failure'); END;");
    try{expect((await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:selected,selection:{mode:'plan'}})).status).toBe(500);}finally{store.db.exec('DROP TRIGGER fail_profile');}
    expect(store.session(s.id)).toEqual(before);expect(store.queue(s.id)).toEqual(queue);expect(store.profileSnapshot(s.id)).toBeNull();expect(calls).toEqual([]);expect(runner.active(s.id)).toBe(false);runner.assertIdle(s.id);
  });

  it('new-session profile snapshot SQL failure leaves neither session nor pinned record',async()=>{
    const selected=await choice();store.db.exec("CREATE TRIGGER fail_profile_create BEFORE INSERT ON session_profiles BEGIN SELECT RAISE(ABORT,'snapshot SQL failure'); END;");
    try{expect((await api('/sessions',{profile:selected})).status).toBe(500);}finally{store.db.exec('DROP TRIGGER fail_profile_create');}
    expect(store.sessions()).toEqual([]);expect(store.db.prepare('SELECT count(*) AS n FROM session_profiles').get()).toMatchObject({n:0});expect(calls).toEqual([]);
  });

  it('postcommit event failure returns authoritative success without reverting profile activation',async()=>{
    const s=await create();vi.spyOn(console,'error').mockImplementation(()=>{});store.db.exec("CREATE TRIGGER fail_profile_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'profile event failure'); END;");
    try{const result=await api(`/sessions/${s.id}/profile`,{expectedConfigRevision:0,choice:await choice()});expect(result.status).toBe(200);expect(result.body.session.configRevision).toBe(1);}finally{store.db.exec('DROP TRIGGER fail_profile_event');}
    expect(store.profileSnapshot(s.id)?.active.profileId).toBe('review');expect(calls).toEqual([]);
  });
});
