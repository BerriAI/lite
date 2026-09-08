import express, { type Express } from 'express';
import { z } from 'zod';
import { realpath, stat, readFile as fsRead, writeFile, unlink, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { Runner, type ExternalTools } from './runner.js';
import { listModels } from './providers.js';
import { listFiles, readFile, searchFiles, gitStatus, resolveWorkspacePath, assertReadablePath } from './tools.js';
import type { Message, Settings } from '../shared/types.js';

const providerSchema = z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),name:z.string().min(1).max(100),kind:z.enum(['openai','anthropic','codex']),baseUrl:z.url().refine(v=>['http:','https:'].includes(new URL(v).protocol)),apiKey:z.string().max(8192).optional(),models:z.array(z.string().max(200)).max(500).optional()});
const mcpSchema = z.object({command:z.string().max(1000).optional(),args:z.array(z.string().max(4000)).max(100).optional(),env:z.record(z.string(),z.string().max(8192)).optional(),url:z.url().optional(),enabled:z.boolean().optional()}).refine(v=>Boolean(v.command)!==Boolean(v.url),'Specify either a command or URL');
const settingsSchema = z.object({providers:z.array(providerSchema).max(30).refine(p=>new Set(p.map(x=>x.id)).size===p.length,'Provider IDs must be unique').optional(),defaultProvider:z.string().max(64).optional(),defaultModel:z.string().max(250).optional(),workspace:z.string().max(4096).optional(),permissionMode:z.enum(['ask','auto']).optional(),maxSteps:z.number().int().min(1).max(200).optional(),theme:z.enum(['light','dark','system']).optional(),mcpServers:z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),mcpSchema).optional()});
const sessionSchema = z.object({title:z.string().trim().min(1).max(200).optional(),workspace:z.string().max(4096).optional(),providerId:z.string().max(64).optional(),model:z.string().max(250).optional(),mode:z.enum(['build','plan']).optional(),permissionMode:z.enum(['ask','auto']).optional()});
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
export interface AppOptions { store?:Store; external?:ExternalTools & {status?:()=>Promise<any>}; auth?:AuthService; }

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
  app.use('/api',express.json({limit:'12mb'}));
  const publicSettings=()=>{const s=store.publicSettings();return{...s,providers:s.providers.map(p=>p.kind==='codex'?{...p,configured:options.auth?.connected(p.id)||false}:p)}};
  const workspace=async(value:unknown)=>{const root=await realpath(resolve(queryString(value)||store.settings().workspace));if(!(await stat(root)).isDirectory())throw httpError(400,'Workspace must be a directory.');return root;};
  const checkProvider=(id:string|undefined)=>{if(id&&!store.settings().providers.some(p=>p.id===id))throw httpError(400,'Provider not found. Choose a connected provider.');};
  app.get('/api/health',(_req,res)=>res.json({ok:true,version:'0.1.0'}));
  app.get('/api/settings',(_req,res)=>res.json(publicSettings()));
  app.patch('/api/settings',async(req,res)=>{
    const patch=settingsSchema.parse(req.body) as Partial<Settings>;
    if(patch.workspace)patch.workspace=await workspace(patch.workspace);
    const current=store.settings(),providers=patch.providers||current.providers;
    if(!providers.some(p=>p.id===(patch.defaultProvider||current.defaultProvider)))throw httpError(400,'Default provider must be in the provider list.');
    if(patch.mcpServers)for(const[name,config]of Object.entries(patch.mcpServers))if(config.env)for(const[key,value]of Object.entries(config.env))if(value==='••••••••')config.env[key]=current.mcpServers[name]?.env?.[key]||'';
    store.saveSettings(patch);res.json(publicSettings());
  });
  app.get('/api/models',async(req,res)=>{
    const provider=store.settings().providers.find(p=>p.id===(queryString(req.query.providerId)||store.settings().defaultProvider));
    if(!provider)throw httpError(404,'Provider not found.');
    try{res.json({models:await listModels(provider,AbortSignal.timeout(30000))});}
    catch(error){res.status(502).json({models:[],error:safeError(error,store)});}
  });
  app.post('/api/providers/test',async(req,res)=>{
    const{providerId}=z.object({providerId:z.string()}).parse(req.body);
    const provider=store.settings().providers.find(p=>p.id===providerId);if(!provider)throw httpError(404,'Provider not found.');
    try{res.json({ok:true,models:(await listModels(provider,AbortSignal.timeout(30000))).length});}catch(error){res.status(502).json({ok:false,error:safeError(error,store)});}
  });
  app.get('/api/sessions',(req,res)=>res.json({sessions:store.sessions(queryString(req.query.q),req.query.archived==='true')}));
  app.post('/api/sessions',async(req,res)=>{const input=sessionSchema.parse(req.body||{});checkProvider(input.providerId);res.status(201).json(store.createSession({...input,workspace:await workspace(input.workspace)}));});
  app.post('/api/sessions/import',async(req,res)=>{
    const imported=z.object({session:sessionSchema,messages:z.array(z.object({id:z.string(),role:z.enum(['user','assistant','tool','system']),content:z.string().max(500000),createdAt:z.number(),providerMetadata:z.record(z.string(),z.unknown()).optional(),reasoning:z.string().max(500000).optional(),toolCallId:z.string().optional(),toolCalls:z.array(z.object({id:z.string(),name:z.string(),args:z.record(z.string(),z.unknown()),status:z.enum(['pending','running','completed','error','denied']),output:z.string().optional()})).optional(),attachments:z.array(attachmentSchema).max(10).optional()})).max(10000)}).parse(req.body);
    // Imports are inert history: no tools execute and no imported path is opened.
    const settings=store.settings();
    const session=store.createSession({...imported.session,title:`${imported.session.title||'Session'} (imported)`.slice(0,200),workspace:settings.workspace,providerId:settings.providers.some(p=>p.id===imported.session.providerId)?imported.session.providerId:settings.defaultProvider,permissionMode:'ask'});
    for(const message of imported.messages)store.saveMessage({...message,id:randomUUID(),sessionId:session.id} as Message);
    res.status(201).json(session);
  });
  app.get('/api/sessions/:id',(req,res)=>res.json({session:store.session(req.params.id),messages:store.messages(req.params.id),todos:store.todos(req.params.id),permissions:runner.permissions(req.params.id),lastEventId:store.latestEventId(req.params.id)}));
  app.patch('/api/sessions/:id',(req,res)=>{
    const patch=sessionSchema.omit({workspace:true}).extend({archived:z.boolean().optional()}).parse(req.body);
    if(patch.model||patch.providerId||patch.mode||patch.permissionMode)runner.assertIdle(req.params.id);
    checkProvider(patch.providerId);res.json(store.updateSession(req.params.id,patch));
  });
  app.delete('/api/sessions/:id',(req,res)=>{runner.assertIdle(req.params.id);store.deleteSession(req.params.id);res.json({ok:true});});
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
  app.post('/api/sessions/:id/messages',async(req,res)=>{
    const input=inputSchema.parse(req.body);const session=store.session(req.params.id);
    for(const attachment of input.attachments||[])if(attachment.path){await assertReadablePath(session.workspace,attachment.path);const file=await readFile(session.workspace,attachment.path);attachment.content=file.content.slice(0,50000)+(file.truncated?'\n[Attachment truncated]':'');}
    runner.start(req.params.id,input.content,input.attachments);res.status(202).json({ok:true});
  });
  app.post('/api/sessions/:id/cancel',(req,res)=>{runner.cancel(req.params.id);res.json({ok:true});});
  app.post('/api/sessions/:id/permissions/:requestId',(req,res)=>{const{decision}=z.object({decision:z.enum(['allow','always','deny'])}).parse(req.body);runner.decide(req.params.id,req.params.requestId,decision);res.json({ok:true});});
  app.post('/api/sessions/:id/fork',(req,res)=>{runner.assertIdle(req.params.id);const input=z.object({messageId:z.string().optional()}).parse(req.body||{});res.status(201).json(store.fork(req.params.id,input.messageId));});
  app.post('/api/sessions/:id/compact',async(req,res)=>{await runner.compact(req.params.id);res.json({ok:true});});
  app.get('/api/sessions/:id/export',(req,res)=>{const id=req.params.id;res.setHeader('Content-Disposition',`attachment; filename="lite-session-${id}.json"`);res.json({session:store.session(id),messages:store.messages(id),todos:store.todos(id)});});
  app.get('/api/files',async(req,res)=>res.json({entries:await listFiles(await workspace(req.query.workspace),queryString(req.query.path))}));
  app.get('/api/file',async(req,res)=>res.json(await readFile(await workspace(req.query.workspace),queryString(req.query.path))));
  app.get('/api/search',async(req,res)=>res.json({files:await searchFiles(await workspace(req.query.workspace),queryString(req.query.q))}));
  app.get('/api/git',async(req,res)=>res.json(await gitStatus(await workspace(req.query.workspace))));
  app.get('/api/sessions/:id/changes',(req,res)=>{store.session(req.params.id);res.json({changes:store.changes(req.params.id)});});
  app.post('/api/sessions/:id/undo',async(req,res)=>{
    const id=req.params.id;runner.assertIdle(id);const session=store.session(id),changes=store.changes(id);
    const targets: {path:string,before:string|null}[]=[];
    for(const change of changes){
      const path=await resolveWorkspacePath(session.workspace,change.path,{allowMissing:true});let current:string|null=null;
      try{current=await fsRead(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(current!==change.after)throw httpError(409,`${change.path} was changed outside this session. No files were restored.`);
      targets.push({path,before:change.before});
    }
    for(const target of targets){if(target.before===null){await unlink(target.path).catch(error=>{if(error.code!=='ENOENT')throw error;});}else await writeFile(target.path,target.before,'utf8');}
    store.clearChanges(id);res.json({ok:true});
  });
  app.get('/api/commands',async(req,res)=>{
    const root=await workspace(req.query.workspace),commands:{name:string,description:string,content:string}[]=[];
    for(const dir of ['.lite/commands','.claude/commands']){
      let names:string[]=[];try{names=await readdir(await resolveWorkspacePath(root,dir));}catch{continue;}
      for(const name of names.filter(n=>n.endsWith('.md')).slice(0,100)){
        try{const content=(await fsRead(await resolveWorkspacePath(root,join(dir,name)),'utf8')).slice(0,30000);commands.push({name:name.slice(0,-3),description:content.split('\n').find(l=>l.trim()&&!l.startsWith('---'))?.replace(/^#+\s*/,'').slice(0,120)||name,content});}catch{/* Skip unreadable commands. */}
      }
    }
    res.json({commands});
  });
  app.get('/api/mcp',async(_req,res)=>res.json({servers:await options.external?.status?.()||[]}));
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
