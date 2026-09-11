import { cacheHitLabel, usagePhase } from '../../shared/usage';
import { shuntLabel } from '../../shared/shunt';
import { conversationBlocks } from './conversation-blocks';
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { QuestionRequest } from '../../shared/questions';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, Check, ChevronRight, Clock3, File, GitFork, Shield, Terminal, X } from 'lucide-react';
import type { Message, PermissionRequest, SessionDetail, ToolCall, Usage } from '../../shared/types';
import { CopyButton, Logo, LiteSpeed } from './ui';
import { withoutVerificationNotice } from '../../shared/verification';
import { executionFailed } from '../../shared/receipts';

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre({ children, ...props }) { return <div className="code-block"><pre {...props}>{children}</pre><CopyCode>{children}</CopyCode></div>; },
    a({ children, ...props }) { return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>; },
    table({ children, ...props }) { return <div className="markdown-table"><table {...props}>{children}</table></div>; },
    img({ src, alt }) { return <a href={src} target="_blank" rel="noopener noreferrer" className="image-link">{alt || 'View image'} ↗</a>; },
  }}>{content}</ReactMarkdown>;
});
function CopyCode({ children }: { children: React.ReactNode }) {
  function text(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    if (node && typeof node === 'object' && 'props' in node) return text((node.props as { children: React.ReactNode }).children);
    return '';
  }
  return <CopyButton text={text(children).replace(/\n$/, '')} label="Copy code" />;
}
const toolLabels: Record<string, string> = { bulk_read:'Shunt reader',code_write:'Shunt writer', read_file: 'Read file', write_file: 'Write file', edit_file: 'Edit file', glob: 'Find files', grep: 'Search code', bash: 'Run command', web_fetch: 'Fetch page', web_search: 'Search web', view_image: 'View image', todo_write: 'Update plan', todo_read: 'Read plan', task: 'Research task', sidekick: 'Sidekick', delegate: 'Worker', verify: 'Driver verification', takeover: 'Driver takeover', ask_user: 'Ask a question', history_search: 'Search history', memory_remember: 'Remember fact', memory_forget: 'Forget fact', memory_recall: 'Recall memory' };
function ToolCard({ tool }: { tool: ToolCall }) {
  const working = tool.status === 'running' || tool.status === 'pending' || tool.execution?.status === 'running';
  const failed = tool.status === 'error' || executionFailed(tool.execution);
  if(tool.shunt||tool.routing||tool.name==='bulk_read'||tool.name==='code_write')return <section className={`shunt-operation${tool.status==='error'||tool.status==='denied'?' failed':''}`} aria-label={tool.shunt?.kind==='writer'||tool.name==='code_write'?'Shunt writer':'Shunt reader'}>
    <div className="shunt-operation-heading">{working?<span className="working-dot"/>:tool.status==='completed'?<Check size={13}/>:<X size={13}/>}<span>{shuntLabel(tool)}</span></div>
    {typeof tool.args.question==='string'&&<p className="shunt-question">{String(tool.args.question)}</p>}
    {tool.output&&<div className="shunt-answer"><Markdown content={tool.output}/></div>}
    {tool.shunt&&<details className="shunt-sources"><summary>{tool.shunt.sources.length} source{tool.shunt.sources.length===1?'':'s'}{tool.shunt.target?` → ${tool.shunt.target}`:''}</summary>{tool.shunt.sources.map((source,index)=><div key={index}><code>{source.path}</code> · {source.lines} lines · {source.bytes} bytes<small>sha256 {source.sha256}</small></div>)}</details>}
  </section>;
  const title = tool.waitingForWorkspace || tool.args?.path || tool.args?.command || tool.args?.pattern || tool.args?.url;
  // Sidecar interception is VISIBLE by design (design note 4.5): the summary
  // row is tagged with the interceptor's name, and the expanded body shows the
  // unmodified original arguments above the (modified) executed ones.
  return <details className={`tool-card ${working ? 'working' : ''} ${failed ? 'failed' : ''}`}><summary><span className="tool-status">{working ? <span className="working-dot" /> : tool.status === 'completed' && !failed ? <Check size={13} /> : <X size={13} />}</span><span className="tool-name">{toolLabels[tool.name] || tool.name}</span><span className="tool-summary">{typeof title === 'string' ? title : ''}</span>{tool.execution?.exitCode !== undefined && tool.execution.exitCode !== 0 && <span>exit {tool.execution.exitCode}</span>}{tool.intercepted && <span className="tool-intercepted-tag" title={tool.intercepted.reason}>modified by {tool.intercepted.by}</span>}<ChevronRight size={13} className="disclosure-chevron" /></summary><div className="tool-body">{tool.intercepted && <><div className="tool-section-title">Original arguments</div><pre>{JSON.stringify(tool.intercepted.originalArgs, null, 2)}</pre></>}<div className="tool-section-title">Arguments</div><pre>{JSON.stringify(tool.args, null, 2)}</pre>{tool.output !== undefined && <><div className="tool-section-title">{failed ? 'Error' : 'Result'}<CopyButton text={tool.output} /></div><pre>{tool.output || '(No output)'}</pre></>}</div></details>;
}
function Approval({ request, onDecide, onAllowAll, busy }: { request: PermissionRequest; onDecide: (id: string, decision: 'allow' | 'always' | 'deny') => void; onAllowAll?: () => void; busy: boolean }) {
  const forced = request.ruleMatch?.decision === 'ask';
  return <section className="approval" aria-label="Permission requested">
    <div className="approval-heading"><span><Shield size={17} /></span><div><strong>Permission to continue</strong><p>{request.description || `${toolLabels[request.tool] || request.tool} needs your permission.`}</p></div></div>
    <details><summary>Review {toolLabels[request.tool]?.toLowerCase() || request.tool}<ChevronRight size={13} /></summary><pre>{JSON.stringify(request.args, null, 2)}</pre></details>
    {forced && <p className="field-hint">An explicit {request.ruleMatch!.source} rule requires approval each time.</p>}
    <div className="approval-actions"><button className="button secondary" disabled={busy} onClick={() => onDecide(request.id, 'deny')}>Deny</button>{!forced && <button className="text-button" title={request.scopePath ? `Remember this tool at ${request.scopePath} for this session and its workers.` : 'Remember this tool for this session and its workers.'} disabled={busy} onClick={() => onDecide(request.id, 'always')}>{request.scopePath ? 'Allow at this path' : 'Allow this tool for session'}</button>}<button className="button primary" disabled={busy} onClick={() => onDecide(request.id, 'allow')}>Allow once<Check size={14} /></button></div>
    {!forced && onAllowAll && <div className="approval-mode"><button className="text-button" disabled={busy} onClick={onAllowAll}>Allow all tools</button><span>For this session and its workers</span></div>}
  </section>;
}
export function Conversation({ detail, connection, onDecide, onAllowAll, onFork, renderQuestion, renderTask, busy, readOnly = false, inline = false }: { detail: SessionDetail; connection: 'connecting' | 'connected' | 'reconnecting'; onDecide: (id: string, decision: 'allow' | 'always' | 'deny') => void; onAllowAll?: () => void; onFork: (messageId: string) => void; renderQuestion: (question: QuestionRequest) => ReactNode; renderTask?: (tool: ToolCall, message: Message, expanded: boolean) => ReactNode; busy: boolean; readOnly?: boolean; inline?: boolean }) {
  const [expandedSteps, setExpandedSteps] = useState<Map<string,boolean>>(() => new Map());
  const scroll = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const running = detail.session.status === 'running' || detail.session.status === 'waiting';
  const last = detail.messages.filter(message => message.role !== 'tool').at(-1);
  const groups = conversationBlocks(detail.messages);
  const tasks=detail.delegations?.filter(task=>task.status==='running')??[];
  const workActivity=detail.permissions.length||detail.questions?.length?false:tasks.length>1?`${tasks.length} workers running`:tasks.length===1?`${tasks[0].role?tasks[0].role[0].toUpperCase()+tasks[0].role.slice(1):'Research'} · ${tasks[0].activity??tasks[0].description}`:undefined;
  const hasWork = groups.at(-1)?.closesTranscript && groups.at(-1)?.steps.some(message => message.reasoning || message.toolCalls?.length);
  useLayoutEffect(() => { if (!inline && atBottom && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [detail.messages, detail.permissions, detail.questions, atBottom, inline]);
  useLayoutEffect(() => {
    const viewport = scroll.current, content = viewport?.firstElementChild;
    if (inline || !atBottom || !viewport || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { viewport.scrollTop = viewport.scrollHeight; });
    observer.observe(content); return () => observer.disconnect();
  }, [atBottom, inline]);
  return <div className="conversation-shell"><div className="conversation-scroll" ref={scroll} onScroll={e => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="conversation-content">
    <div className="conversation-start"><span />{new Date(detail.session.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}<span /></div>
    {groups.map(({ message, startsRun, endsRun, closesTranscript, runUsage, steps }, index) => <MessageView driver={!inline && Boolean(detail.session.architecture)} workerNoun={detail.session.architecture?.kind === 'expert-fusion' ? 'expert' : 'worker'} key={message.id} message={message} running={running && message.id === last?.id} grouped={message.role === 'assistant' && !startsRun} tail={endsRun} live={running && closesTranscript && index === groups.length - 1} runUsage={runUsage} steps={steps} expanded={expandedSteps.get(message.id)??inline} onExpand={open => setExpandedSteps(current => { const next = new Map(current); next.set(message.id,open); return next; })} inline={inline} workActivity={workActivity} onFork={() => onFork(message.id)} disabled={busy || running} readOnly={readOnly} renderTask={readOnly ? undefined : renderTask} />)}
    {!detail.messages.length && <div className="session-empty"><Logo /><h2>{readOnly ? 'No transcript yet.' : 'A fresh start.'}</h2><p>{readOnly ? 'Research messages will appear here when available. This view cannot start a run.' : 'Give your agent a task. It will work in this session’s workspace.'}</p></div>}
    {!readOnly && detail.questions?.map(renderQuestion)}
    {!readOnly && detail.permissions.map(request => <Approval key={request.id} request={request} onDecide={onDecide} onAllowAll={onAllowAll} busy={busy} />)}
    {running && !last?.content && !last?.reasoning && !hasWork && !detail.permissions.length && !detail.questions?.length && <div className="run-status" role="status"><LiteSpeed compact active /><span>{detail.session.status === 'waiting' ? detail.questions?.length ? 'Waiting for your answer' : 'Waiting for your approval' : detail.session.mode === 'plan' ? 'Exploring and planning' : last?.activity || 'Working'}<span className="animated-ellipsis">…</span></span></div>}
    {connection !== 'connected' && <div className="connection-status" role="status"><Clock3 size={13} />{connection === 'reconnecting' ? 'Reconnecting to your session… Your run continues on the server.' : 'Connecting to live updates…'}</div>}
  </div></div>{!atBottom && <button className="scroll-bottom" aria-label="Jump to latest" title="Jump to latest" onClick={() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); setAtBottom(true); }}><ArrowDown size={16} /></button>}</div>;
}
/** Show work live, then fold the completed block when prose continues. */
function WorkLog({ workerNoun, messages, live, renderTask, workActivity, expanded, onExpand }: { expanded: boolean; onExpand: (open: boolean) => void; messages: Message[]; live: boolean; workerNoun: string; workActivity?: string|false; renderTask?: (tool: ToolCall, message: Message, expanded: boolean) => ReactNode }) {
  const calls = messages.flatMap(message => (message.toolCalls ?? []).map(tool => ({ tool, message })));
  const thinking = messages.filter(message => message.reasoning);
  if (!calls.length && !thinking.length) return null;
  const current = calls.findLast(({ tool }) => tool.status === 'running' || tool.status === 'pending')?.tool;
  const working = live && workActivity!==false && Boolean(current || !messages.at(-1)?.content);
  const visible = live || expanded;
  const action = current && (current.args?.description || current.args?.path || current.args?.command || current.args?.pattern);
  const workers = calls.filter(({tool}) => tool.name === 'delegate');
  const runningWorkers = workers.filter(({tool}) => tool.status === 'running').length;
  const queuedWorkers = workers.filter(({tool}) => tool.status === 'pending').length;
  const workerStates = [runningWorkers && `${runningWorkers} running`, queuedWorkers && `${queuedWorkers} queued`].filter(Boolean).join(' · ');
  const label = workers.length ? `${workers.length} ${workerNoun}${workers.length === 1 ? '' : 's'}${working && workerStates ? ` · ${workerStates}` : ''}${calls.length > workers.length ? ` · ${calls.length - workers.length} other steps` : ''}` : working ? workActivity || (current ? `${toolLabels[current.name] || (current.name === 'sidekick' ? 'Sidekick' : current.name)}${typeof action === 'string' ? ` · ${action}` : ''}` : 'Thinking') : calls.length ? `${calls.length} ${calls.length === 1 ? 'step' : 'steps'}` : 'Thought process';
  const failed = calls.filter(({ tool }) => tool.status === 'error' || tool.status === 'denied').length;
  const modified = calls.filter(({ tool }) => tool.intercepted).length;
  return <details className={`work-log${working ? ' active' : ''}`} aria-label="Response steps" open={visible}>
    <summary onClick={event => { event.preventDefault(); if (!live) onExpand(!expanded); }}>{working ? <span className="working-dot" /> : <Check size={13} />}<span>{label}</span>{failed > 0 && <span className="work-warning">{failed} {failed === 1 ? 'issue' : 'issues'}</span>}{modified > 0 && <span className="work-warning">{modified} modified {modified === 1 ? 'tool' : 'tools'}</span>}<ChevronRight size={13} className="disclosure-chevron" /></summary>
    <div className="work-log-body">
      {messages.map(message => <div key={message.id}>{message.reasoning && <div className="thinking-inline markdown"><Markdown content={message.reasoning} /></div>}
        {toolGroups(message.toolCalls ?? []).map(group => group[0].name === 'delegate' ? <div className="worker-grid" key={group[0].id}>{group.map(tool => <div key={tool.id}>{renderTask?.(tool, message, visible) ?? <ToolCard tool={tool} />}</div>)}</div> : group.map(tool => <div key={tool.id}>{renderTask?.(tool, message, visible) ?? <ToolCard tool={tool} />}</div>))}
      </div>)}
    </div>
  </details>;
}
/** Keep adjacent workers together without moving them across driver tool calls. */
function toolGroups(tools: ToolCall[]): ToolCall[][] {
  const groups: ToolCall[][] = [];
  for (const tool of tools) {
    const previous = groups.at(-1);
    if (tool.name === 'delegate' && previous?.[0].name === 'delegate') previous.push(tool);
    else groups.push([tool]);
  }
  return groups;
}
function MessageView({ driver, workerNoun, message, running, grouped, tail, live, runUsage, steps, workActivity, onFork, disabled, readOnly, renderTask, inline, expanded, onExpand }: { expanded: boolean; onExpand: (open: boolean) => void; driver: boolean; workerNoun: string; message: Message; running: boolean; grouped: boolean; tail: boolean; live: boolean; runUsage?: Usage; steps: Message[]; workActivity?: string|false; onFork: () => void; disabled: boolean; readOnly?: boolean; inline?: boolean; renderTask?: (tool: ToolCall, message: Message, expanded: boolean) => ReactNode }) {
  const steering = message.role === 'system' && message.content.startsWith('[Steering] ');
  if (steering) message = { ...message, content: message.content.replace(/^\[Steering\] (?:The user sent this note to the running response\. (?:Update the ongoing task using this latest instruction|It supersedes their earlier request in this turn; follow it as the user's latest instruction)|This user note arrived before the response ended and still needs attention|The user sent this note before the response was interrupted\. It still needs attention): /, '') };
  if (message.role === 'system' && !steering) return <div className="system-message"><Terminal size={12} />{message.content}</div>;
  const assistant = message.role === 'assistant';
  const content = assistant ? withoutVerificationNotice(message.content, message.receipts) : message.content;
  return <article className={`message ${assistant ? 'assistant-message' : 'user-message'}${grouped ? ' grouped' : ''}`} aria-label={assistant ? 'Assistant message' : inline ? 'Assignment from driver' : 'Your message'}>
    {assistant && !grouped && <div className="message-byline"><Logo small /><span>Litespeed</span></div>}
    <div className="message-body">{assistant && driver && (message.content || !message.toolCalls?.some(tool => tool.name === 'delegate' || tool.name === 'sidekick')) && <div className="driver-identity">Driver</div>}{steering && <span className="steering-label">Steering</span>}
      {content && (inline && !assistant ? <details className="task-assignment"><summary>Assignment from driver</summary><div className="markdown"><Markdown content={content} /></div></details> : <div className="markdown"><Markdown content={content} /></div>)}
      {assistant && <WorkLog workerNoun={workerNoun} expanded={expanded} onExpand={onExpand} messages={steps} live={live} renderTask={renderTask} workActivity={workActivity} />}
      {message.attachments && message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((a, i) => a.dataUrl?.startsWith('data:image/') ? <a href={a.dataUrl} target="_blank" rel="noopener noreferrer" key={i}><img src={a.dataUrl} alt={a.name} /><span>{a.name}</span></a> : <span key={i}><File size={13} />{a.path || a.name}</span>)}</div>}

      {message.error && <div className="inline-alert" role="alert">{message.error}</div>}
    </div>
    {assistant && tail && !live && !inline && <div className="message-actions"><CopyButton text={content} />{!readOnly && <button className="icon-button" onClick={onFork} disabled={disabled} aria-label="Fork session at this message" title="Fork from here"><GitFork size={13} /></button>}{runUsage && <UsageDetails usage={runUsage} family={steps.at(-1)?.turnUsage} />}</div>}
  </article>;
}

function UsageDetails({usage,family}:{usage:Usage;family?:Message['turnUsage']}) {
  const complete=!family||family.reportedRequests===family.requests;
  const reported=!family||family.reportedRequests>0;
  const rows=new Map<string,{label:string;input:number;output:number;requests:number;reported:number;cached:number;cacheReports:number}>();
  for(const record of family?.breakdown??[]) {
    const key=JSON.stringify([record.providerId,record.model,record.role,record.phase]);
    const row=rows.get(key)??{label:`${record.role==='lead'?'Driver':record.role[0].toUpperCase()+record.role.slice(1)} · ${record.model}${record.phase==='response'?'':` · ${usagePhase(record.phase)}`}`,input:0,output:0,requests:0,reported:0,cached:0,cacheReports:0};
    row.requests++;if(record.usage){row.reported++;row.input+=record.usage.inputTokens;row.output+=record.usage.outputTokens;if(record.usage.cachedTokens!==undefined){row.cached+=record.usage.cachedTokens;row.cacheReports++;}}rows.set(key,row);
  }
  const summary=<>{reported?`${(usage.inputTokens+usage.outputTokens).toLocaleString()} tokens${complete?'':' reported'}`:'Usage unavailable'}{` · ${cacheHitLabel(usage,complete)}`}{usage.durationMs?` · ${(usage.durationMs/1000).toFixed(1)}s`:''}{usage.cost!==undefined?` · $${usage.cost.toFixed(4)}`:''}</>;
  return family?<details className="usage usage-details"><summary title="Cache hit = cached input tokens / total input tokens. Output tokens are excluded.">{summary}</summary><div className="usage-breakdown">{[...rows].map(([key,row])=><div key={key}><strong>{row.label}</strong><span>{row.reported?`${row.input.toLocaleString()} in · ${row.output.toLocaleString()} out`:'Usage not reported'}{` · ${cacheHitLabel({inputTokens:row.input,cachedTokens:row.cached},row.cacheReports===row.requests)}`}{row.reported<row.requests?` · ${row.requests-row.reported} request(s) unreported`:''}</span></div>)}</div></details>:<span className="usage" title="Cache hit = cached input tokens / total input tokens. Output tokens are excluded.">{summary}</span>;
}
