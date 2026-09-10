import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { History } from '../server/history.js';
import { UsageLedger } from '../server/usage.js';
import { groupRuns } from '../shared/conversation.js';
import type { Message } from '../shared/types.js';

describe('Fusion task accounting and recovery',()=>{
  let directory:string,store:Store;
  beforeEach(async()=>{directory=await realpath(await mkdtemp(join(tmpdir(),'lite-fusion-accounting-')));store=new Store(join(directory,'state'));});
  afterEach(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  it('counts each cumulative provider request once, includes compaction, and leaves partial costs unknown',()=>{
    const ledger=new UsageLedger(store);
    const lead=ledger.start({rootSessionId:'root',sessionId:'root',turnId:'turn',providerId:'p',model:'large',role:'lead',phase:'response'});
    ledger.update(lead,{inputTokens:10,outputTokens:2,cost:.1});ledger.update(lead,{inputTokens:10,outputTokens:8,cost:.2});
    const child=ledger.start({rootSessionId:'root',sessionId:'child',turnId:'turn',providerId:'p',model:'small',role:'sidekick',phase:'compaction',invocationId:'handoff'});
    ledger.update(child,{inputTokens:20,outputTokens:4});
    expect(ledger.turn('root','turn')).toMatchObject({requests:2,reportedRequests:2,inputTokens:30,outputTokens:12});
    expect(ledger.turn('root','turn').cost).toBeUndefined();
    expect(store.usageSummary().reduce((sum,row)=>sum+row.requests,0)).toBe(2);
    ledger.start({rootSessionId:'root',sessionId:'child',turnId:'turn',providerId:'p',model:'small',role:'sidekick',phase:'response'});
    expect(ledger.turn('root','turn')).toMatchObject({requests:3,reportedRequests:2,inputTokens:30,outputTokens:12});
  });
  it('keeps one response group and one partial-price-safe footer across system notices',()=>{
    const message=(id:string,role:Message['role'],extra:Partial<Message>={}):Message=>({id,sessionId:'root',role,content:id,createdAt:1,...extra});
    const groups=groupRuns([message('user','user'),message('one','assistant',{usage:{inputTokens:3,outputTokens:1,cost:.1}}),message('notice','system'),message('two','assistant',{usage:{inputTokens:5,outputTokens:2}}),message('end-notice','system')]);
    expect(groups.filter(group=>group.startsRun)).toHaveLength(1);expect(groups.filter(group=>group.endsRun)).toHaveLength(1);
    expect(groups[1].steps.map(step=>step.id)).toEqual(['one','two']);
    expect(groups[1].closesTranscript).toBe(true);expect(groups[3].closesTranscript).toBe(true);
    expect(groups[1].runUsage).toBeUndefined();expect(groups[3].runUsage).toMatchObject({inputTokens:8,outputTokens:3});expect(groups[3].runUsage?.cost).toBeUndefined();
  });
  it('recovers an interrupted shell file observation without replaying the command, then undoes and redoes its source changes',async()=>{
    const session=store.createSession({workspace:directory}),history=new History(store);
    await writeFile(join(directory,'source.txt'),'before');
    history.accept(session.id,{id:'turn',sessionId:session.id,role:'user',content:'Change source',createdAt:1});
    await history.beginCommand(session.id,directory);
    await writeFile(join(directory,'source.txt'),'after');await writeFile(join(directory,'new.txt'),'created');
    store.close();store=new Store(join(directory,'state'));const recovered=new History(store);
    expect(recovered.state(session.id).pendingRecovery).toBeDefined();
    const state=await recovered.recover(session.id);expect(state.canUndo).toBe(true);
    expect(await readFile(join(directory,'source.txt'),'utf8')).toBe('after');
    const undone=await recovered.undo(session.id,state.undoId!);
    expect(await readFile(join(directory,'source.txt'),'utf8')).toBe('before');await expect(readFile(join(directory,'new.txt'))).rejects.toThrow();
    await recovered.redo(session.id,undone.redoId!);expect(await readFile(join(directory,'new.txt'),'utf8')).toBe('created');
  });
  it('recovers acknowledged steering after a crash before delivery, exactly once',async()=>{
    const session=store.createSession({workspace:directory}),history=new History(store);
    history.accept(session.id,{id:'turn',sessionId:session.id,role:'user',content:'Original task',createdAt:1});
    store.db.prepare('INSERT INTO steering_notes(id,session_id,turn_id,content,created_at) VALUES(?,?,?,?,?)').run('note',session.id,'turn','Keep the public API unchanged.',2);
    store.close();store=new Store(join(directory,'state'));const recovered=new History(store);
    await recovered.recover(session.id);await recovered.recover(session.id);
    const notes=store.messages(session.id).filter(message=>message.id==='note');
    expect(notes).toHaveLength(1);expect(notes[0].content).toContain('Keep the public API unchanged.');
    expect(recovered.state(session.id).canUndo).toBe(true);
  });
});
