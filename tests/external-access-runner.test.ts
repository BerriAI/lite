import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const until = async (check: () => boolean) => { const end = Date.now()+5000; while (!check()) { if (Date.now()>end) throw new Error('Timed out waiting for approval'); await new Promise(resolve=>setTimeout(resolve,5)); } };
function reply(res: ServerResponse, name?: string, args: Record<string, unknown> = {}) {
  const delta = name ? {tool_calls:[{index:0,id:'call-1',type:'function',function:{name,arguments:JSON.stringify(args)}}]} : {content:'Done'};
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:name?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
}

describe('external paths use normal tool permissions', () => {
  let directory: string, workspace: string, outside: string, store: Store, provider: Server, server: Server, url: string;
  let runner: ReturnType<typeof createApp>['runner'], respond: (body:any,res:ServerResponse)=>void;
  const calls = (id:string) => store.messages(id).flatMap(message=>message.toolCalls??[]);
  const setCall = (name:string,args:Record<string,unknown>) => { respond=(body,res)=>body.messages.at(-1)?.role==='tool'?reply(res):reply(res,name,args); };
  const create = (extra: Record<string,unknown>={}) => store.createSession({workspace,permissionMode:'ask',...extra});
  const start = (id:string) => runner.start(id,'Inspect the requested project');
  const approve = async (id:string,decision:'allow'|'always'|'deny'='allow') => { await until(()=>runner.permissions(id).length===1); const prompt=runner.permissions(id)[0]; runner.decide(id,prompt.id,decision); await runner.whenIdle(); return prompt; };
  beforeEach(async () => {
    directory=await realpath(await mkdtemp(join(tmpdir(),'speedrail-external-access-'))); workspace=join(directory,'workspace'); outside=join(directory,'outside');
    await mkdir(workspace); await mkdir(outside); await writeFile(join(outside,'package.json'),'external evidence'); await writeFile(join(workspace,'inside.txt'),'inside');
    store=new Store(join(directory,'state')); respond=(_body,res)=>reply(res);
    provider=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);respond(JSON.parse(Buffer.concat(chunks).toString()),res);});
    store.saveSettings({workspace,providers:[{id:'test',name:'Test',kind:'openai',baseUrl:await listen(provider),apiKey:'fake-key'}],defaultProvider:'test',defaultModel:'model'});
    const app=createApp({store});runner=app.runner;server=createServer(app.app);url=await listen(server);
  });
  afterEach(async()=>{runner.stopAll();await runner.whenIdle();await close(server);await close(provider);store.close();await rm(directory,{recursive:true,force:true});});

  it.each(['build','plan'] as const)('reads a sibling file after user approval in %s mode',async mode=>{
    setCall('read_file',{path:'../outside/package.json'});const s=create({mode});start(s.id);
    await until(()=>runner.permissions(s.id).length===1);
    expect(store.messages(s.id).some(message=>message.role==='tool')).toBe(false);
    const prompt=await approve(s.id);expect(prompt.scopePath).toBe(join(outside,'package.json'));expect(prompt.description).toContain('Read outside');
    expect(calls(s.id)[0]).toMatchObject({status:'completed',output:'1\texternal evidence'});
  });

  it.each(['glob','grep'] as const)('searches an approved external directory with %s and returns reusable absolute paths',async name=>{
    setCall(name,{path:'../outside',pattern:name==='glob'?'*.json':'evidence'});const s=create();start(s.id);await approve(s.id);
    expect(calls(s.id)[0].status).toBe('completed');expect(calls(s.id)[0].output).toContain(join(outside,'package.json'));
  });

  it.each(['.hidden','node_modules'])('keeps an explicitly selected external %s directory out of discovery',async folder=>{
    await mkdir(join(outside,folder));await writeFile(join(outside,folder,'hidden.txt'),'hidden evidence');
    setCall('glob',{path:join(outside,folder),pattern:'**/*'});const s=create();start(s.id);await approve(s.id);
    expect(calls(s.id)[0].output).toBe('No files found.');
  });

  it('reads an external image through the same permission flow',async()=>{
    const image=Buffer.alloc(24);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(image);image.writeUInt32BE(1,16);image.writeUInt32BE(1,20);
    await writeFile(join(outside,'image.png'),image);setCall('view_image',{path:join(outside,'image.png')});const s=create();start(s.id);await approve(s.id);
    const result=store.messages(s.id).find(message=>message.role==='tool');expect(result?.attachments?.[0].path).toBe(join(outside,'image.png'));expect(calls(s.id)[0].status).toBe('completed');
  });

  it('denial reads nothing and cancellation clears the pending request',async()=>{
    setCall('read_file',{path:'../outside/package.json'});const s=create();start(s.id);await approve(s.id,'deny');
    expect(calls(s.id)[0]).toMatchObject({status:'denied'});expect(calls(s.id)[0].output).not.toContain('external evidence');
    start(s.id);await until(()=>runner.permissions(s.id).length===1);runner.cancel(s.id);await runner.whenIdle();expect(runner.permissions(s.id)).toEqual([]);
    expect(calls(s.id).at(-1)?.output).not.toContain('external evidence');
  });

  it('Auto and allow rules can approve reads; explicit ask and deny still win',async()=>{
    setCall('read_file',{path:'../outside/package.json'});const automatic=create({permissionMode:'auto'});start(automatic.id);await runner.whenIdle();expect(calls(automatic.id)[0].status).toBe('completed');
    store.saveSettings({permissionRules:{version:1,rules:[{tool:'read_file',decision:'allow',patterns:['../outside/**']}]}});
    const allowed=create();start(allowed.id);await runner.whenIdle();expect(calls(allowed.id)[0].status).toBe('completed');
    store.saveSettings({permissionRules:{version:1,rules:[{tool:'read_file',decision:'ask',patterns:['../outside/**']}]}});
    const asked=create({permissionMode:'auto'});start(asked.id);await approve(asked.id);expect(calls(asked.id)[0].status).toBe('completed');
    store.saveSettings({permissionRules:{version:1,rules:[{tool:'read_file',decision:'deny',patterns:['../outside/**']}]}});
    const denied=create({permissionMode:'auto'});start(denied.id);await runner.whenIdle();expect(calls(denied.id)[0].status).toBe('denied');
  });

  it('Always binds to this tool and resolved target, including across turns',async()=>{
    const s=create();setCall('read_file',{path:'../outside/package.json'});start(s.id);await approve(s.id,'always');
    start(s.id);await runner.whenIdle();expect(calls(s.id).at(-1)?.status).toBe('completed');
    await writeFile(join(outside,'other.txt'),'other');setCall('read_file',{path:'../outside/other.txt'});start(s.id);await approve(s.id,'deny');expect(calls(s.id).at(-1)?.status).toBe('denied');
    setCall('write_file',{path:'../outside/package.json',content:'changed'});start(s.id);await approve(s.id,'deny');expect(await readFile(join(outside,'package.json'),'utf8')).toBe('external evidence');
  });

  it('a workspace tool grant does not approve an external write, which remains outside Undo',async()=>{
    const s=create();setCall('write_file',{path:'inside.txt',content:'changed inside'});start(s.id);await approve(s.id,'always');
    setCall('write_file',{path:'../outside/new/deep/file.txt',content:'external change'});start(s.id);
    const prompt=await approve(s.id);expect(prompt.description).toContain('not covered by workspace Undo');expect(calls(s.id).at(-1)?.status).toBe('completed');
    expect(store.messages(s.id).findLast(message=>message.receipts)?.receipts?.filesChanged).toEqual(['../outside/new/deep/file.txt']);
    expect(await readFile(join(outside,'new/deep/file.txt'),'utf8')).toBe('external change');expect(runner.history.state(s.id).effectsNotice).toContain('External file changes');
    await runner.history.undo(s.id,runner.history.state(s.id).undoId!);expect(await readFile(join(outside,'new/deep/file.txt'),'utf8')).toBe('external change');
    setCall('edit_file',{path:'../outside/new/deep/file.txt',old_string:'external',new_string:'approved'});start(s.id);await approve(s.id);
    expect(await readFile(join(outside,'new/deep/file.txt'),'utf8')).toBe('approved change');
  });

  it('resolves symlink escapes for approval and checks rules against the destination',async()=>{
    await symlink(outside,join(workspace,'alias'));setCall('read_file',{path:'alias/package.json'});const s=create();start(s.id);const prompt=await approve(s.id);expect(prompt.scopePath).toBe(join(outside,'package.json'));
    store.saveSettings({permissionRules:{version:1,rules:[{tool:'read_file',decision:'deny',patterns:[join(outside,'**')]}]}});
    start(s.id);await runner.whenIdle();expect(calls(s.id).at(-1)?.status).toBe('denied');
  });

  it('refuses a target swapped while approval is pending',async()=>{
    await symlink(join(outside,'package.json'),join(workspace,'alias'));await writeFile(join(outside,'other.txt'),'must not be read');
    setCall('read_file',{path:'alias'});const s=create();start(s.id);await until(()=>runner.permissions(s.id).length===1);
    await unlink(join(workspace,'alias'));await symlink(join(outside,'other.txt'),join(workspace,'alias'));await approve(s.id);
    expect(calls(s.id)[0].status).toBe('error');expect(calls(s.id)[0].output).toContain('target changed after approval');expect(calls(s.id)[0].output).not.toContain('must not be read');
  });

  it('rechecks permission when a sidecar redirects an internal read outside',async()=>{
    const command = `node -e 'const rl=require("readline").createInterface({input:process.stdin});rl.on("line",line=>{const m=JSON.parse(line);console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{action:"modify",args:{path:"../outside/package.json"},reason:"Inspect sibling"}}))})'`;
    store.saveSettings({sidecars:[{name:'redirect',command,events:['tool_call']}]});
    setCall('read_file',{path:'inside.txt'});const s=create();start(s.id);const prompt=await approve(s.id);
    expect(prompt.scopePath).toBe(join(outside,'package.json'));expect(calls(s.id)[0].intercepted?.originalArgs).toEqual({path:'inside.txt'});expect(calls(s.id)[0].output).toContain('external evidence');
  });

  it('Plan mode still refuses external writes even in Auto',async()=>{
    setCall('write_file',{path:'../outside/package.json',content:'forbidden'});const s=create({mode:'plan',permissionMode:'auto'});start(s.id);await runner.whenIdle();
    expect(calls(s.id)[0].status).toBe('denied');expect(await readFile(join(outside,'package.json'),'utf8')).toBe('external evidence');
  });

  it('keeps credential protections and workspace-only API reads',async()=>{
    await writeFile(join(outside,'.env'),'protected');setCall('read_file',{path:'../outside/.env'});const s=create({permissionMode:'auto'});start(s.id);await runner.whenIdle();expect(calls(s.id)[0].output).toContain('Protected');
    const response=await fetch(`${url}/api/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent('../outside/package.json')}`);expect(response.ok).toBe(false);
  });

  it.each([false,true])('allows an external shell cwd after approval (background=%s)',async background=>{
    setCall('bash',{command:'pwd',cwd:'../outside',run_in_background:background});const s=create();start(s.id);const prompt=await approve(s.id);expect(prompt.scopePath).toBe(outside);expect(calls(s.id)[0].status).toBe('completed');
    if(!background)expect(calls(s.id)[0].output).toContain(outside);
  });

  it.each(['task','sidekick'])('routes %s external-read approval through the driver',async name=>{
    const s=create(name==='sidekick'?{architecture:{kind:'sidekick-fusion',sidekick:{providerId:'test',model:'side-model'}}}:{});
    store.saveSettings({permissionRules:{version:1,rules:name==='task'?[{tool:'task',decision:'allow'}]:[]}});
    respond=(body,res)=>{
      const child=body.model==='side-model'||body.messages.some((message:any)=>message.role==='user'&&String(message.content).includes('CHILD request'));
      if(body.messages.at(-1)?.role==='tool')reply(res);
      else if(child)reply(res,'read_file',{path:'../outside/package.json'});
      else reply(res,name,{description:'Inspect sibling',prompt:'CHILD request'});
    };
    start(s.id);
    if(name==='sidekick'){await until(()=>runner.permissions(s.id).length===1);runner.decide(s.id,runner.permissions(s.id)[0].id,'allow');}
    const prompt=await approve(s.id);expect(prompt.tool).toBe('read_file');expect(prompt.sessionId).toBe(s.id);
    const delegation=runner.delegations.list(s.id)[0];const result=runner.delegations.transcript(s.id,delegation.id).messages.find(message=>message.role==='tool');expect(result?.content).toContain('external evidence');
  });
  it('remembers multiple external paths without replacing an earlier approval', async () => {
    await writeFile(join(outside,'second.txt'),'second');
    const s=create();
    for(const path of ['../outside/package.json','../outside/second.txt']) { setCall('read_file',{path});start(s.id);await approve(s.id,'always'); }
    for(const path of ['../outside/package.json','../outside/second.txt']) {
      setCall('read_file',{path});start(s.id);
      await until(()=>!runner.active(s.id) || runner.permissions(s.id).length>0);
      expect(runner.permissions(s.id)).toHaveLength(0);await runner.whenIdle();
      expect(calls(s.id).at(-1)?.status).toBe('completed');
    }
  });

});
