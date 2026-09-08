import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, Check, ChevronRight, Clock3, File, GitFork, Shield, Terminal, X } from 'lucide-react';
import type { Message, PermissionRequest, SessionDetail, ToolCall } from '../../shared/types';
import { CopyButton, Logo, SpeedRail } from './ui';

export function Markdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre({ children, ...props }) { return <div className="code-block"><pre {...props}>{children}</pre><CopyCode>{children}</CopyCode></div>; },
    a({ children, ...props }) { return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>; },
    table({ children, ...props }) { return <div className="markdown-table"><table {...props}>{children}</table></div>; },
    img({ src, alt }) { return <a href={src} target="_blank" rel="noopener noreferrer" className="image-link">{alt || 'View image'} ↗</a>; },
  }}>{content}</ReactMarkdown>;
}
function CopyCode({ children }: { children: React.ReactNode }) {
  function text(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    if (node && typeof node === 'object' && 'props' in node) return text((node.props as { children: React.ReactNode }).children);
    return '';
  }
  return <CopyButton text={text(children).replace(/\n$/, '')} label="Copy code" />;
}
const toolLabels: Record<string, string> = { read_file: 'Read file', write_file: 'Write file', edit_file: 'Edit file', glob: 'Find files', grep: 'Search code', bash: 'Run command', web_fetch: 'Fetch page', todo_write: 'Update plan', todo_read: 'Read plan', task: 'Delegate task' };
function ToolCard({ tool }: { tool: ToolCall }) {
  const working = tool.status === 'running' || tool.status === 'pending';
  const title = tool.args?.path || tool.args?.command || tool.args?.pattern || tool.args?.url;
  return <details className={`tool-card ${working ? 'working' : ''} ${tool.status === 'error' ? 'failed' : ''}`}><summary><span className="tool-status">{working ? <span className="working-dot" /> : tool.status === 'completed' ? <Check size={13} /> : <X size={13} />}</span><span className="tool-name">{toolLabels[tool.name] || tool.name}</span><span className="tool-summary">{typeof title === 'string' ? title : tool.status}</span><ChevronRight size={13} className="disclosure-chevron" /></summary><div className="tool-body"><div className="tool-section-title">Arguments</div><pre>{JSON.stringify(tool.args, null, 2)}</pre>{tool.output !== undefined && <><div className="tool-section-title">{tool.status === 'error' ? 'Error' : 'Result'}<CopyButton text={tool.output} /></div><pre>{tool.output || '(No output)'}</pre></>}{working && <SpeedRail compact active />}</div></details>;
}
function Approval({ request, onDecide, busy }: { request: PermissionRequest; onDecide: (id: string, decision: 'allow' | 'always' | 'deny') => void; busy: boolean }) {
  return <section className="approval" aria-label="Permission requested"><div className="approval-heading"><span><Shield size={17} /></span><div><strong>A quick check before I continue.</strong><p>{request.description || `${toolLabels[request.tool] || request.tool} needs your permission.`}</p></div></div><details><summary>Review {toolLabels[request.tool]?.toLowerCase() || request.tool}<ChevronRight size={13} /></summary><pre>{JSON.stringify(request.args, null, 2)}</pre></details><div className="approval-actions"><button className="button secondary" disabled={busy} onClick={() => onDecide(request.id, 'deny')}>Deny</button><button className="text-button" title="Remember approval for this tool in this session, including future runs. Revoke in Session actions." disabled={busy} onClick={() => onDecide(request.id, 'always')}>Always allow this tool</button><button className="button primary" disabled={busy} onClick={() => onDecide(request.id, 'allow')}>Allow once<Check size={14} /></button></div></section>;
}
export function Conversation({ detail, connection, onDecide, onFork, busy }: { detail: SessionDetail; connection: 'connecting' | 'connected' | 'reconnecting'; onDecide: (id: string, decision: 'allow' | 'always' | 'deny') => void; onFork: (messageId: string) => void; busy: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const running = detail.session.status === 'running' || detail.session.status === 'waiting';
  const last = detail.messages.at(-1);
  useEffect(() => { if (atBottom && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [detail.messages, detail.permissions, atBottom]);
  return <div className="conversation-shell"><div className="conversation-scroll" ref={scroll} onScroll={e => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="conversation-content">
    <div className="conversation-start"><span />{new Date(detail.session.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}<span /></div>
    {detail.messages.filter(m => m.role !== 'tool').map(message => <MessageView key={message.id} message={message} running={running && message.id === last?.id} onFork={() => onFork(message.id)} disabled={busy || running} />)}
    {!detail.messages.length && <div className="session-empty"><Logo /><h2>A fresh start.</h2><p>Give your agent a task. It will work in this session’s workspace.</p></div>}
    {detail.permissions.map(request => <Approval key={request.id} request={request} onDecide={onDecide} busy={busy} />)}
    {running && <div className="run-status" role="status"><SpeedRail compact active /><span>{detail.session.status === 'waiting' ? 'Waiting for your approval' : detail.session.mode === 'plan' ? 'Exploring and planning' : 'Working on it'}<span className="animated-ellipsis">…</span></span></div>}
    {connection !== 'connected' && <div className="connection-status" role="status"><Clock3 size={13} />{connection === 'reconnecting' ? 'Reconnecting to your session… Your run continues on the server.' : 'Connecting to live updates…'}</div>}
  </div></div>{!atBottom && <button className="scroll-bottom" onClick={() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); setAtBottom(true); }}><ArrowDown size={14} />Jump to latest</button>}</div>;
}
function MessageView({ message, running, onFork, disabled }: { message: Message; running: boolean; onFork: () => void; disabled: boolean }) {
  if (message.role === 'system') return <div className="system-message"><Terminal size={12} />{message.content}</div>;
  const assistant = message.role === 'assistant';
  return <article className={`message ${assistant ? 'assistant-message' : 'user-message'}`} aria-label={assistant ? 'Assistant message' : 'Your message'}>
    {assistant && <div className="message-byline"><Logo small /><span>Lite</span>{running && <span className="message-live">Working</span>}</div>}
    <div className="message-body">{running && message.activity && <div className="connection-status" role="status">{message.activity}</div>}{message.reasoning && <details className="thinking"><summary><span className={running ? 'thinking-active' : ''} />Thinking<ChevronRight size={13} /></summary><div className="markdown"><Markdown content={message.reasoning} /></div></details>}
      {message.content && <div className="markdown"><Markdown content={message.content} /></div>}
      {message.attachments && message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((a, i) => a.dataUrl?.startsWith('data:image/') ? <a href={a.dataUrl} target="_blank" rel="noopener noreferrer" key={i}><img src={a.dataUrl} alt={a.name} /><span>{a.name}</span></a> : <span key={i}><File size={13} />{a.path || a.name}</span>)}</div>}
      {message.toolCalls && message.toolCalls.length > 0 && <div className="tool-cards">{message.toolCalls.map(t => <ToolCard tool={t} key={t.id} />)}</div>}
      {message.error && <div className="inline-alert" role="alert">{message.error}</div>}
    </div>
    {assistant && !running && <div className="message-actions"><CopyButton text={message.content} /><button className="icon-button" onClick={onFork} disabled={disabled} aria-label="Fork session at this message" title="Fork from here"><GitFork size={13} /></button>{message.usage && <span className="usage" title="Reported by your model provider">{message.usage.outputTokens.toLocaleString()} tokens{message.usage.durationMs ? ` · ${(message.usage.durationMs / 1000).toFixed(1)}s` : ''}{message.usage.cost !== undefined ? ` · $${message.usage.cost.toFixed(4)}` : ''}</span>}</div>}
  </article>;
}
