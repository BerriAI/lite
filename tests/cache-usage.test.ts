import { expect, it } from 'vitest';
import { aggregateUsage, cacheHitLabel, type RequestUsage } from '../shared/usage.js';
import { groupRuns } from '../shared/conversation.js';
import { usageDetails, usageLabel } from '../tui/conversation.js';
import { toolRow } from '../tui/transcriptModel.js';
import type { Message } from '../shared/types.js';

const record=(id:string,input:number,cached?:number):RequestUsage=>({id,rootSessionId:'root',sessionId:'root',turnId:'turn',providerId:'gateway',model:id,role:'driver',phase:'response',usage:{inputTokens:input,outputTokens:100,cachedTokens:cached}});
it('weights cache hit by input tokens across requests and exposes the per-model split',()=>{
  const usage=aggregateUsage([record('a',100,90),record('b',900,450)]);
  expect(cacheHitLabel(usage)).toBe('54% cache hit');
  const message:Message={id:'answer',sessionId:'root',role:'assistant',content:'Done',createdAt:1,turnUsage:usage};
  expect(usageLabel(message,usage)).toContain('54% cache hit');
  expect(usageDetails(message,usage)).toContain('90% cache hit');expect(usageDetails(message,usage)).toContain('50% cache hit');
});
it('keeps zero, missing, partial, and inconsistent cache reports distinct',()=>{
  expect(cacheHitLabel({inputTokens:100,cachedTokens:0})).toBe('0% cache hit');
  for(const usage of [{inputTokens:100},{inputTokens:0,cachedTokens:0},{inputTokens:100,cachedTokens:101}])expect(cacheHitLabel(usage)).toBe('Cache unavailable');
  expect(cacheHitLabel(aggregateUsage([record('a',100,90),record('b',100)]))).toBe('Cache unavailable');
  const missing=record('b',100);delete missing.usage;
  expect(aggregateUsage([record('a',100,90),missing]).cachedTokens).toBeUndefined();
});
it('excludes requests without usable cache reports from both sides of the percentage',()=>{
  const missing=record('a',100);delete missing.usage;
  const records=[record('a',100,90),record('a',10000),missing,record('a',100,101)];
  const usage=aggregateUsage(records);
  const message:Message={id:'answer',sessionId:'root',role:'assistant',content:'Partial answer',createdAt:1,turnUsage:usage};
  expect(cacheHitLabel(records.map(item=>item.usage))).toBe('90% cache hit');
  expect(usageLabel(message,usage)).toContain('90% cache hit');
  expect(usageDetails(message,usage)).toContain('90% cache hit · 4 requests (1 unreported)');
  expect(cacheHitLabel([undefined,{inputTokens:100},{inputTokens:0,cachedTokens:0}])).toBe('Cache unavailable');
  expect(cacheHitLabel([{inputTokens:100,cachedTokens:0},undefined])).toBe('0% cache hit');
});
it('labels family totals with the companion roles that contributed usage',()=>{
  const child={...record('deepseek',900,450),sessionId:'child',role:'sidekick' as const};
  const usage=aggregateUsage([record('astra',100,90),child,{...child,id:'another-request'}]);
  const message:Message={id:'answer',sessionId:'root',role:'assistant',content:'Done',createdAt:1,turnUsage:usage};
  expect(usageLabel(message,usage)).toMatch(/^astra \+ sidekick · /);
  expect(usageDetails(message,usage)).toContain('sidekick · gateway/deepseek');
  const single=aggregateUsage([record('astra',100,90)]);
  expect(usageLabel({...message,turnUsage:single},single)).toMatch(/^astra · /);
});
it('retains reported cache tokens when grouping older messages without a family ledger',()=>{
  const messages:Message[]=[1,2].map(index=>({id:String(index),sessionId:'root',role:'assistant',content:'Done',createdAt:index,usage:{inputTokens:100,outputTokens:20,cachedTokens:75}}));
  expect(cacheHitLabel(groupRuns(messages).at(-1)!.runUsage!)).toBe('75% cache hit');
  delete messages[0].usage!.cachedTokens;
  expect(cacheHitLabel(groupRuns(messages).at(-1)!.runUsage!)).toBe('Cache unavailable');
});
it('shows a failed command and a running job without changing their completed tool-call receipt',()=>{
  const call={id:'tool',name:'bash',args:{command:'npm test'},status:'completed' as const,output:'Test failed',execution:{command:'npm test',cwd:'/project',startedAt:1,status:'exited' as const,exitCode:1,timedOut:false}};
  expect(toolRow(call)).toMatchObject({failed:true,completed:false,error:'Command exited with code 1.'});
  expect(toolRow({...call,execution:{...call.execution,status:'running',exitCode:undefined}})).toMatchObject({running:true,failed:false,completed:false});
  expect(call.status).toBe('completed');
});
