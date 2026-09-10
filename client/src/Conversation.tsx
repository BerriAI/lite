import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { QuestionRequest } from '../../shared/questions';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, Check, ChevronRight, Clock3, File, GitFork, Shield, Terminal, X } from 'lucide-react';
import type { Message, PermissionRequest, SessionDetail, ToolCall, Usage } from '../../shared/types';
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
const toolLabels: Record<string, string> = { read_file: 'Read file', write_file: 'Write file', edit_file: 'Edit file', glob: 'Find files', grep: 'Search code', bash: 'Run command', web_fetch: 'Fetch page', web_search: 'Search web', view_image: 'View image', todo_write: 'Update plan', todo_read: 'Read plan', task: 'Delegate task', ask_user: 'Ask a question', history_search: 'Search history', memory_remember: 'Remember fact', memory_forget: 'Forget fact', memory_recall: 'Recall memory' };
function ToolCard({ tool }: { tool: ToolCall }) {
  const working = tool.status === 'running' || tool.status === 'pending';
  const title = tool.args?.path || tool.args?.command || tool.args?.pattern || tool.args?.url;
  // Sidecar interception is VISIBLE by design (design note 4.5): the summary
  // row is tagged with the interceptor's name, and the expanded body shows the
  // unmodified original arguments above the (modified) executed ones.
  return <details className={`tool-card ${working ? 'working' : ''} ${tool.status === 'error' ? 'failed' : ''}`}><summary><span className="tool-status">{working ? <span className="working-dot" /> : tool.status === 'completed' ? <Check size={13} /> : <X size={13} />}</span><span className="tool-name">{toolLabels[tool.name] || tool.name}</span><span className="tool-summary">{typeof title === 'string' ? title : ''}</span>{tool.intercepted && <span className="tool-intercepted-tag" title={tool.intercepted.reason}>modified by {tool.intercepted.by}</span>}<ChevronRight size={13} className="disclosure-chevron" /></summary><div className="tool-body">{tool.intercepted && <><div className="tool-section-title">Original arguments</div><pre>{JSON.stringify(tool.intercepted.originalArgs, null, 2)}</pre></>}<div className="tool-section-title">Arguments</div><pre>{JSON.stringify(tool.args, null, 2)}</pre>{tool.output !== undefined && <><div className="tool-section-title">{tool.status === 'error' ? 'Error' : 'Result'}<CopyButton text={tool.output} /></div><pre>{tool.output || '(No output)'}</pre></>}</div></details>;
}
function Approval({ request, onDecide, busy }: { request: PermissionRequest; onDecide: (id: string, decision: 'allow' | 'always' | 'deny') => void; busy: boolean }) {
  return <section className="approval" aria-label="Permission requested"><div className="approval-heading"><span><Shield size={17} /></span><div><strong>A quick check before I continue.</strong><p>{request.description || `${toolLabels[request.tool] || request.tool} needs your permission.`}</p></div></div><details><summary>Review {toolLabels[request.tool]?.toLowerCase() || request.tool}<ChevronRight size={13} /></summary><pre>{JSON.stringify(request.args, null, 2)}</pre></details><div className="approval-actions"><button className="button secondary" disabled={busy} onClick={() => onDecide(request.id, 'deny')}>Deny</button><button className="text-button" title="Remember approval for this tool in this session, including future runs. Revoke in Session actions." disabled={busy} onClick={() => onDecide(request.id, 'always')}>Always allow this tool</button><button className="button primary" disabled={busy} onClick={() => onDecide(request.id, 'allow')}>Allow once<Check size={14} /></button></div></section>;
}
export function Conversation({ detail, connection, onDecide, onFork, renderQuestion, renderTask, busy, readOnly = false }: { detail: SessionDetail; connection: 'connecting' | 'connected' | 'reconnecting'; onDecide: (id: string, decision: 'allow' | 'always' | 'deny') => void; onFork: (messageId: string) => void; renderQuestion: (question: QuestionRequest) => ReactNode; renderTask?: (tool: ToolCall, message: Message) => ReactNode; busy: boolean; readOnly?: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const running = detail.session.status === 'running' || detail.session.status === 'waiting';
  const last = detail.messages.filter(message => message.role !== 'tool').at(-1);
  const groups = groupRuns(detail.messages);
  const hasWork = groups.findLast(group => group.startsRun && group.closesTranscript)?.steps.some(message => message.reasoning || message.toolCalls?.length);
  useLayoutEffect(() => { if (atBottom && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [detail.messages, detail.permissions, detail.questions, atBottom]);
  return <div className="conversation-shell"><div className="conversation-scroll" ref={scroll} onScroll={e => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="conversation-content">
    <div className="conversation-start"><span />{new Date(detail.session.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}<span /></div>
    {groups.map(({ message, startsRun, endsRun, closesTranscript, runUsage, steps }) => <MessageView key={message.id} message={message} running={running && message.id === last?.id} grouped={message.role === 'assistant' && !startsRun} tail={endsRun} live={running && closesTranscript} runUsage={runUsage} steps={steps} onFork={() => onFork(message.id)} disabled={busy || running} readOnly={readOnly} renderTask={readOnly ? undefined : renderTask} />)}
    {!detail.messages.length && <div className="session-empty"><Logo /><h2>{readOnly ? 'No transcript yet.' : 'A fresh start.'}</h2><p>{readOnly ? 'Research messages will appear here when available. This view cannot start a run.' : 'Give your agent a task. It will work in this session’s workspace.'}</p></div>}
    {!readOnly && detail.questions?.map(renderQuestion)}
    {!readOnly && detail.permissions.map(request => <Approval key={request.id} request={request} onDecide={onDecide} busy={busy} />)}
    {running && !last?.content && !last?.reasoning && !hasWork && !detail.permissions.length && !detail.questions?.length && <div className="run-status" role="status"><SpeedRail compact active /><span>{detail.session.status === 'waiting' ? detail.questions?.length ? 'Waiting for your answer' : 'Waiting for your approval' : detail.session.mode === 'plan' ? 'Exploring and planning' : last?.activity || 'Working'}<span className="animated-ellipsis">…</span></span></div>}
    {connection !== 'connected' && <div className="connection-status" role="status"><Clock3 size={13} />{connection === 'reconnecting' ? 'Reconnecting to your session… Your run continues on the server.' : 'Connecting to live updates…'}</div>}
  </div></div>{!atBottom && <button className="scroll-bottom" aria-label="Jump to latest" title="Jump to latest" onClick={() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); setAtBottom(true); }}><ArrowDown size={16} /></button>}</div>;
}
/** One task = one continuous assistant block. Consecutive assistant messages
 * form a "run": the byline renders once at its head, actions once at its completed tail, and the tail's usage sums the whole run. Each
 * step keeps its own article so per-step fork boundaries and transcript
 * counts still reflect provider rounds. */
function groupRuns(messages: Message[]) {
  const rendered = messages.filter(m => m.role !== 'tool');
  return rendered.map((message, index) => {
    const assistant = message.role === 'assistant';
    const startsRun = assistant && rendered[index - 1]?.role !== 'assistant';
    const endsRun = assistant && rendered[index + 1]?.role !== 'assistant';
    // Every message in the trailing run stays live until the turn finishes.
    const closesTranscript = assistant && rendered.slice(index).every(m => m.role === 'assistant');
    let runUsage: Usage | undefined;
    if (endsRun) {
      for (let i = index; i >= 0 && rendered[i].role === 'assistant'; i--) {
        const usage = rendered[i].usage;
        if (!usage) continue;
        runUsage = runUsage ? {
          inputTokens: runUsage.inputTokens + usage.inputTokens,
          outputTokens: runUsage.outputTokens + usage.outputTokens,
          ...(runUsage.durationMs !== undefined || usage.durationMs !== undefined ? { durationMs: (runUsage.durationMs ?? 0) + (usage.durationMs ?? 0) } : {}),
          ...(runUsage.cost !== undefined || usage.cost !== undefined ? { cost: (runUsage.cost ?? 0) + (usage.cost ?? 0) } : {}),
        } : { ...usage };
      }
    }
    const steps: Message[] = [];
    if (startsRun) for (let i = index; i < rendered.length && rendered[i].role === 'assistant'; i++) steps.push(rendered[i]);
    return { message, startsRun, endsRun, closesTranscript, runUsage, steps };
  });
}
/** Compact host-computed evidence line for a mutating turn, attached under the
 * final assistant message like the context-estimate row. Rendered only when
 * files changed; the copy mirrors the appended [Receipts: …] content notice. */
function ReceiptsRow({ receipts }: { receipts: NonNullable<Message['receipts']> }) {
  const checks = receipts.checksRun.length === 0 ? '· No checks run'
    : receipts.filesChangedAfterLastCheck.length ? `· ${receipts.filesChangedAfterLastCheck.length} file${receipts.filesChangedAfterLastCheck.length === 1 ? '' : 's'} changed after last check`
    : `· Checks: ${receipts.checksRun.at(-1)} ${receipts.checksFailed.includes(receipts.checksRun.at(-1)!) ? '✗' : '✓'}`;
  return <div className="receipts-row" title="Host-computed from tool receipts, not model claims">Changed: {receipts.filesChanged.join(', ')} {checks}</div>;
}
/** The transcript is available on demand; the answer owns the reading surface. */
function WorkLog({ messages, live, renderTask }: { messages: Message[]; live: boolean; renderTask?: (tool: ToolCall, message: Message) => ReactNode }) {
  const calls = messages.flatMap(message => (message.toolCalls ?? []).map(tool => ({ tool, message })));
  const thinking = messages.filter(message => message.reasoning);
  if (!calls.length && !thinking.length) return null;
  const current = calls.findLast(({ tool }) => tool.status === 'running' || tool.status === 'pending')?.tool;
  const working = live && Boolean(current || !messages.at(-1)?.content);
  const action = current && (current.args?.description || current.args?.path || current.args?.command || current.args?.pattern);
  const label = working ? current ? `${toolLabels[current.name] || (current.name === 'sidekick' ? 'Sidekick' : current.name)}${typeof action === 'string' ? ` · ${action}` : ''}` : 'Thinking' : calls.length ? `${calls.length} ${calls.length === 1 ? 'step' : 'steps'}` : 'Thought process';
  const failed = calls.filter(({ tool }) => tool.status === 'error' || tool.status === 'denied').length;
  const modified = calls.filter(({ tool }) => tool.intercepted).length;
  return <details className={`work-log${working ? ' active' : ''}`} aria-label="Response steps">
    <summary>{working ? <span className="working-dot" /> : <Check size={13} />}<span>{label}</span>{failed > 0 && <span className="work-warning">{failed} {failed === 1 ? 'issue' : 'issues'}</span>}{modified > 0 && <span className="work-warning">{modified} modified {modified === 1 ? 'tool' : 'tools'}</span>}<ChevronRight size={13} className="disclosure-chevron" /></summary>
    <div className="work-log-body">
      {messages.map(message => <div key={message.id}>{message.reasoning && <details className="thinking"><summary>Thinking<ChevronRight size={13} /></summary><div className="markdown"><Markdown content={message.reasoning} /></div></details>}
        {message.toolCalls?.map(tool => <div key={tool.id}>{renderTask?.(tool, message) ?? <ToolCard tool={tool} />}</div>)}
      </div>)}
    </div>
  </details>;
}
function MessageView({ message, running, grouped, tail, live, runUsage, steps, onFork, disabled, readOnly, renderTask }: { message: Message; running: boolean; grouped: boolean; tail: boolean; live: boolean; runUsage?: Usage; steps: Message[]; onFork: () => void; disabled: boolean; readOnly?: boolean; renderTask?: (tool: ToolCall, message: Message) => ReactNode }) {
  if (message.role === 'system') return <div className="system-message"><Terminal size={12} />{message.content}</div>;
  const assistant = message.role === 'assistant';
  return <article className={`message ${assistant ? 'assistant-message' : 'user-message'}${grouped ? ' grouped' : ''}`} aria-label={assistant ? 'Assistant message' : 'Your message'}>
    {assistant && !grouped && <div className="message-byline"><Logo small /><span>Lite</span></div>}
    <div className="message-body">{assistant && !grouped && <WorkLog messages={steps} live={live} renderTask={renderTask} />}
      {message.content && <div className="markdown"><Markdown content={message.content} /></div>}
      {message.attachments && message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((a, i) => a.dataUrl?.startsWith('data:image/') ? <a href={a.dataUrl} target="_blank" rel="noopener noreferrer" key={i}><img src={a.dataUrl} alt={a.name} /><span>{a.name}</span></a> : <span key={i}><File size={13} />{a.path || a.name}</span>)}</div>}

      {message.error && <div className="inline-alert" role="alert">{message.error}</div>}
      {assistant && message.receipts && message.receipts.filesChanged.length > 0 && <ReceiptsRow receipts={message.receipts} />}
    </div>
    {assistant && tail && !live && <div className="message-actions"><CopyButton text={message.content} />{!readOnly && <button className="icon-button" onClick={onFork} disabled={disabled} aria-label="Fork session at this message" title="Fork from here"><GitFork size={13} /></button>}{runUsage && <span className="usage" title="Reported by your model provider; totals for this response">{runUsage.outputTokens.toLocaleString()} tokens{runUsage.durationMs ? ` · ${(runUsage.durationMs / 1000).toFixed(1)}s` : ''}{runUsage.cost !== undefined ? ` · $${runUsage.cost.toFixed(4)}` : ''}</span>}</div>}
  </article>;
}
