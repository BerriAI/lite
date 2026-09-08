# Internal implementation contracts

## HTTP API
JSON request/response, errors `{error:string}`.
- GET `/api/health` -> `{ok:true,version:string}`
- GET `/api/settings` -> Settings with masked/omitted apiKeys and configured booleans
- PATCH `/api/settings` body Partial<Settings> -> public Settings. Provider secret empty string removes; omitted preserves.
- GET `/api/models?providerId=` -> `{models:Model[],error?:string}` (configured server fetch; don't reveal keys)
- POST `/api/providers/test` body `{providerId}` -> `{ok:boolean,models?:number,error?:string}`
- GET `/api/sessions?q=&archived=` -> `{sessions:Session[]}`
- POST `/api/sessions` body `{title?,workspace?,model?,providerId?,mode?,permissionMode?}` -> Session
- GET `/api/sessions/:id` -> SessionDetail
- PATCH `/api/sessions/:id` body `{title?,archived?,model?,providerId?,mode?,permissionMode?}` -> Session
- DELETE `/api/sessions/:id` -> `{ok:true}`
- POST `/api/sessions/:id/messages` body `{content,attachments?:Attachment[]}` -> `{ok:true}` begins background agent run; conflict if already running
- GET `/api/sessions/:id/events` -> SSE RunEvent (event JSON in `data:`) with heartbeat and event IDs, `Last-Event-ID` replay
- POST `/api/sessions/:id/cancel` -> `{ok:true}`
- POST `/api/sessions/:id/permissions/:requestId` body `{decision:'allow'|'always'|'deny'}` -> `{ok:true}`
- POST `/api/sessions/:id/fork` body `{messageId?}` -> Session
- POST `/api/sessions/:id/compact` -> `{ok:true}`
- GET `/api/sessions/:id/export` -> JSON `{session,messages,todos}`
- POST `/api/sessions/import` body export object -> Session
- GET `/api/files?workspace=&path=` -> `{entries:FileEntry[]}`
- GET `/api/file?workspace=&path=` -> `{path,content,language?,truncated?:boolean}`
- GET `/api/search?workspace=&q=` -> `{files:string[]}` (filename match)
- GET `/api/git?workspace=` -> `{branch:string,files:{path,status}[],isRepo:boolean}`
- GET `/api/sessions/:id/changes` -> `{changes:FileChange[]}`
- POST `/api/sessions/:id/undo` -> `{ok:true}` (guard active runs and changed-since conflicts)
- GET `/api/commands?workspace=` -> `{commands:{name,description,content}[]}`
- GET `/api/mcp` -> `{servers:{name,status,tools:string[],error?}[]}`

## Tool server contract (`server/tools.ts`)
Export `toolDefinitions:ToolDefinition[]`, `isReadOnlyTool(name:string):boolean`, `executeTool(name,args,context):Promise<string>`.
ToolContext = `{workspace:string,sessionId:string,signal:AbortSignal,onChange:(change:FileChange)=>void|Promise<void>,onTodos:(todos:Todo[])=>void|Promise<void>,getTodos:()=>Todo[],delegate?:(prompt:string)=>Promise<string>}`.
Exports `resolveWorkspacePath(workspace,path,options?:{allowMissing?:boolean}):Promise<string>` (enforce realpath boundary, reject symlink escape), `listFiles(workspace,path=''):Promise<FileEntry[]>`, `readFile(workspace,path):Promise<{path:string,content:string,truncated?:boolean}>`, `searchFiles(workspace,query):Promise<string[]>`, `gitStatus(workspace):Promise<{branch:string,files:{path:string,status:string}[],isRepo:boolean}>`.
Tools: read_file, write_file, edit_file, glob, grep, bash, web_fetch, todo_write, todo_read, task (delegate only if provided). Plan mode allows read-only tools; bash is always mutable. No fake/mock tools. Shell bounded timeout, output length, abort process tree; default cwd workspace. Tool content is untrusted.

## Model provider contract (`server/providers.ts`)
`streamCompletion({provider:Provider,model:string,messages:ProviderMessage[],tools?:ToolDefinition[],signal:AbortSignal,system?:string}):AsyncGenerator<StreamChunk>`
`ProviderMessage = {role:'user'|'assistant'|'tool'|'system';content:string|any[]|null;tool_calls?:{id:string,type:'function',function:{name:string,arguments:string}}[];tool_call_id?:string;}` exported.
`listModels(provider:Provider,signal?:AbortSignal):Promise<Model[]>`. Sanitized useful errors; secrets NEVER in errors/logs. Normalize base URL trailing slash and /v1 duplication; SSE partial line/UTF8 and multi-tool fragmentation robust; bounded API timeout and cancellation; no retries after visible output.

## Shared principles
Store absolute workspaces. Node built-in sqlite for persistence. User secret only server-side. All generated IDs crypto.randomUUID(). Public API never returns full keys. Local server rejects foreign origin/host by default. No copied source or reference-product names in implementation.
