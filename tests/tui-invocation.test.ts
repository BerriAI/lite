import { describe, expect, it } from 'vitest';
import type { DelegationDetail, DelegationSummary, RunEvent } from '../shared/types.js';
import type { SpeedrailClient } from '../tui/client.js';
import { InvocationSync } from '../tui/invocation.js';

const task={id:'handoff',childSessionId:'sidekick',parentSessionId:'driver',parentMessageId:'parent-message',parentTurnId:'turn',toolCallId:'call',role:'sidekick',status:'running',description:'Assignment',createdAt:1} as DelegationSummary;
const snapshot=():DelegationDetail=>({readOnly:true,delegation:{...task},session:{id:'sidekick',status:'running'} as DelegationDetail['session'],messages:[],permissions:[],todos:[],lastEventId:1});
const message=(id:number,sessionId='sidekick'):RunEvent=>({id,sessionId,type:'message',data:{id:'reply',sessionId,role:'assistant',content:`Update ${id}`,createdAt:1}} as RunEvent);

describe('inline invocation synchronization',()=>{
  it('rejects a mismatched handoff and ignores events from another worker or an old cursor',async()=>{
    let next=snapshot();const sync=new InvocationSync({api:async()=>next} as unknown as SpeedrailClient,task);
    try{
      next={...next,delegation:{...task,toolCallId:'other-call'}};await sync.refresh();
      expect(sync.getState().detail).toBeNull();expect(sync.getState().error).toContain('does not match');
      next=snapshot();await sync.refresh();sync.apply(message(2,'other-worker'));expect(sync.getState().detail?.messages).toHaveLength(0);
      sync.apply(message(3));sync.apply(message(2));expect(sync.getState().detail?.messages[0].content).toBe('Update 3');
    }finally{sync.stop();}
  });
  it('seals completed Sidekick handoffs before its reused child context emits another assignment',async()=>{
    let next=snapshot();const sync=new InvocationSync({api:async()=>next} as unknown as SpeedrailClient,task);
    try{
      await sync.refresh();sync.apply(message(3));
      next={...sync.getState().detail!,delegation:{...task,status:'completed'},lastEventId:4};await sync.refresh();
      sync.apply(message(5));next=snapshot();await sync.refresh();
      expect(sync.getState().detail?.delegation.status).toBe('completed');expect(sync.getState().detail?.messages[0].content).toBe('Update 3');
    }finally{sync.stop();}
  });
  it('rejects the next Sidekick turn even before the parent completion refresh arrives',async()=>{
    const current=snapshot();current.messages=[{id:'assignment-user',sessionId:'sidekick',role:'user',content:'This handoff',createdAt:1}];
    const sync=new InvocationSync({api:async()=>current} as unknown as SpeedrailClient,task);
    try{
      await sync.refresh();sync.apply({...message(2),data:{...message(2).data,turnId:'next-assignment'}});
      expect(sync.getState().detail?.messages).toHaveLength(1);
      sync.apply({...message(3),data:{...message(3).data,turnId:'assignment-user'}});
      expect(sync.getState().detail?.messages).toHaveLength(2);
    }finally{sync.stop();}
  });
  it('discards a late snapshot after a newer refresh wins',async()=>{
    const pending:Array<(value:DelegationDetail)=>void>=[];
    const sync=new InvocationSync({api:()=>new Promise(resolve=>pending.push(resolve))} as unknown as SpeedrailClient,task);
    try{
      const first=sync.refresh(),second=sync.refresh();pending[1]({...snapshot(),lastEventId:10});await second;
      pending[0](snapshot());await first;expect(sync.getState().detail?.lastEventId).toBe(10);
    }finally{sync.stop();}
  });
});
