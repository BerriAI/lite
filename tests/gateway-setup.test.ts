import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

let directory:string,store:Store,server:Server,gateway:Server,base:string,url:string;
let seen:{url?:string;authorization?:string}[],status:number,empty:boolean,release:(() => void)|undefined,hold:boolean;
const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
async function request(path:string,body?:unknown,method?:string){const response=await fetch(base+'/api'+path,{method:method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}
beforeEach(async()=>{
  vi.stubEnv('LITELLM_BASE_URL','');vi.stubEnv('LITELLM_API_KEY','');
  directory=await mkdtemp(join(tmpdir(),'litespeed-gateway-'));store=new Store(directory);seen=[];status=200;empty=false;hold=false;
  gateway=createServer(async(req,res)=>{seen.push({url:req.url,authorization:req.headers.authorization});if(hold)await new Promise<void>(resolve=>{release=resolve;});res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{data:empty?[]:[{id:'gateway-model'}]}:{error:{message:'invalid key: synthetic-private-key'}}));});
  url=await listen(gateway);server=createServer(createApp({store}).app);base=await listen(server);
});
afterEach(async()=>{release?.();for(const item of [server,gateway])await new Promise<void>(resolve=>{item.closeAllConnections();item.close(()=>resolve());});store.close();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();});
it('starts without an assumed gateway and supports a blank terminal session and unrelated settings',async()=>{
  expect((await request('/settings')).data.providers).toEqual([]);
  expect((await request('/sessions',{})).status).toBe(201);
  expect((await request('/settings',{theme:'dark'},'PATCH')).status).toBe(200);
  expect(seen).toEqual([]);
});
it('connects the entered URL and key, discovers models, and keeps secrets out of public settings',async()=>{
  const result=await request('/providers/connect',{providerId:'litellm',baseUrl:url+'/gateway/v1',apiKey:'synthetic-private-key'});
  expect(result.status).toBe(200);expect(result.data.models.map((m:{id:string})=>m.id)).toEqual(['gateway-model']);
  expect(seen).toEqual([{url:'/gateway/v1/models',authorization:'Bearer synthetic-private-key'}]);
  expect(JSON.stringify(result.data)).not.toContain('synthetic-private-key');expect(store.settings().providers[0].apiKey).toBe('synthetic-private-key');
  store.close();store=new Store(directory);expect(store.settings().providers[0].baseUrl).toBe(url+'/gateway/v1');
});
it('keeps the existing provider and model defaults when authentication fails or no models are available',async()=>{
  store.saveSettings({providers:[{id:'litellm',name:'Saved',kind:'openai',baseUrl:url,apiKey:'saved-key'}],defaultModel:'saved-model'});
  const before=store.settings();status=401;
  const failure=await request('/providers/connect',{providerId:'litellm',baseUrl:url,apiKey:'synthetic-private-key'});
  expect(failure.status).toBe(401);expect(failure.data.error).toContain('API key');expect(JSON.stringify(failure.data)).not.toContain('synthetic-private-key');expect(store.settings()).toEqual(before);
  status=200;empty=true;
  const noModels=await request('/providers/connect',{providerId:'litellm',baseUrl:url,apiKey:'synthetic-private-key'});
  expect(noModels.status).toBe(400);expect(noModels.data.error).toContain('no available models');expect(store.settings()).toEqual(before);
});
it('reuses an omitted saved key only for the same URL, and allows explicitly keyless gateways',async()=>{
  store.saveSettings({providers:[{id:'litellm',name:'Saved',kind:'openai',baseUrl:url,apiKey:'saved-key'}]});
  expect((await request('/providers/connect',{providerId:'litellm',baseUrl:url})).status).toBe(200);
  expect(seen.at(-1)?.authorization).toBe('Bearer saved-key');
  expect((await request('/providers/connect',{providerId:'litellm',baseUrl:url+'/other'})).status).toBe(200);
  expect(seen.at(-1)?.authorization).toBeUndefined();expect(store.settings().providers[0].apiKey).toBe('');
});
it('does not replace a concurrently edited provider',async()=>{
  hold=true;const pending=request('/providers/connect',{providerId:'litellm',baseUrl:url,apiKey:'synthetic-private-key'});
  await vi.waitFor(()=>expect(seen).toHaveLength(1));
  store.saveSettings({providers:[{id:'litellm',name:'Changed elsewhere',kind:'openai',baseUrl:url+'/changed'}]});
  release!();expect((await pending).status).toBe(409);expect(store.settings().providers[0].name).toBe('Changed elsewhere');
});
it('rejects credentials embedded in gateway URLs before any request',async()=>{
  const result=await request('/providers/connect',{providerId:'litellm',baseUrl:url.replace('http://','http://user:secret@')});
  expect(result.status).toBe(400);expect(seen).toEqual([]);expect(store.settings().providers).toEqual([]);
});
it('honors an explicitly supplied gateway environment without persisting its key',()=>{
  vi.stubEnv('LITELLM_BASE_URL',url);vi.stubEnv('LITELLM_API_KEY','env-private-key');
  expect(store.settings().providers[0]).toMatchObject({baseUrl:url,apiKey:'env-private-key'});
  store.saveSettings({theme:'dark'});
  expect(JSON.stringify(store.db.prepare('SELECT data FROM settings').get())).not.toContain('env-private-key');
});

it('remembers the first selected model for a different project without replacing an existing default',async()=>{
  store.saveSettings({providers:[{id:'p',name:'Gateway',kind:'openai',baseUrl:url}],defaultProvider:'p',defaultModel:''});
  const saved=await request('/workspace-preferences',{workspace:directory,providerId:'p',model:'chosen-model',setupComplete:true});expect(saved.status).toBe(200);
  const next=await request('/sessions',{workspace:tmpdir()});expect(next.data.model).toBe('chosen-model');expect(next.data.providerId).toBe('p');
  await request('/workspace-preferences',{workspace:directory,providerId:'p',model:'project-specific',setupComplete:true});expect(store.settings().defaultModel).toBe('chosen-model');
});
