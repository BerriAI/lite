import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager } from '../server/mcp.js';
import type { Settings } from '../shared/types.js';

let directory:string|undefined,manager:McpManager|undefined;
afterEach(async()=>{await manager?.close();if(directory)await rm(directory,{recursive:true,force:true});directory=undefined;manager=undefined;});
async function fixture(){
  directory=await mkdtemp(join(tmpdir(),'lite-mcp-'));
  const script=join(directory,'fixture.mjs');
  await writeFile(script,`import {createInterface} from 'node:readline';
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')reply(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
else if(m.method==='tools/list')reply(m.id,{tools:[{name:'echo',description:'Echo a value',inputSchema:{type:'object',properties:{text:{type:'string'}}}},{name:'fail',inputSchema:{type:'object'}},{name:'slow',inputSchema:{type:'object'}}]});
else if(m.method==='tools/call'){if(m.params.name==='slow')return;if(m.params.name==='fail')reply(m.id,{isError:true,content:[{type:'text',text:'fixture-secret failure'}]});else reply(m.id,{content:[{type:'text',text:m.params.arguments.text}]});}
else reply(m.id,{});});`);
  return script;
}
describe('connected MCP tools',()=>{
  it('discovers and executes real stdio tools with collision-safe names',async()=>{
    const script=await fixture();const config:Settings['mcpServers']={one:{command:process.execPath,args:[script]},two:{command:process.execPath,args:[script]}};
    manager=new McpManager(()=>config);const tools=await manager.definitions();expect(tools).toHaveLength(6);expect(new Set(tools.map(t=>t.function.name)).size).toBe(6);expect(tools.every(t=>t.function.name.length<=64)).toBe(true);
    const echo=tools.find(t=>t.function.name.startsWith('mcp_one_echo'))!;expect(await manager.execute(echo.function.name,{text:'hello'},new AbortController().signal)).toBe('hello');expect((await manager.status()).every(s=>s.status==='connected')).toBe(true);
  });
  it('does not start disabled servers and reconciles config changes',async()=>{
    const config:Settings['mcpServers']={off:{command:'/does/not/exist',enabled:false}};manager=new McpManager(()=>config);expect(await manager.definitions()).toEqual([]);expect((await manager.status())[0].status).toBe('disabled');delete config.off;expect(await manager.status()).toEqual([]);
  });
  it('reports startup errors without exposing configured secrets',async()=>{manager=new McpManager(()=>({bad:{command:'/does/not/exist',env:{TOKEN:'fixture-secret'}}}));expect(await manager.definitions()).toEqual([]);const status=await manager.status();expect(status[0].status).toBe('error');expect(JSON.stringify(status)).not.toContain('fixture-secret');});
  it('propagates tool errors and redacts server credentials',async()=>{const script=await fixture();manager=new McpManager(()=>({test:{command:process.execPath,args:[script],env:{TOKEN:'fixture-secret'}}}));const tools=await manager.definitions();await expect(manager.execute(tools.find(t=>t.function.name.includes('_fail_'))!.function.name,{},new AbortController().signal)).rejects.toThrow('[redacted] failure');});
  it('cancels a slow tool request and remains usable',async()=>{const script=await fixture();manager=new McpManager(()=>({test:{command:process.execPath,args:[script]}}));const tools=await manager.definitions(),controller=new AbortController();const result=manager.execute(tools.find(t=>t.function.name.includes('_slow_'))!.function.name,{},controller.signal);setTimeout(()=>controller.abort(),20);await expect(result).rejects.toThrow();expect(await manager.execute(tools.find(t=>t.function.name.includes('_echo_'))!.function.name,{text:'still connected'},new AbortController().signal)).toBe('still connected');});
});
