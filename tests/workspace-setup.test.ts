import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { WorkspacePreferences } from '../server/workspace-preferences.js';

let directory:string,store:Store;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'litespeed-setup-'));store=new Store(directory);store.saveSettings({providers:[{id:'p',name:'Test',kind:'openai',baseUrl:'http://localhost'}]});});
afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
it('keeps setup completion and permission defaults across clients, ordinary session saves, and restarts',()=>{
  const preferences=new WorkspacePreferences(store);
  preferences.save('/workspace',{providerId:'p',model:'driver',architecture:{kind:'team-fusion',worker:{providerId:'p',model:'worker'}},permissionMode:'auto',setupComplete:true});
  preferences.save('/workspace',{providerId:'p',model:'changed'});
  store.close();store=new Store(directory);
  expect(new WorkspacePreferences(store).get('/workspace')).toMatchObject({providerId:'p',model:'changed',permissionMode:'auto',setupComplete:true});
  expect(new WorkspacePreferences(store).get('/different-workspace')).toEqual({});
});

it('persists the latest model setup after restarting and clears older workspace model arrangements',()=>{
  const preferences=new WorkspacePreferences(store);
  preferences.save('/old',{providerId:'p',model:'haiku',architecture:{kind:'team-fusion',worker:{providerId:'p',model:'old-worker'}},permissionMode:'auto'});
  preferences.save('/new',{providerId:'p',model:'chosen',shunt:{enabled:true,model:{providerId:'p',model:'reader'}}},true);
  store.close();store=new Store(directory);
  expect(new WorkspacePreferences(store).get('/old')).toEqual({providerId:'p',model:'chosen',shunt:{enabled:true,model:{providerId:'p',model:'reader'}},permissionMode:'auto'});
  expect(new WorkspacePreferences(store).get('/unseen')).toEqual({providerId:'p',model:'chosen',shunt:{enabled:true,model:{providerId:'p',model:'reader'}}});
});
