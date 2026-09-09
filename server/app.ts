import express, { type Express, type Response } from 'express';
import { z } from 'zod';
import { realpath, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { Runner, type ExternalTools } from './runner.js';
import { Memory } from './memory.js';
import { listModels } from './providers.js';
import { modelCatalog } from './budget.js';
import { readProfileCatalog, resolveProfileChoice, profileSourceStatus, type ProfileSnapshot } from './profiles.js';
import { validateRuleSet } from './permissions.js';
import type { ProfileDetail } from '../shared/profiles.js';
import { listFiles, readFile, readCommand, restoreChanges, searchFiles, gitStatus, resolveWorkspacePath } from './tools.js';
import type { Message, Settings } from '../shared/types.js';

const providerSchema = z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),name:z.string().min(1).max(100),kind:z.enum(['openai','anthropic','codex']),baseUrl:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol)),apiKey:z.string().max(8192).optional(),models:z.array(z.string().max(200)).max(500).optional(),contextWindows:z.record(z.string().min(1).max(250),z.number().int().min(1024).max(10000000)).refine(value=>Object.keys(value).length<=100,'At most 100 model context windows may be configured.').optional()});
const mcpSchema = z.object({command:z.string().max(1000).optional(),args:z.array(z.string().max(4000)).max(100).optional(),env:z.record(z.string(),z.string().max(8192)).optional(),url:z.url().optional(),enabled:z.boolean().optional()}).refine(v=>Boolean(v.command)!==Boolean(v.url),'Specify either a command or URL');
const settingsSchema = z.object({providers:z.array(providerSchema).max(30).refine(p=>new Set(p.map(x=>x.id)).size===p.length,'Provider IDs must be unique').optional(),defaultProvider:z.string().max(64).optional(),defaultModel:z.string().max(250).optional(),workspace:z.string().max(4096).optional(),permissionMode:z.enum(['ask','auto']).optional(),maxSteps:z.number().int().min(1).max(200).optional(),theme:z.enum(['light','dark','system']).optional(),mcpServers:z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),mcpSchema).refine(value=>Object.keys(value).length<=30,'At most 30 MCP servers may be configured.').optional(),permissionRules:z.unknown().optional(),memoryEnabled:z.boolean().optional(),expectedMcpConfigRevision:z.string().min(1).max(128).optional()});
const sessionSchema = z.object({title:z.string().trim().min(1).max(200).optional(),workspace:z.string().max(4096).optional(),providerId:z.string().max(64).optional(),model:z.string().max(250).optional(),mode:z.enum(['build','plan']).optional(),permissionMode:z.enum(['ask','auto']).optional()});
const profileChoiceSchema=z.object({profileId:z.string().min(1).max(64).nullable(),skillIds:z.array(z.string().min(1).max(64)).max(100),catalogRevision:z.string().min(1).max(128).optional()}).strict().refine(choice=>new Set(choice.skillIds).size===choice.skillIds.length,'Skill IDs must be unique.').refine(choice=>(choice.profileId===null&&choice.skillIds.length===0)||Boolean(choice.catalogRevision),'Refresh the profile catalog before choosing profiles or skills.');
const configRevisionSchema=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const profileSelectionSchema=z.object({providerId:z.string().min(1).max(64).optional(),model:z.string().min(1).max(250).optional(),mode:z.enum(['build','plan']).optional()}).strict();
const attachmentSchema = z.object({name:z.string().max(255),path:z.string().max(4096).optional(),content:z.string().max(200000).optional(),mimeType:z.string().max(100).optional(),dataUrl:z.string().max(6000000).regex(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/).optional()});
const inputSchema = z.object({content:z.string().max(200000),attachments:z.array(attachmentSchema).max(10).optional()}).refine(v=>v.content.trim() || v.attachments?.length,'A message or attachment is required');
const queryString = (value:unknown) => typeof value === 'string' ? value : '';
const httpError = (status:number,message:string) => Object.assign(new Error(message),{status});
export interface AuthService {
  start(providerId:string,method:'device'|'browser'):Promise<any>;
  status(loginId:string):any;
  connected(providerId:string):boolean;
  disconnect(providerId:string):any;
}
export interface AppOptions { store?:Store; external?:ExternalTools; auth?:AuthService; }

