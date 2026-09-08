import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { Attachment, Message, QueuedMessage, ToolCall } from '../shared/types.js';

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
  describe('queued messages',()=>{
    const acceptedMessage=(item:QueuedMessage,id=`accepted-${item.id}`):Message=>({
      id,sessionId:item.sessionId,role:'user',content:item.content,
      attachments:structuredClone(item.attachments),createdAt:Date.now(),
    });

    it('starts empty and paused, and snapshots queued content and attachments durably',()=>{
      const s=store.createSession();expect(store.queue(s.id)).toEqual({items:[],paused:true});
      const attachments:Attachment[]=[
        {name:'notes.txt',path:'notes.txt',content:'original text',mimeType:'text/plain'},
        {name:'image.png',dataUrl:'data:image/png;base64,aGVsbG8=',mimeType:'image/png'},
      ];
      const content='Draft with Unicode: 世界';
      const added=store.enqueue(s.id,content,attachments,false),snapshot=structuredClone(added);
      expect(snapshot).toMatchObject({paused:true,reason:expect.any(String),items:[{
        id:expect.any(String),sessionId:s.id,content,createdAt:expect.any(Number),attachments,
      }]});
      attachments[0].content='changed externally';attachments.push({name:'later.txt',content:'not queued'});
      added.items[0].content='mutated returned state';added.items[0].attachments[1].dataUrl='changed';
      const read=store.queue(s.id);expect(read).toEqual(snapshot);
      read.items.length=0;read.paused=false;expect(store.queue(s.id)).toEqual(snapshot);
      store.close();store=new Store(directory);
      expect(store.queue(s.id)).toMatchObject({items:snapshot.items,paused:true,reason:expect.stringMatching(/restart/i)});
    });

    it('only chooses the initial pause state for an empty queue and preserves explicit pauses',()=>{
      const s=store.createSession();
      const first=store.enqueue(s.id,'first',[],true);expect(first.paused).toBe(false);expect(first.reason).toBeUndefined();
      expect(store.enqueue(s.id,'second',[],false).paused).toBe(false);
      const paused=store.saveQueue(s.id,{...store.queue(s.id),paused:true,reason:'Stopped by user'});
      paused.reason='caller mutation';paused.items[0].content='caller mutation';
      expect(store.enqueue(s.id,'third',[],true)).toMatchObject({paused:true,reason:'Stopped by user',items:[
        {content:'first'},{content:'second'},{content:'third'},
      ]});
      const resumed=store.saveQueue(s.id,{...store.queue(s.id),paused:false});
      expect(store.queue(s.id)).toEqual(resumed);expect(resumed.paused).toBe(false);
    });

    it.each([false,true])('preserves manual pause on an empty queue across restart, removed prior item=%s',removedPriorItem=>{
      const s=store.createSession();
      if(removedPriorItem)store.enqueue(s.id,'remove before refilling',[],true);
      store.saveQueue(s.id,{...store.queue(s.id),paused:true,manualPause:true,reason:'Paused by user'});
      for(const item of store.queue(s.id).items)store.removeQueued(s.id,item.id);
      store.close();store=new Store(directory);
      expect(store.queue(s.id)).toEqual({items:[],paused:true,manualPause:true,reason:'Paused by user'});
      const queued=store.enqueue(s.id,'must wait for resume',[],true);
      expect(queued).toMatchObject({paused:true,manualPause:true,reason:'Paused by user'});
      expect(()=>store.acceptQueued(s.id,queued.items[0].id,acceptedMessage(queued.items[0]))).toThrow(expect.objectContaining({status:409}));
      store.saveQueue(s.id,{...queued,paused:false,manualPause:false,reason:undefined});
      store.acceptQueued(s.id,queued.items[0].id,acceptedMessage(queued.items[0]));
      const next=store.enqueue(s.id,'normal follow-up after resume',[],true);
      expect(next.paused).toBe(false);expect(next.manualPause).toBe(false);expect(next.reason).toBeUndefined();
    });

    it('preserves manual pause through restart and removal of the last held item',()=>{
      const s=store.createSession(),queue=store.enqueue(s.id,'held',[],true);
      store.saveQueue(s.id,{...queue,paused:true,manualPause:true,reason:'Paused by user'});
      store.close();store=new Store(directory);
      expect(store.queue(s.id)).toMatchObject({paused:true,manualPause:true,reason:expect.stringMatching(/restart/i)});
      store.removeQueued(s.id,queue.items[0].id);
      expect(store.enqueue(s.id,'replacement',[],true)).toMatchObject({paused:true,manualPause:true});
    });

    it.each([false,true])('pauses persisted items on restart, including archived=%s',archived=>{
      const s=store.createSession({archived});
      const queue=store.enqueue(s.id,'first',[],true);store.enqueue(s.id,'second',[],true);
      const items=store.queue(s.id).items;store.updateSession(s.id,{status:'waiting'});
      store.close();store=new Store(directory);
      expect(store.session(s.id).status).toBe('idle');
      expect(store.queue(s.id)).toEqual({items,paused:true,reason:expect.stringMatching(/restart/i)});
      expect(()=>store.acceptQueued(s.id,queue.items[0].id,acceptedMessage(queue.items[0]))).toThrow(expect.objectContaining({status:409}));
      expect(store.messages(s.id)).toEqual([]);expect(store.queue(s.id).items).toEqual(items);
      store.saveQueue(s.id,{...store.queue(s.id),paused:false});
      store.acceptQueued(s.id,items[0].id,acceptedMessage(items[0]));
      expect(store.queue(s.id).items).toEqual(items.slice(1));
    });

    it('accepts FIFO exactly once and persists message insertion and queue removal together',()=>{
      const s=store.createSession();
      store.enqueue(s.id,'first',[{name:'draft.txt',content:'snapshot'}],true);
      const queued=store.enqueue(s.id,'second',[],true),[first,second]=queued.items;
      expect(first.id).not.toBe(second.id);
      expect(()=>store.acceptQueued(s.id,second.id,acceptedMessage(second))).toThrow(expect.objectContaining({status:409}));
      expect(store.queue(s.id)).toEqual(queued);expect(store.messages(s.id)).toEqual([]);
      const firstMessage=acceptedMessage(first);store.acceptQueued(s.id,first.id,firstMessage);
      expect(store.messages(s.id)).toEqual([firstMessage]);expect(store.queue(s.id).items).toEqual([second]);
      expect(()=>store.acceptQueued(s.id,first.id,acceptedMessage(first,'different-message-id'))).toThrow(expect.objectContaining({status:409}));
      expect(store.messages(s.id)).toEqual([firstMessage]);expect(store.queue(s.id).items).toEqual([second]);
      const secondMessage=acceptedMessage(second);store.acceptQueued(s.id,second.id,secondMessage);
      expect(store.messages(s.id)).toEqual([firstMessage,secondMessage]);expect(store.queue(s.id).items).toEqual([]);
      expect(()=>store.acceptQueued(s.id,second.id,secondMessage)).toThrow(expect.objectContaining({status:409}));
      store.close();store=new Store(directory);
      expect(store.messages(s.id)).toEqual([firstMessage,secondMessage]);expect(store.queue(s.id).items).toEqual([]);
      expect(()=>store.acceptQueued(s.id,first.id,firstMessage)).toThrow(expect.objectContaining({status:409}));
      expect(store.messages(s.id)).toHaveLength(2);
    });

    it('rolls back an inserted message if saving the remaining queue fails',()=>{
      const s=store.createSession();const existing:Message={id:'existing',sessionId:s.id,role:'assistant',content:'Previous turn',createdAt:1};
      store.saveMessage(existing);store.enqueue(s.id,'first',[],true);
      const queue=store.enqueue(s.id,'second',[],true),message=acceptedMessage(queue.items[0]);
      store.db.exec("CREATE TRIGGER reject_queue_update BEFORE UPDATE ON queues BEGIN SELECT RAISE(ABORT, 'queue write failed'); END;");
      try {
        expect(()=>store.acceptQueued(s.id,queue.items[0].id,message)).toThrow('queue write failed');
        expect(store.queue(s.id)).toEqual(queue);expect(store.messages(s.id)).toEqual([existing]);
      } finally { store.db.exec('DROP TRIGGER reject_queue_update'); }
      // A failed acceptance must also close its transaction so the same item remains retryable.
      store.acceptQueued(s.id,queue.items[0].id,message);
      expect(store.messages(s.id)).toEqual([existing,message]);expect(store.queue(s.id).items).toEqual(queue.items.slice(1));
    });

    it('leaves the queue unchanged and releases the transaction if inserting the message fails',()=>{
      const s=store.createSession(),queue=store.enqueue(s.id,'draft',[],true),message=acceptedMessage(queue.items[0]);
      store.db.exec("CREATE TRIGGER reject_message_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message write failed'); END;");
      try {
        expect(()=>store.acceptQueued(s.id,queue.items[0].id,message)).toThrow('message write failed');
        expect(store.messages(s.id)).toEqual([]);expect(store.queue(s.id)).toEqual(queue);
      } finally { store.db.exec('DROP TRIGGER reject_message_insert'); }
      store.acceptQueued(s.id,queue.items[0].id,message);
      expect(store.messages(s.id)).toEqual([message]);expect(store.queue(s.id).items).toEqual([]);
    });

    it.each([
      {name:'a non-user role',patch:{role:'assistant' as const}},
      {name:'different text',patch:{content:'changed'}},
      {name:'different attachment contents',patch:{attachments:[{name:'draft.txt',content:'changed'}]}},
      {name:'missing attachments',patch:{attachments:undefined}},
    ])('rejects accepting $name without consuming the draft',({patch})=>{
      const s=store.createSession(),queue=store.enqueue(s.id,'draft',[{name:'draft.txt',content:'original'}],true);
      const item=queue.items[0],message=acceptedMessage(item);
      expect(()=>store.acceptQueued(s.id,item.id,{...message,...patch})).toThrow(expect.objectContaining({status:409}));
      expect(store.queue(s.id)).toEqual(queue);expect(store.messages(s.id)).toEqual([]);
      store.acceptQueued(s.id,item.id,message);expect(store.messages(s.id)).toEqual([message]);
    });

    it('rejects accepting into another existing session',()=>{
      const source=store.createSession(),other=store.createSession();
      const queue=store.enqueue(source.id,'draft',[],true),item=queue.items[0],message=acceptedMessage(item);
      expect(()=>store.acceptQueued(source.id,item.id,{...message,sessionId:other.id})).toThrow(expect.objectContaining({status:409}));
      expect(store.queue(source.id)).toEqual(queue);expect(store.messages(source.id)).toEqual([]);expect(store.messages(other.id)).toEqual([]);
      store.acceptQueued(source.id,item.id,message);expect(store.messages(source.id)).toEqual([message]);
    });

    it.each([false,true])('rejects reusing a persisted message ID from another session=%s',anotherSession=>{
      const source=store.createSession(),destination=anotherSession?store.createSession():source;
      const existing:Message={id:'already-saved',sessionId:destination.id,role:'user',content:'Keep this',createdAt:1};store.saveMessage(existing);
      const queue=store.enqueue(source.id,'draft',[],true),item=queue.items[0];
      expect(()=>store.acceptQueued(source.id,item.id,acceptedMessage(item,existing.id))).toThrow(expect.objectContaining({status:409}));
      expect(store.messages(destination.id)).toEqual([existing]);expect(store.queue(source.id)).toEqual(queue);
      const fresh=acceptedMessage(item);store.acceptQueued(source.id,item.id,fresh);
      expect(store.messages(source.id)).toEqual(anotherSession?[fresh]:[existing,fresh]);
      if(anotherSession)expect(store.messages(destination.id)).toEqual([existing]);
    });

    it('removes any queued item without reordering the rest or changing pause state',()=>{
      const s=store.createSession();store.enqueue(s.id,'first',[],false);store.enqueue(s.id,'middle',[],true);
      const queue=store.enqueue(s.id,'last',[],true),[first,middle,last]=queue.items;
      expect(store.removeQueued(s.id,middle.id)).toEqual({...queue,items:[first,last]});
      expect(()=>store.removeQueued(s.id,middle.id)).toThrow(expect.objectContaining({status:404}));
      expect(store.queue(s.id)).toEqual({...queue,items:[first,last]});
      store.removeQueued(s.id,first.id);expect(store.queue(s.id).items).toEqual([last]);
      store.removeQueued(s.id,last.id);expect(store.queue(s.id)).toEqual({...queue,items:[]});
      const next=store.enqueue(s.id,'new head',[],true);expect(next.paused).toBe(false);expect(next.reason).toBeUndefined();
      expect(store.messages(s.id)).toEqual([]);
    });

    it('enforces the 20-item cap per session without changing a full queue',()=>{
      const s=store.createSession(),other=store.createSession();
      for(let i=0;i<20;i++)store.enqueue(s.id,`item ${i}`,[],true);
      const full=store.queue(s.id);expect(full.items.map(item=>item.content)).toEqual(Array.from({length:20},(_,i)=>`item ${i}`));
      expect(new Set(full.items.map(item=>item.id)).size).toBe(20);
      expect(()=>store.enqueue(s.id,'overflow',[],true)).toThrow(expect.objectContaining({status:409}));
      expect(store.queue(s.id)).toEqual(full);expect(store.enqueue(other.id,'independent',[],true).items).toHaveLength(1);
      store.removeQueued(s.id,full.items[5].id);const refilled=store.enqueue(s.id,'replacement',[],true);
      expect(refilled.items).toHaveLength(20);expect(refilled.items.at(-1)?.content).toBe('replacement');
    });

    it('accepts exactly 16 MiB serialized bytes and rejects one byte more without persistence',()=>{
      const now=vi.spyOn(Date,'now').mockReturnValue(1_800_000_000_000);
      try {
        const limit=16*1024*1024,s=store.createSession();
        const template=store.enqueue(s.id,'',[],true),overhead=Buffer.byteLength(JSON.stringify(template));
        store.removeQueued(s.id,template.items[0].id);
        const content='x'.repeat(limit-overhead),exact=store.enqueue(s.id,content,[],true);
        expect(Buffer.byteLength(JSON.stringify(exact))).toBe(limit);
        expect(store.queue(s.id).items[0].content.length).toBe(content.length);
        store.removeQueued(s.id,exact.items[0].id);const empty=store.queue(s.id);
        expect(()=>store.enqueue(s.id,content+'x',[],true)).toThrow(expect.objectContaining({status:413}));
        expect(store.queue(s.id)).toEqual(empty);
      } finally { now.mockRestore(); }
    });

    it('counts aggregate UTF-8 attachment bytes rather than characters or individual item size',()=>{
      const s=store.createSession(),attachments=[{name:'large.txt',content:'界'.repeat(3*1024*1024)}];
      const first=store.enqueue(s.id,'first',attachments,true);
      const hypothetical={...first,items:[...first.items,{...first.items[0],id:'second',content:'second'}]};
      expect(JSON.stringify(hypothetical).length).toBeLessThan(16*1024*1024);
      expect(Buffer.byteLength(JSON.stringify(hypothetical))).toBeGreaterThan(16*1024*1024);
      expect(()=>store.enqueue(s.id,'second',attachments,true)).toThrow(expect.objectContaining({status:413}));
      const persisted=store.queue(s.id);expect(persisted.items).toHaveLength(1);
      expect(persisted.items[0].id).toBe(first.items[0].id);expect(persisted.items[0].attachments).toEqual(attachments);
    });

    it('rejects missing sessions and missing or foreign queued IDs without side effects',()=>{
      const s=store.createSession(),other=store.createSession(),queue=store.enqueue(s.id,'first',[],true);
      const foreign=store.enqueue(other.id,'other',[],true),message=acceptedMessage(queue.items[0]);
      for(const operation of [
        ()=>store.queue('missing'),()=>store.enqueue('missing','draft',[],true),
        ()=>store.saveQueue('missing',{items:[],paused:true}),()=>store.removeQueued('missing','item'),
        ()=>store.acceptQueued('missing','item',message),
      ])expect(operation).toThrow(expect.objectContaining({status:404}));
      for(const id of ['missing-item',foreign.items[0].id]){
        expect(()=>store.removeQueued(s.id,id)).toThrow(expect.objectContaining({status:404}));
        expect(()=>store.acceptQueued(s.id,id,message)).toThrow(expect.objectContaining({status:409}));
      }
      expect(store.queue(s.id)).toEqual(queue);expect(store.queue(other.id)).toEqual(foreign);
      expect(store.messages(s.id)).toEqual([]);expect(store.sessions()).toHaveLength(2);
      store.acceptQueued(s.id,queue.items[0].id,message);expect(store.messages(s.id)).toEqual([message]);
    });

    it('does not inherit queued drafts in forks or compaction archives',()=>{
      const s=store.createSession(),original:Message={id:'original',sessionId:s.id,role:'user',content:'old turn',createdAt:1};
      store.saveMessage(original);const queue=store.enqueue(s.id,'future prompt',[{name:'draft.txt',content:'future attachment'}],true);
      const fork=store.fork(s.id);expect(store.queue(fork.id)).toEqual({items:[],paused:true});expect(store.queue(s.id)).toEqual(queue);
      const summary={...original,id:'summary',role:'system' as const,content:'Summary'};
      const archive=store.compactHistory(s.id,[summary]);expect(store.queue(archive.id)).toEqual({items:[],paused:true});
      expect(store.queue(s.id)).toEqual(queue);expect(store.messages(s.id)).toEqual([summary]);
      expect(store.messages(archive.id).map(m=>m.content)).toEqual(['old turn']);
      expect(store.db.prepare('SELECT session_id FROM queues ORDER BY session_id').all()).toEqual([{session_id:s.id}]);
    });

    it('cascades queue deletion without touching another session and keeps it deleted on restart',()=>{
      const s=store.createSession(),other=store.createSession();store.enqueue(s.id,'delete me',[],true);
      const preserved=store.enqueue(other.id,'keep me',[],false);store.deleteSession(s.id);
      expect(store.db.prepare('SELECT session_id FROM queues').all()).toEqual([{session_id:other.id}]);
      expect(()=>store.queue(s.id)).toThrow(expect.objectContaining({status:404}));expect(store.queue(other.id)).toEqual(preserved);
      store.close();store=new Store(directory);
      expect(store.db.prepare('SELECT session_id FROM queues').all()).toEqual([{session_id:other.id}]);
      expect(store.queue(other.id).items).toEqual(preserved.items);
    });
  });
  it('replays only events after a known cursor',()=>{const s=store.createSession();const e=store.event({sessionId:s.id,type:'delta',data:{delta:'a'}});store.event({sessionId:s.id,type:'done',data:{}});expect(store.events(s.id,e.id!)).toHaveLength(1);});
});
