import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig, Settings, ToolDefinition } from '../shared/types.js';

interface Connection { fingerprint:string; client?:Client; tools:ToolDefinition[]; toolNames:Map<string,string>; status:'connected'|'disabled'|'error'|'connecting'; error?:string; }
export class McpManager {
  private connections=new Map<string,Connection>();
  private syncing?:Promise<void>;
  constructor(private getConfig:()=>Settings['mcpServers']){}
  private async sync(){
    if(this.syncing)return this.syncing;
    this.syncing=this.reconcile().finally(()=>{this.syncing=undefined;});return this.syncing;
  }
  private async reconcile(){
    const configs=this.getConfig();
    for(const[name,connection]of this.connections)if(!configs[name]){await connection.client?.close().catch(()=>{});this.connections.delete(name);}
    await Promise.all(Object.entries(configs).map(async([name,config])=>{
      const fingerprint=createHash('sha256').update(JSON.stringify(config)).digest('hex');
      const previous=this.connections.get(name);if(previous?.fingerprint===fingerprint)return;
      await previous?.client?.close().catch(()=>{});
      const entry:Connection={fingerprint,tools:[],toolNames:new Map(),status:config.enabled===false?'disabled':'connecting'};
      this.connections.set(name,entry);if(config.enabled===false)return;
      try{
        let transport:Transport;
        if(config.command)transport=new StdioClientTransport({command:config.command,args:config.args,env:{...getDefaultEnvironment(),...config.env},stderr:'pipe'});
        else if(config.url){const url=new URL(config.url);if(!['https:','http:'].includes(url.protocol))throw new Error('MCP URL must use HTTP or HTTPS.');transport=new StreamableHTTPClientTransport(url);}
        else throw new Error('Configure a command or URL.');
        let client=new Client({name:'lite',version:'0.1.0'},{capabilities:{}});
        try{await client.connect(transport,{timeout:15000});}
        catch(error){
          await client.close().catch(()=>{});
          if(!config.url)throw error;
          client=new Client({name:'lite',version:'0.1.0'},{capabilities:{}});
          await client.connect(new SSEClientTransport(new URL(config.url)),{timeout:15000});
        }
        entry.client=client;
        let cursor:string|undefined;
        for(let page=0;page<20;page++){
          const result=await client.listTools(cursor?{cursor}:undefined,{timeout:15000});
          for(const tool of result.tools){
            const raw=`${name}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g,'_');
            const suffix=createHash('sha256').update(`${name}\0${tool.name}`).digest('hex').slice(0,8);
            const local=`mcp_${raw.slice(0,48)}_${suffix}`;
            entry.toolNames.set(local,tool.name);
            entry.tools.push({type:'function',function:{name:local,description:`[${name}] ${tool.description||tool.name}`.slice(0,8000),parameters:tool.inputSchema as Record<string,unknown>}});
          }
          cursor=result.nextCursor;if(!cursor)break;
        }
        entry.status='connected';
        client.onclose=()=>{if(entry.status==='connected'){entry.status='error';entry.error='Connection closed. Toggle this server off and on to reconnect.';}};
        client.onerror=()=>{/* Errors are returned to the active request, never log server secrets. */};
      }catch(error){entry.status='error';entry.error=this.redact(error,config);await entry.client?.close().catch(()=>{});entry.client=undefined;entry.tools=[];}
    }));
  }
  private redact(error:unknown,config:McpServerConfig){let text=error instanceof Error?error.message:'Unable to connect.';for(const value of Object.values(config.env||{}))if(value)text=text.split(value).join('[redacted]');if(config.url){const url=new URL(config.url);for(const value of [url.password,...url.searchParams.values()])if(value)text=text.split(value).join('[redacted]');}return text.slice(0,1000);}
  async definitions(){await this.sync();return[...this.connections.values()].filter(c=>c.status==='connected').flatMap(c=>c.tools);}
  async execute(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<string>{
    await this.sync();const pair=[...this.connections.entries()].find(([,c])=>c.status==='connected'&&c.toolNames.has(name));
    if(!pair?.[1].client)throw new Error('The connected tool is unavailable. Check MCP settings.');
    const[server,connection]=pair;
    try{
      const result=await connection.client!.callTool({name:connection.toolNames.get(name)!,arguments:args},undefined,{signal,timeout:60000});
      const content=Array.isArray(result.content)?result.content:[];
      const text=content.map((part:any)=>part.type==='text'?part.text:part.type==='resource'?part.resource?.text||JSON.stringify(part.resource):`[${part.type} content]`).join('\n');
      if(result.isError)throw new Error(text||'The MCP tool returned an error.');
      return(text||JSON.stringify(result.structuredContent||result)).slice(0,60000);
    }catch(error){throw new Error(this.redact(error,this.getConfig()[server]||{}));}
  }
  async status(){await this.sync();return[...this.connections.entries()].map(([name,c])=>({name,status:c.status,tools:c.tools.map(t=>t.function.name),error:c.error}));}
  async close(){await Promise.allSettled([...this.connections.values()].map(c=>c.client?.close()));this.connections.clear();}
}