export function createApp(options:AppOptions = {}) {
  const store=options.store || new Store(),bus=new EventBus(store),runner=new Runner(store,bus,options.external);
  const app:Express=express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const hostname=req.hostname.replace(/^\[|\]$/g,'');
    if(!['localhost','127.0.0.1','::1'].includes(hostname)) return res.status(403).json({error:'Lite only accepts local connections.'});
    const origin=req.get('origin');
    if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'Cross-origin requests are not allowed.'});}catch{return res.status(403).json({error:'Invalid request origin.'});}}
    if(req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'Cross-site requests are not allowed.'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    next();
  });
  app.use('/api/sessions/:id',(req,res,next)=>{if(runner.delegations.isChild(req.params.id))return res.status(req.method==='GET'||req.method==='HEAD'?404:409).json({error:'Research transcripts are read-only and available through their parent task.'});next();});
  app.use('/api',express.json({limit:'12mb'}));
  const mcpConfigRevision=()=>options.external?.configRevision?.()??createHash('sha256').update(JSON.stringify(store.settings().mcpServers,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)).digest('hex');
  const mcpStatus=()=>({servers:options.external?.status?.()??[],configRevision:mcpConfigRevision()});
  const publicSettings=()=>{const s=store.publicSettings();return{...s,mcpConfigRevision:mcpConfigRevision(),providers:s.providers.map(p=>p.kind==='codex'?{...p,configured:options.auth?.connected(p.id)||false}:p)}};
  const workspace=async(value:unknown)=>{const root=await realpath(resolve(queryString(value)||store.settings().workspace));if(!(await stat(root)).isDirectory())throw httpError(400,'Workspace must be a directory.');return root;};
  const checkProvider=(id:string|undefined)=>{if(id&&!store.settings().providers.some(p=>p.id===id))throw httpError(400,'Provider not found. Choose a connected provider.');};
  const requestSignal=(res:Response)=>{const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});return controller.signal;};
  const profileDetail=(snapshot:ProfileSnapshot|null,source:ProfileDetail['source']={status:snapshot?'current':'inactive'},diagnostics:ProfileDetail['diagnostics']=[]):ProfileDetail=>({active:snapshot?.active??null,pinned:snapshot?{instructions:snapshot.instructions,skills:snapshot.skills,sources:snapshot.sources}:null,source,diagnostics});
  const publishConfiguration=(id:string)=>{for(const [type,data]of [['session',store.session(id)],['queue',store.queue(id)]] as const)try{bus.emit(id,type,data);}catch{console.error('Could not publish configuration update. Refresh to inspect saved state.');}};
  app.get('/api/profiles',async(req,res)=>{const signal=requestSignal(res),root=await workspace(req.query.workspace);signal.throwIfAborted();res.json({...await readProfileCatalog(root,signal),workspace:root});});
  app.post('/api/profiles/preview',async(req,res)=>{const input=z.object({workspace:z.string().max(4096).optional(),choice:profileChoiceSchema}).strict().parse(req.body),signal=requestSignal(res),root=await workspace(input.workspace);signal.throwIfAborted();const resolved=await resolveProfileChoice(root,input.choice,signal);res.json(profileDetail(resolved.snapshot));});
  app.get('/api/health',(_req,res)=>res.json({ok:true,version:'0.1.0'}));
  app.get('/api/settings',(_req,res)=>res.json(publicSettings()));
  app.patch('/api/settings',async(req,res)=>{
    const {expectedMcpConfigRevision,...parsed}=settingsSchema.parse(req.body);
    const patch=parsed as Partial<Settings>;
    if(patch.permissionRules!==undefined)patch.permissionRules=validateRuleSet(patch.permissionRules);
    if(patch.workspace)patch.workspace=await workspace(patch.workspace);
    if(patch.mcpServers&&expectedMcpConfigRevision!==undefined&&expectedMcpConfigRevision!==mcpConfigRevision())throw httpError(409,'Saved MCP configuration changed. Review it before saving your changes.');
    const current=store.settings(),providers=patch.providers||current.providers;
    if(!providers.some(p=>p.id===(patch.defaultProvider||current.defaultProvider)))throw httpError(400,'Default provider must be in the provider list.');
    if(patch.mcpServers)for(const[name,config]of Object.entries(patch.mcpServers))if(config.env)for(const[key,value]of Object.entries(config.env))if(value==='••••••••')config.env[key]=current.mcpServers[name]?.env?.[key]||'';
    store.saveSettings(patch);options.external?.status?.();res.json(publicSettings());
  });
  app.get('/api/models',async(req,res)=>{
    const provider=store.settings().providers.find(p=>p.id===(queryString(req.query.providerId)||store.settings().defaultProvider));
    if(!provider)throw httpError(404,'Provider not found.');
    // OAuth account identity is not part of the provider configuration cache key.
    if(provider.kind==='codex')modelCatalog.clear(provider.id);
    try{const models=await listModels(provider,AbortSignal.timeout(30000));if(provider.kind!=='codex')modelCatalog.remember(provider,models);res.json({models});}
    catch(error){res.status(502).json({models:[],error:safeError(error,store)});}
  });
  app.post('/api/providers/test',async(req,res)=>{
    const{providerId}=z.object({providerId:z.string()}).parse(req.body);
    const provider=store.settings().providers.find(p=>p.id===providerId);if(!provider)throw httpError(404,'Provider not found.');
    if(provider.kind==='codex')modelCatalog.clear(provider.id);
    try{const models=await listModels(provider,AbortSignal.timeout(30000));if(provider.kind!=='codex')modelCatalog.remember(provider,models);res.json({ok:true,models:models.length});}catch(error){res.status(502).json({ok:false,error:safeError(error,store)});}
  });
  app.get('/api/sessions',(req,res)=>res.json({sessions:store.sessions(queryString(req.query.q),req.query.archived==='true')}));
  app.post('/api/sessions',async(req,res)=>{
    const {profile,...input}=sessionSchema.extend({profile:profileChoiceSchema.optional()}).parse(req.body||{});
    const nonempty=profile&&(profile.profileId!==null||profile.skillIds.length>0);
    if(nonempty&&(input.providerId!==undefined||input.model!==undefined)&&(!input.providerId?.trim()||!input.model?.trim()))throw httpError(400,'Specify both nonempty providerId and model when overriding profile defaults.');
    const session=await runner.prepareConfiguration(undefined,undefined,async signal=>{
      const root=await workspace(input.workspace);signal.throwIfAborted();
      return {root,resolved:profile?await resolveProfileChoice(root,profile,signal):undefined};
    },({root,resolved})=>{
      const defaults=resolved?.defaults,pair=input.providerId&&input.model?{providerId:input.providerId,model:input.model}:nonempty?defaults?.model:undefined;
      const selection={...input,...pair,mode:input.mode??(nonempty?defaults?.mode:undefined),workspace:root};
      if(selection.mode===undefined)delete selection.mode;
      checkProvider(selection.providerId);
      return store.createSession(selection,resolved);
    },requestSignal(res));
    res.status(201).json(session);
  });
  app.post('/api/sessions/import',async(req,res)=>{
    const imported=z.object({session:sessionSchema,messages:z.array(z.object({id:z.string(),role:z.enum(['user','assistant','tool','system']),content:z.string().max(500000),createdAt:z.number(),providerMetadata:z.record(z.string(),z.unknown()).optional(),reasoning:z.string().max(500000).optional(),toolCallId:z.string().optional(),toolCalls:z.array(z.object({id:z.string(),name:z.string(),args:z.record(z.string(),z.unknown()),status:z.enum(['pending','running','completed','error','denied']),output:z.string().optional()})).optional(),attachments:z.array(attachmentSchema).max(10).optional()})).max(10000)}).parse(req.body);
    // Imports are inert history: no tools execute and no imported path is opened.
    const settings=store.settings();
    const session=store.createSession({...imported.session,title:`${imported.session.title||'Session'} (imported)`.slice(0,200),workspace:settings.workspace,providerId:settings.providers.some(p=>p.id===imported.session.providerId)?imported.session.providerId:settings.defaultProvider,permissionMode:'ask'});
    for(const message of imported.messages)store.saveMessage({...message,attachments:message.attachments?.map(({path: _path,...attachment})=>attachment),id:randomUUID(),sessionId:session.id} as Message);
    res.status(201).json(session);
  });
  app.get('/api/sessions/:id',(req,res)=>res.json({session:store.session(req.params.id),messages:runner.messages(req.params.id),todos:store.todos(req.params.id),permissions:runner.permissions(req.params.id),questions:runner.questions.pending(req.params.id),queue:store.queue(req.params.id),history:runner.history.state(req.params.id),delegations:runner.delegations.list(req.params.id),jobs:runner.jobs.list(req.params.id),lastEventId:store.latestEventId(req.params.id)}));
  app.get('/api/sessions/:id/delegations',(req,res)=>res.json({delegations:runner.delegations.list(req.params.id)}));
  app.get('/api/sessions/:id/delegations/:delegationId',(req,res)=>{
    const detail=runner.delegations.transcript(req.params.id,req.params.delegationId);
    res.json({...detail,todos:store.todos(detail.session.id),permissions:[],questions:[],queue:{items:[],paused:true},history:{hasCheckpoints:true,canUndo:false,canRedo:false}});
  });
  app.post('/api/sessions/:id/delegations/:delegationId/cancel',async(req,res)=>res.json({delegation:await runner.cancelDelegation(req.params.id,req.params.delegationId)}));
  app.get('/api/sessions/:id/delegations/:delegationId/events',(req,res)=>{
    const delegation=runner.delegations.get(req.params.id,req.params.delegationId),id=delegation.childSessionId;
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    const send=(event:any)=>{res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);};
    const cursor=Number(req.get('last-event-id')||req.query.after||0);if(Number.isFinite(cursor)&&cursor>0)for(const event of store.events(id,cursor))send(event);
    const unsubscribe=bus.subscribe(id,send);res.write(': connected\n\n');const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);heartbeat.unref();req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});
  });
  app.get('/api/sessions/:id/profile',async(req,res)=>{
    const id=req.params.id,session=store.session(id),snapshot=store.profileSnapshot(id),signal=requestSignal(res);
    const source=snapshot?await profileSourceStatus(session.workspace,snapshot,signal):{status:'inactive' as const,diagnostics:[]};
    if((store.session(id).configRevision??0)!==(session.configRevision??0))throw httpError(409,'Session configuration changed. Refresh and try again.');
    res.json(profileDetail(snapshot,{status:source.status},source.diagnostics));
  });
  app.post('/api/sessions/:id/profile',async(req,res)=>{
    const id=req.params.id,input=z.object({expectedConfigRevision:configRevisionSchema,choice:profileChoiceSchema,selection:profileSelectionSchema.optional()}).strict().parse(req.body);
    const result=await runner.prepareConfiguration(id,input.expectedConfigRevision,signal=>resolveProfileChoice(store.session(id).workspace,input.choice,signal),resolved=>{
      checkProvider(input.selection?.providerId);
      const session=store.applyProfile(id,input.expectedConfigRevision,resolved,input.selection);
      const queue=store.queue(id);publishConfiguration(id);return{session,queue};
    },requestSignal(res));
    res.json(result);
  });
  app.patch('/api/sessions/:id',(req,res)=>{
    const {expectedConfigRevision,...patch}=sessionSchema.omit({workspace:true}).extend({archived:z.boolean().optional(),expectedConfigRevision:configRevisionSchema.optional()}).parse(req.body);
    const configChange=patch.model!==undefined||patch.providerId!==undefined||patch.mode!==undefined||patch.permissionMode!==undefined;
    if(configChange){runner.assertIdle(req.params.id);runner.history.assertReady(req.params.id);}
    checkProvider(patch.providerId);const session=store.updateSession(req.params.id,patch,expectedConfigRevision);
    if(configChange)publishConfiguration(req.params.id);res.json(session);
  });
  app.delete('/api/sessions/:id',(req,res)=>{runner.assertIdle(req.params.id);runner.jobs.killSession(req.params.id);store.deleteSession(req.params.id);runner.removeFromSearchIndex(req.params.id);res.json({ok:true});});
  const memory=new Memory(store);
  const memoryWorkspace=(value:unknown)=>{const workspace=queryString(value);if(!workspace.trim())throw httpError(400,'workspace is required.');return workspace;};
  app.get('/api/memory',(req,res)=>res.json({facts:memory.list(memoryWorkspace(req.query.workspace))}));
  app.delete('/api/memory/:name',(req,res)=>res.json({removed:memory.forget(memoryWorkspace(req.query.workspace),req.params.name)}));
  app.get('/api/sessions/:id/events',(req,res)=>{
    const id=req.params.id;store.session(id);
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
    const send=(event:any)=>{res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);};
    // Snapshot is fetched separately; only reconnects replay from a cursor.
    const cursor=Number(req.get('last-event-id')||req.query.after||0);
    if(Number.isFinite(cursor)&&cursor>0)for(const event of store.events(id,cursor))send(event);
    const unsubscribe=bus.subscribe(id,send);res.write(': connected\n\n');
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);heartbeat.unref();
    req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});
  });
  const snapshotInput=async(id:string,body:unknown)=>{
    const input=inputSchema.parse(body),session=store.session(id);
    for(const attachment of input.attachments||[])if(attachment.path){const file=await readFile(session.workspace,attachment.path);attachment.content=file.content.slice(0,50000)+(file.truncated?'\n[Attachment truncated]':'');}
    return input;
  };
  app.post('/api/sessions/:id/messages',async(req,res)=>{
    const messageId=await runner.submit(req.params.id,()=>snapshotInput(req.params.id,req.body));
    res.status(202).json({ok:true,messageId});
  });
  app.get('/api/sessions/:id/queue',(req,res)=>res.json(store.queue(req.params.id)));
  app.post('/api/sessions/:id/queue',async(req,res)=>{
    const queue=await runner.submitQueued(req.params.id,()=>snapshotInput(req.params.id,req.body));
    res.status(202).json(queue);
  });
  app.delete('/api/sessions/:id/queue/:queueId',(req,res)=>res.json(runner.removeQueued(req.params.id,req.params.queueId)));
  app.post('/api/sessions/:id/queue/pause',(req,res)=>res.json(runner.pauseQueue(req.params.id)));
  app.post('/api/sessions/:id/queue/resume',(req,res)=>res.json(runner.resumeQueue(req.params.id)));
  app.post('/api/sessions/:id/cancel',(req,res)=>{runner.cancel(req.params.id);res.json({ok:true});});
  app.post('/api/sessions/:id/permissions/:requestId',(req,res)=>{const{decision}=z.object({decision:z.enum(['allow','always','deny'])}).parse(req.body);runner.decide(req.params.id,req.params.requestId,decision);res.json({ok:true});});
  app.get('/api/sessions/:id/questions',(req,res)=>res.json({questions:runner.questions.pending(req.params.id)}));
  app.post('/api/sessions/:id/questions/:questionId/answer',(req,res)=>res.json(runner.questions.answer(req.params.id,req.params.questionId,req.body)));
  app.get('/api/sessions/:id/tool-grants',(req,res)=>res.json({tools:store.toolGrants(req.params.id).map(g=>g.tool)}));
  app.delete('/api/sessions/:id/tool-grants',(req,res)=>{store.clearToolGrants(req.params.id);res.json({ok:true});});
  app.post('/api/sessions/:id/fork',(req,res)=>{runner.assertIdle(req.params.id);const input=z.object({messageId:z.string().optional()}).parse(req.body||{});res.status(201).json(store.fork(req.params.id,input.messageId));});
  app.post('/api/sessions/:id/compact',async(req,res)=>{await runner.compact(req.params.id);res.json({ok:true});});
  app.get('/api/sessions/:id/export',(req,res)=>{const id=req.params.id;res.setHeader('Content-Disposition',`attachment; filename="lite-session-${id}.json"`);res.json({session:store.session(id),messages:store.messages(id),todos:store.todos(id)});});
  app.get('/api/files',async(req,res)=>res.json({entries:await listFiles(await workspace(req.query.workspace),queryString(req.query.path))}));
  app.get('/api/file',async(req,res)=>res.json(await readFile(await workspace(req.query.workspace),queryString(req.query.path))));
  app.get('/api/search',async(req,res)=>res.json({files:await searchFiles(await workspace(req.query.workspace),queryString(req.query.q))}));
  app.get('/api/git',async(req,res)=>res.json(await gitStatus(await workspace(req.query.workspace))));
  app.get('/api/sessions/:id/changes',(req,res)=>{store.session(req.params.id);res.json({changes:store.changes(req.params.id)});});
  app.get('/api/sessions/:id/history',(req,res)=>res.json(runner.history.state(req.params.id)));
  const publishHistory=(id:string)=>{
    bus.emit(id,'reset',{messages:store.messages(id),delegations:runner.delegations.list(id)});
    bus.emit(id,'todos',store.todos(id));bus.emit(id,'queue',store.queue(id));
    bus.emit(id,'session',store.session(id));bus.emit(id,'history',runner.history.state(id));
  };
  for(const direction of ['undo','redo','recover'] as const)app.post(`/api/sessions/:id/history/${direction}`,async(req,res)=>{
    const id=req.params.id;
    const checkpointId=direction==='recover'?undefined:z.object({checkpointId:z.string().min(1).max(100)}).parse(req.body).checkpointId;
    const state=await runner.exclusive(id,async()=>{
      try {return direction==='recover'?await runner.history.recover(id):await runner.history[direction](id,checkpointId!);}
      finally {publishHistory(id);}
    });
    // Undo/redo rewrite the provider-visible history; the next request should
    // attribute its prompt-cache miss to that rather than reporting a clean prefix.
    if(direction!=='recover')runner.notePrefixHistoryChange(id,'history_edited');
    res.json(state);
  });
  app.post('/api/sessions/:id/undo',async(req,res)=>{
    const id=req.params.id;
    await runner.exclusive(id,async()=>{
      runner.history.assertReady(id);
      if(runner.history.hasCheckpoints(id))throw httpError(409,'This session has turn checkpoints. Use Undo last turn instead of session-wide file restoration.');
      const session=store.session(id);
      await restoreChanges(session.workspace,store.changes(id),change=>store.clearChange(id,change.path));
    });
    res.json({ok:true});
  });
  app.get('/api/commands',async(req,res)=>{
    const root=await workspace(req.query.workspace),commands:{name:string,description:string,content:string}[]=[];
    for(const dir of ['.lite/commands','.claude/commands']){
      let names:string[]=[];try{names=await readdir(await resolveWorkspacePath(root,dir));}catch{continue;}
      for(const name of names.filter(n=>n.endsWith('.md')).slice(0,100)){
        try{const content=await readCommand(root,join(dir,name));commands.push({name:name.slice(0,-3),description:content.split('\n').find(l=>l.trim()&&!l.startsWith('---'))?.replace(/^#+\s*/,'').slice(0,120)||name,content});}catch{/* Skip unreadable commands. */}
      }
    }
    res.json({commands});
  });
  app.get('/api/mcp',(_req,res)=>res.json(mcpStatus()));
  for(const action of ['refresh','reconnect'] as const)app.post(`/api/mcp/:name/${action}`,async(req,res)=>{
    const name=z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(req.params.name);
    const input=z.object({expectedRevision:z.string().min(1).max(128),expectedConfigRevision:z.string().min(1).max(128)}).strict().parse(req.body);
    const operation=options.external?.[action];if(!operation)throw httpError(503,'MCP lifecycle operations are unavailable.');
    await runner.externalOperation(signal=>{
      if(input.expectedConfigRevision!==mcpConfigRevision())throw httpError(409,'Saved MCP configuration changed. Review it before connecting tools.');
      return operation.call(options.external,name,input.expectedRevision,signal);
    },requestSignal(res));
    res.json(mcpStatus());
  });
  app.post('/api/auth/codex/start',async(req,res)=>{if(!options.auth)throw httpError(503,'Subscription login is unavailable.');const{providerId,method}=z.object({providerId:z.string(),method:z.enum(['browser','device']).default('device')}).parse(req.body);if(!store.settings().providers.some(p=>p.id===providerId&&p.kind==='codex'))throw httpError(400,'Add a ChatGPT subscription provider first.');res.json(await options.auth.start(providerId,method));});
  app.get('/api/auth/codex/:loginId',(req,res)=>{if(!options.auth)throw httpError(503,'Subscription login is unavailable.');res.json(options.auth.status(req.params.loginId));});
  app.delete('/api/auth/codex/:providerId',async(req,res)=>{if(!options.auth)throw httpError(503,'Subscription login is unavailable.');await options.auth.disconnect(req.params.providerId);res.json({ok:true});});
  app.use('/api',(_req,res)=>res.status(404).json({error:'API route not found.'}));
  app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(res.headersSent)return res.end();
    if(error instanceof z.ZodError)return res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')||'Request'}: ${i.message}`).join('; ')});
    const status=error.status||((error.code==='ENOENT'||error.code==='ENOTDIR')?404:500);
    res.status(status).json({error:safeError(error,store)});
  });
  return{app,store,bus,runner};
}
function safeError(error:unknown,store:Store){let text=error instanceof Error?error.message:'An unexpected error occurred.';for(const p of store.settings().providers)if(p.apiKey)text=text.split(p.apiKey).join('[redacted]');return text.slice(0,2000);}
