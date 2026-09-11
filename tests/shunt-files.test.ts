import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { mkdtemp,realpath,writeFile,rm,symlink,link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { shuntSource,shuntReadGate } from '../server/tools.js';
import { completeShunt } from '../server/shunt.js';
import { SHUNT_LIMITS } from '../shared/shunt.js';

let directory:string;
const signal=new AbortController().signal;
beforeEach(async()=>{directory=await realpath(await mkdtemp(join(tmpdir(),'shunt-files-')));});
afterEach(async()=>{vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});
it.each(['\n','\r\n','\r'])('counts logical lines, including unterminated last lines: %j',async ending=>{
  await writeFile(join(directory,'source'),Array(350).fill('x').join(ending));
  expect(await shuntReadGate(directory,{path:'source'},undefined,signal,350)).toBe(false);
  const content=Array(351).fill('x').join(ending);await writeFile(join(directory,'source'),content);
  expect(await shuntReadGate(directory,{path:'source'},undefined,signal,350)).toBe(true);
  expect(await shuntSource(directory,{path:'source'},undefined,signal,SHUNT_LIMITS.sourceBytes)).toMatchObject({content,lines:351,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
});
it.each([{offset:0},{limit:0},{limit:2001},{direct_reason:''},{direct_reason:' '.repeat(20)},{direct_reason:'x'.repeat(1001)}])('rejects invalid read bypass arguments: %j',async args=>{
  await writeFile(join(directory,'source'),'hello');
  await expect(shuntReadGate(directory,{path:'source',...args},undefined,signal,350)).rejects.toThrow();
});
it('rejects incomplete, binary and invalid UTF-8 sources',async()=>{
  for(const content of [Buffer.alloc(11,65),Buffer.from([0,65]),Buffer.from([0xff,0xfe])]){
    await writeFile(join(directory,'source'),content);
    await expect(shuntSource(directory,{path:'source'},undefined,signal,10)).rejects.toThrow();
  }
  await writeFile(join(directory,'source'),'');
  expect(await shuntSource(directory,{path:'source'},undefined,signal,0)).toMatchObject({bytes:0,lines:0});
});
it('uses ordinary protected-file, symlink and hard-link checks',async()=>{
  await writeFile(join(directory,'.env'),'SECRET');
  await expect(shuntSource(directory,{path:'.env'},undefined,signal,100)).rejects.toThrow();
  await symlink(join(directory,'.env'),join(directory,'alias'));
  await expect(shuntSource(directory,{path:'alias'},undefined,signal,100)).rejects.toThrow();
  await writeFile(join(directory,'source'),'data');await link(join(directory,'source'),join(directory,'hard'));
  await expect(shuntSource(directory,{path:'hard'},undefined,signal,100)).rejects.toThrow();
});
it('rejects a request exceeding the selected model window before transport',async()=>{
  const source={path:'source',sha256:'a'.repeat(64),bytes:64_000,lines:400,content:'x'.repeat(64_000)};
  await expect(completeShunt({kind:'reader',instruction:'Summarize',sources:[source],provider:{id:'p',name:'P',kind:'openai',baseUrl:'http://invalid.test',contextWindows:{small:8192}},model:'small',sessionId:'s',signal,progress:()=>{},usage:()=>{},retry:()=>{}})).rejects.toThrow('context budget');
});

it.each(['end_turn','max_tokens','pause_turn','refusal',undefined])('checks native Anthropic completion before accepting generated content: %s',async stopReason=>{
  const frames=[{type:'message_start',message:{usage:{input_tokens:4}}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'export const ready = true;'}},{type:'message_delta',delta:{stop_reason:stopReason},usage:{output_tokens:7}},{type:'message_stop'}];
  const fetcher=vi.fn(async()=>new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}}));vi.stubGlobal('fetch',fetcher);
  const usage=vi.fn(),progress=vi.fn();
  const result=completeShunt({kind:'writer',instruction:'Generate',sources:[{path:'reference.ts',sha256:'a'.repeat(64),bytes:4,lines:1,content:'code'}],provider:{id:'native',name:'Native',kind:'anthropic',baseUrl:'https://native.test',apiKey:'synthetic'},model:'claude-test',sessionId:'root',signal,progress,usage,retry:()=>{}});
  if(stopReason==='end_turn')await expect(result).resolves.toBe('export const ready = true;');else await expect(result).rejects.toThrow(/complete|output limit/);
  const request=JSON.parse((fetcher.mock.calls[0] as unknown as [unknown,RequestInit])[1].body as string);
  expect(request.max_tokens).toBe(8192);expect(request.tools).toBeUndefined();expect(usage).toHaveBeenCalledWith(expect.objectContaining({inputTokens:4,outputTokens:7}));
});
