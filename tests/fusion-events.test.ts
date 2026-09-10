import { describe, expect, it } from 'vitest';
import { applyEvent, reconcileSession } from '../shared/events.js';
import type { Session, SessionDetail } from '../shared/types.js';
import type { DelegationSummary } from '../shared/delegation.js';

const session: Session={id:'root',title:'Task',workspace:'/tmp',providerId:'fixture',model:'main',mode:'build',permissionMode:'ask',createdAt:1,updatedAt:1,status:'idle',archived:false,configRevision:2,modelReasoning:{'["fixture","main"]':'high'}};
describe('fusion event identity and accepted settings',()=>{
  it('keeps the newer reasoning preference when an older session snapshot arrives',()=>{
    expect(reconcileSession(session,{...session,configRevision:1,modelReasoning:{'["fixture","main"]':'low'}}).modelReasoning).toEqual(session.modelReasoning);
    expect(reconcileSession(session,{...session,configRevision:3,modelReasoning:{}}).modelReasoning).toEqual({});
  });
  it('shows a new invocation while preserving the completed call in the same context',()=>{
    const first:DelegationSummary={id:'first',parentSessionId:'root',parentTurnId:'turn-1',parentMessageId:'m1',toolCallId:'call-1',childSessionId:'context',description:'First',status:'completed',createdAt:1,role:'sidekick'};
    const second:DelegationSummary={...first,id:'second',parentTurnId:'turn-2',parentMessageId:'m2',toolCallId:'call-2',status:'running',description:'Second',createdAt:2};
    const detail={session,messages:[],permissions:[],todos:[],changes:[],delegations:[first]} as SessionDetail;
    const next=applyEvent(detail,{id:1,sessionId:'root',type:'delegation',data:second});
    expect(next.delegations).toEqual([first,second]);
    expect(applyEvent(next,{id:2,sessionId:'root',type:'delegation',data:{...first,status:'running'}}).delegations).toEqual([first,second]);
  });
});
