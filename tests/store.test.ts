import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';

describe('local persistence',()=>{
  let directory:string,store:Store;
  beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'lite-store-'));store=new Store(directory);});
  afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  it('persists sessions, messages, and todos across restarts',()=>{
    const session=store.createSession({title:'Implement search'});
    store.saveMessage({id:'m1',sessionId:session.id,role:'user',content:'Build it',createdAt:1});
    store.saveTodos(session.id,[{id:'t1',content:'Test',status:'in_progress'}]);
    store.close();store=new Store(directory);
    expect(store.session(session.id).title).toBe('Implement search');expect(store.messages(session.id)).toHaveLength(1);expect(store.todos(session.id)[0].content).toBe('Test');
  });
  it('upserts streamed messages without duplicating or reordering',()=>{
    const s=store.createSession();const m={id:'1',sessionId:s.id,role:'assistant' as const,content:'A',createdAt:1};
    store.saveMessage(m);store.saveMessage({...m,content:'AB'});expect(store.messages(s.id)).toHaveLength(1);expect(store.messages(s.id)[0].content).toBe('AB');
  });
  it('keeps provider secrets private and preserves omitted keys',()=>{
    store.saveSettings({providers:[{id:'p',name:'Gateway',kind:'openai',baseUrl:'https://example.com',apiKey:'private-value'}],defaultProvider:'p'});
    expect(JSON.stringify(store.publicSettings())).not.toContain('private-value');expect(store.publicSettings().providers[0].configured).toBe(true);
    store.saveSettings({providers:[{id:'p',name:'Renamed',kind:'openai',baseUrl:'https://example.com'}]});expect(store.settings().providers[0].apiKey).toBe('private-value');
    store.saveSettings({providers:[{id:'p',name:'Renamed',kind:'openai',baseUrl:'https://example.com',apiKey:''}]});expect(store.publicSettings().providers[0].configured).toBe(false);
  });
  it('recovers sessions interrupted during a response',()=>{const s=store.createSession();store.updateSession(s.id,{status:'running'});store.close();store=new Store(directory);expect(store.session(s.id).status).toBe('idle');});
  it('retains original file snapshots across multiple changes',()=>{const s=store.createSession();store.recordChange(s.id,{path:'a.ts',before:'a',after:'b'});store.recordChange(s.id,{path:'a.ts',before:'b',after:'c'});expect(store.changes(s.id)).toEqual([{path:'a.ts',before:'a',after:'c'}]);});
  it('forks conversation with independent IDs',()=>{const s=store.createSession({title:'Original'});store.saveMessage({id:'old',sessionId:s.id,role:'user',content:'hello',createdAt:1});const f=store.fork(s.id);expect(f.parentId).toBe(s.id);expect(store.messages(f.id)[0].id).not.toBe('old');expect(store.messages(s.id)).toHaveLength(1);});
  it('filters archived sessions and searches case-insensitively',()=>{store.createSession({title:'First'});store.createSession({title:'Second',archived:true});expect(store.sessions('FIRST')).toHaveLength(1);expect(store.sessions()).toHaveLength(1);expect(store.sessions('',true)).toHaveLength(1);});
  it('cascades session deletion and refuses missing sessions',()=>{const s=store.createSession();store.saveMessage({id:'m',sessionId:s.id,role:'user',content:'hi',createdAt:1});store.event({sessionId:s.id,type:'done',data:{}});store.deleteSession(s.id);expect(()=>store.session(s.id)).toThrow('Session not found');expect(store.events(s.id,0)).toEqual([]);});
  it('replays only events after a known cursor',()=>{const s=store.createSession();const e=store.event({sessionId:s.id,type:'delta',data:{delta:'a'}});store.event({sessionId:s.id,type:'done',data:{}});expect(store.events(s.id,e.id!)).toHaveLength(1);});
});
