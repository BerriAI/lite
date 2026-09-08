import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { Message, ToolCall } from '../shared/types.js';

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
  it('forks at a parallel tool result without leaving unmatched assistant calls',()=>{
    const s=store.createSession();
    const call=(id:string):ToolCall=>({id,name:'read_file',args:{path:id},status:'completed'});
    const metadata={providerId:'p',model:'m',responseItems:[{type:'reasoning',encrypted_content:'signed-opaque-state'},{type:'function_call',call_id:'a',name:'read_file',arguments:'{}'},{type:'function_call',call_id:'b',name:'read_file',arguments:'{}'}]};
    const messages:Message[]=[
      {id:'u',sessionId:s.id,role:'user',content:'goal',createdAt:1},
      {id:'calls',sessionId:s.id,role:'assistant',content:'',toolCalls:[call('a'),call('b')],providerMetadata:metadata,createdAt:2},
      {id:'result-a',sessionId:s.id,role:'tool',content:'first',toolCallId:'a',createdAt:3},
      {id:'result-b',sessionId:s.id,role:'tool',content:'second',toolCallId:'b',createdAt:4},
      {id:'done',sessionId:s.id,role:'assistant',content:'finished',createdAt:5},
    ];
    messages.forEach(m=>store.saveMessage(m));
    const partial=store.fork(s.id,'result-a');expect(store.messages(partial.id).map(m=>m.content)).toEqual(['goal']);
    const beforeResults=store.fork(s.id,'calls');expect(store.messages(beforeResults.id).map(m=>m.content)).toEqual(['goal']);
    const complete=store.fork(s.id,'result-b'),copied=store.messages(complete.id);
    expect(copied).toHaveLength(4);expect(copied[1].providerMetadata).toEqual(metadata);
    expect(copied[1].toolCalls?.map(t=>t.id)).toEqual(['a','b']);expect(copied.slice(2).map(m=>m.toolCallId)).toEqual(['a','b']);
    copied.forEach((m,index)=>{expect(m.id).not.toBe(messages[index].id);expect(m.sessionId).toBe(complete.id);});
    expect(store.messages(s.id)).toEqual(messages);expect(store.messages(store.fork(s.id,'done').id)).toHaveLength(5);
  });
  it('forks interrupted runs after restart by dropping the entire incomplete suffix',()=>{
    const s=store.createSession();
    const calls:ToolCall[]=['a','b'].map(id=>({id,name:'read_file',args:{path:id},status:id==='a'?'completed':'running'}));
    const messages:Message[]=[{id:'u',sessionId:s.id,role:'user',content:'goal',createdAt:1},
      {id:'a',sessionId:s.id,role:'assistant',content:'',toolCalls:calls,createdAt:2},
      {id:'t',sessionId:s.id,role:'tool',content:'first output',toolCallId:'a',createdAt:3}];
    messages.forEach(m=>store.saveMessage(m));store.updateSession(s.id,{status:'running'});
    store.close();store=new Store(directory);
    const fork=store.fork(s.id);expect(store.messages(fork.id).map(m=>m.content)).toEqual(['goal']);expect(store.messages(s.id)).toEqual(messages);
    store.saveMessage({id:'after',sessionId:s.id,role:'assistant',content:'Run interrupted',createdAt:4});
    expect(store.messages(store.fork(s.id).id).map(m=>m.content)).toEqual(['goal']);
  });
  it('trims overlapping groups together while preserving the previous completed tool turn',()=>{
    const s=store.createSession();const call=(id:string):ToolCall=>({id,name:'read_file',args:{},status:'completed'});
    const add=(id:string,role:Message['role'],extra:Partial<Message>={})=>store.saveMessage({id,sessionId:s.id,role,content:id,createdAt:1,...extra});
    add('u','user');add('complete','assistant',{toolCalls:[call('complete-call')]});add('complete-result','tool',{toolCallId:'complete-call'});
    add('a','assistant',{toolCalls:[call('a-call')]});add('b','assistant',{toolCalls:[call('b-call')]});
    add('a-result','tool',{toolCallId:'a-call'});add('b-result','tool',{toolCallId:'b-call'});
    expect(store.messages(store.fork(s.id,'a-result').id).map(m=>m.content)).toEqual(['u','complete','complete-result']);
    expect(store.messages(store.fork(s.id,'b-result').id)).toHaveLength(7);
  });
  it('preserves an ordinary user boundary and refuses missing fork targets without creating sessions',()=>{
    const s=store.createSession();store.saveMessage({id:'u',sessionId:s.id,role:'user',content:'one',createdAt:1});store.saveMessage({id:'a',sessionId:s.id,role:'assistant',content:'two',createdAt:2});
    expect(store.messages(store.fork(s.id,'u').id).map(m=>m.content)).toEqual(['one']);
    const count=store.sessions().length;expect(()=>store.fork(s.id,'missing')).toThrow('Message not found');expect(store.sessions()).toHaveLength(count);
  });
  it('filters archived sessions and searches case-insensitively',()=>{store.createSession({title:'First'});store.createSession({title:'Second',archived:true});expect(store.sessions('FIRST')).toHaveLength(1);expect(store.sessions()).toHaveLength(1);expect(store.sessions('',true)).toHaveLength(1);});
  it('cascades session deletion and refuses missing sessions',()=>{const s=store.createSession();store.saveMessage({id:'m',sessionId:s.id,role:'user',content:'hi',createdAt:1});store.event({sessionId:s.id,type:'done',data:{}});store.deleteSession(s.id);expect(()=>store.session(s.id)).toThrow('Session not found');expect(store.events(s.id,0)).toEqual([]);});
  it('archives all context atomically and rolls back if replacement fails',()=>{
    const s=store.createSession();const message={id:'original',sessionId:s.id,role:'user' as const,content:'Keep me',createdAt:1};store.saveMessage(message);
    expect(()=>store.compactHistory(s.id,[{...message,id:'bad',sessionId:'missing'}])).toThrow();expect(store.sessions('',true)).toHaveLength(0);expect(store.messages(s.id)).toEqual([message]);
    const archived=store.compactHistory(s.id,[{...message,id:'summary',role:'system',content:'Summary'}]);expect(store.messages(s.id)[0].content).toBe('Summary');expect(store.messages(archived.id)[0].content).toBe('Keep me');expect(archived.archived).toBe(true);
  });
  it('persists tool grants without inheriting them in forks',()=>{
    const s=store.createSession();store.grantTool(s.id,'write_file','workspace-fingerprint');
    store.close();store=new Store(directory);expect(store.toolGrants(s.id)).toEqual([{tool:'write_file',scope:'workspace-fingerprint'}]);
    expect(store.toolGrants(store.fork(s.id).id)).toEqual([]);
    store.clearToolGrants(s.id);expect(store.toolGrants(s.id)).toEqual([]);
    store.grantTool(s.id,'bash','scope');store.deleteSession(s.id);expect(store.db.prepare('SELECT * FROM tool_grants').all()).toEqual([]);
  });
  it('replays only events after a known cursor',()=>{const s=store.createSession();const e=store.event({sessionId:s.id,type:'delta',data:{delta:'a'}});store.event({sessionId:s.id,type:'done',data:{}});expect(store.events(s.id,e.id!)).toHaveLength(1);});
});
