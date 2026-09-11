import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import { selectArchitecture, type ArchitectureKind } from '../../shared/architectures.js';
import type { Provider } from '../../shared/types.js';
import { correctAnswer, expectedAnswers } from './scoring.js';

if(process.env.SHUNT_RESEARCH_LIVE!=='1'||!process.env.SHUNT_RESEARCH_SETTINGS_DB)throw new Error('Set SHUNT_RESEARCH_LIVE=1 and an explicit read-only settings DB for this bounded live evaluation.');
const db=new DatabaseSync(process.env.SHUNT_RESEARCH_SETTINGS_DB,{readOnly:true});
let provider:Provider;
try{provider=JSON.parse((db.prepare('SELECT data FROM settings WHERE id=1').get() as {data:string}).data).providers.find((item:Provider)=>item.id===(process.env.SHUNT_RESEARCH_PROVIDER??'litellm'));}finally{db.close();}
if(!provider||provider.kind!=='openai')throw new Error('Select an OpenAI-compatible gateway.');
const env=process.env.SHUNT_RESEARCH_ENV_FILE?parseEnv(await readFile(process.env.SHUNT_RESEARCH_ENV_FILE,'utf8')):{};
provider={...provider,apiKey:provider.apiKey||env.LITELLM_API_KEY||process.env.LITELLM_API_KEY};
if(!provider.apiKey)throw new Error('No gateway credential configured.');
const powerful=process.env.SHUNT_RESEARCH_DRIVER??'claude-haiku-4-5-20251001';
const efficient=process.env.SHUNT_RESEARCH_WORKER??'gemini/gemini-2.5-flash';
const shuntModel=process.env.SHUNT_RESEARCH_SHUNT??'gemini/gemini-2.5-flash-lite';
const architectures:('single'|ArchitectureKind)[]=['single','sidekick-fusion','team-fusion','expert-fusion'];
const filler=(count:number)=>Array.from({length:count},(_,i)=>`// unrelated declaration ${i}: CORPUS_ONLY_SENTINEL — synthetic fixture, no production data`).join('\n');
const cases=[
  {name:'large-read',prompt:'Read settings.mjs broadly and report all exported configuration values. Return JSON containing MAX_RETRIES, RETRY_DELAY_MS, DEFAULT_REGION, and MAX_BATCH.'},
  {name:'cross-file-read',prompt:'Inspect settings.mjs, limits.mjs and routes.mjs. Return JSON with MAX_RETRIES, MAX_BATCH, burst, refillMs, primary, and fallback from their definitions.'},
  {name:'targeted-read',prompt:'Read settings.mjs at offset 371, limit 4. Return the four exported literal values as JSON.'},
  {name:'generate',prompt:'Generate generated.mjs from reference.mjs, matching its style. Export const settings with timeoutMs:4500, retries:7, region:"eu-west-4", strict:true. Run npm test and report the result.'},
  {name:'exact-edit',prompt:'Fix generated.mjs: its retries value should be 7, not 0. Read exactly what you need, make the edit, and run npm test.'},
  {name:'debug-read',prompt:'Investigate retry.mjs. Explain the retry limit for a 401 error versus a 503 error with code TEMP. Read precisely if needed. Return JSON {authRetries:number,tempRetries:number}. Do not modify files.'},
];
const execute=promisify(execFile);
const root=await mkdtemp(join(tmpdir(),'litespeed-shunt-native-eval-'));
const output=process.env.SHUNT_RESEARCH_OUTPUT??join(import.meta.dirname,'results','native-pilot.json');
const results:Record<string,unknown>[]=[];
let next=0;
const selectedCases=process.env.SHUNT_RESEARCH_CASES?.split(',');
const selectedArchitectures=process.env.SHUNT_RESEARCH_ARCHITECTURES?.split(',');
const trials=architectures.filter(kind=>!selectedArchitectures||selectedArchitectures.includes(kind)).flatMap(kind=>cases.filter(item=>!selectedCases||selectedCases.includes(item.name)).flatMap(item=>[false,true].map(enabled=>({kind,item,enabled}))));
const limit=Number(process.env.SHUNT_RESEARCH_LIMIT??48);
if(!Number.isInteger(limit)||limit<1||limit>48)throw new Error('This pilot supports 1–48 trials.');
async function trial({kind,item,enabled}:typeof trials[number]){
  const label=`${kind}/${item.name}/${enabled?'on':'off'}`,directory=join(root,randomUUID());await mkdir(directory);
  await writeFile(join(directory,'settings.mjs'),`${filler(370)}\nexport const MAX_RETRIES = 7;\nexport const RETRY_DELAY_MS = 1750;\nexport const DEFAULT_REGION = 'eu-west-4';\nexport const MAX_BATCH = 48;\n${filler(370)}\n`);
  await writeFile(join(directory,'limits.mjs'),`${filler(180)}\nexport const LIMITS = { burst:37, refillMs:2450 };\n${filler(180)}\n`);
  await writeFile(join(directory,'routes.mjs'),`${filler(180)}\nexport const ROUTES = {primary:'/relay/v3',fallback:'/relay/safe'};\n${filler(180)}\n`);
  await writeFile(join(directory,'reference.mjs'),'export const settings = {\n  timeoutMs:2000,\n  retries:3,\n};\n');
  await writeFile(join(directory,'retry.mjs'),`${filler(370)}\nexport function retries(status, code) { if(status===401)return 0; if(code==='TEMP')return 3; return 7; }\n${filler(370)}\n`);
  if(item.name==='exact-edit')await writeFile(join(directory,'generated.mjs'),'export const settings = {timeoutMs:4500,retries:0,region:"eu-west-4",strict:true};\n');
  await writeFile(join(directory,'package.json'),JSON.stringify({type:'module',scripts:{test:'node check.mjs'}}));
  await writeFile(join(directory,'check.mjs'),`import assert from 'node:assert/strict';import {settings} from './generated.mjs';assert.deepEqual(settings,{timeoutMs:4500,retries:7,region:'eu-west-4',strict:true});console.log('All fixture checks passed.');`);
  const store=new Store(join(directory,'.eval-state'));
  store.saveSettings({workspace:directory,providers:[provider],defaultProvider:provider.id,defaultModel:powerful,permissionMode:'auto',memoryEnabled:false});
  const {runner}=createApp({store,external:{capture:()=>({definitions:[],scope:()=>'',assertCurrent:()=>{},execute:async()=>'',release:()=>{}})}});
  const expert=kind==='expert-fusion';
  const session=store.createSession({workspace:directory,providerId:provider.id,model:expert?efficient:powerful,permissionMode:'auto',...(kind==='single'?{}:{architecture:selectArchitecture(kind,{providerId:provider.id,model:expert?powerful:efficient})}),shunt:{enabled,model:{providerId:provider.id,model:shuntModel}}});
  const started=Date.now();let error:string|undefined;
  const timeout=setTimeout(()=>runner.cancel(session.id),180_000);
  try {runner.start(session.id,`Independent synthetic trial ${randomUUID()}. ${item.prompt}${process.env.SHUNT_RESEARCH_FORCE_WRITER==='1'&&enabled&&item.name==='generate'?' The agent implementing this file must use code_write with reference:"reference.mjs" and target:"generated.mjs", then verify the actual file. If delegating, include that requirement in the worker assignment.':''}`);await runner.whenIdle();}
  catch{error='Runner failed; inspect isolated test output.';}finally{clearTimeout(timeout);}
  const messages=store.messages(session.id),last=messages.findLast(m=>m.role==='assistant'),usage=last?.turnUsage;
  let passed=correctAnswer(item.name,last?.content??'');
  if(!expectedAnswers[item.name])try{const result=await execute(process.execPath,['check.mjs'],{cwd:directory,timeout:5000});passed=result.stdout.includes('All fixture checks passed.');}catch{passed=false;}
  const children=runner.delegations.list(session.id),all=[...messages,...children.flatMap(c=>store.messages(c.childSessionId))];
  const calls=all.flatMap(m=>m.toolCalls??[]);
  const record={label,passed,error,errors:all.flatMap(m=>m.error?[m.error]:[]),forcedWriter:process.env.SHUNT_RESEARCH_FORCE_WRITER==='1',durationMs:Date.now()-started,status:store.session(session.id).status,shuntCalls:calls.filter(c=>c.shunt).map(c=>({kind:c.shunt!.kind,status:c.status,error:c.status==='error'?c.output:undefined})),directReads:calls.filter(c=>c.name==='read_file'&&!c.routing).length,routingHints:calls.filter(c=>c.routing).length,callerInputTokens:usage?.breakdown.filter(r=>r.role!=='shunt').reduce((sum,r)=>sum+(r.usage?.inputTokens??0),0),usage,final:last?.content};
  results.push(record);await writeFile(output,JSON.stringify({models:{driver:powerful,worker:efficient,shunt:shuntModel},requestedRuns:Math.min(limit,trials.length),results},null,2)+'\n');
  console.log(JSON.stringify({label,passed,status:record.status,shuntCalls:record.shuntCalls.length,seconds:Math.round(record.durationMs/1000)}));
  runner.stopAll();await runner.whenIdle();store.close();await rm(directory,{recursive:true,force:true});
}
try {await Promise.all(Array.from({length:2},async()=>{while(next<Math.min(limit,trials.length))await trial(trials[next++]);}));}
finally{await rm(root,{recursive:true,force:true});}
