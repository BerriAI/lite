import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, AtSign, Check, ChevronDown, File, Hammer, Image, ListPlus, ListTree, Navigation, Paperclip, Pause, Play, Search, Shield, ShieldCheck, Square, X, Zap } from 'lucide-react';
import type { ArchitectureSelection, Attachment, Mode, ModelReasoning, PermissionMode, QueueState, Settings } from '../../shared/types';
import { architectureInfo, architectureWorker } from '../../shared/architectures';
import { api, errorMessage, query } from './api';
import { SpeedRail } from './ui';
import { ModelPicker } from './ModelPicker';

/** planner: the optional planning half of a planner+executor pair (undefined =
 * untouched, null = explicitly cleared in the next PATCH). outputStyle and
 * architecture follow the same tri-state contract: undefined = untouched,
 * null = cleared. */
export interface Selection { modelReasoning?: ModelReasoning; providerId: string; model: string; mode: Mode; permissionMode: PermissionMode; planner?: { providerId: string; model: string } | null; outputStyle?: string | null; architecture?: ArchitectureSelection | null; }
interface Props {
  settings: Settings; selection: Selection; onSelection: (value: Selection) => void;
  onSend: (content: string, attachments: Attachment[]) => Promise<boolean>; onCancel: () => void;
  onQueue?: (content: string, attachments: Attachment[]) => Promise<boolean>;
  onSteer?: (content: string) => Promise<boolean>;
  queue?: QueueState; queueBusy?: boolean;
  onQueueAction?: (action: 'pause' | 'resume' | 'remove' | 'steer', queueId?: string) => void;
  running: boolean; disabled?: boolean; welcome?: boolean; workspace: string;
  text: string; setText: (value: string) => void;
  attachments: Attachment[]; setAttachments: (value: Attachment[]) => void;
  draftNotice?: string; onSettings: () => void;
  selectionDisabled?: boolean;
  onPermissionMode?: (mode: PermissionMode) => void;
}
export function Composer({ settings, selection, onSelection, onSend, onQueue, onSteer, queue, queueBusy, onQueueAction, onCancel, running, disabled, welcome, workspace, text, setText, attachments, setAttachments, draftNotice, onSettings, selectionDisabled, onPermissionMode }: Props) {
  const [modelOpen, setModelOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const provider = settings.providers.find(p => p.id === selection.providerId);
  const alive = useRef(true);
  const adding = useRef(false);
  const latestDraft = useRef({ text, attachments }); latestDraft.current = { text, attachments };
  const queueCount = queue?.items.length ?? 0;
  const queueMode = Boolean(onQueue && (running || queueCount));
  const queueFull = queueCount >= 20;
  const configDisabled = Boolean(selectionDisabled || disabled || running || sending);
  useEffect(() => { if (running || sending) setModelOpen(false); }, [running, sending]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => {
    if (!contextOpen) return;
    let live = true;
    setFileLoading(true);
    const timer = setTimeout(() => api<{ files: string[] }>(`/search?${query({ workspace, q: contextQuery })}`).then(r => { if (live) setFiles(r.files); }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setFileLoading(false); }), 180);
    return () => { live = false; clearTimeout(timer); };
  }, [contextOpen, contextQuery, workspace]);
  async function send() {
    if ((running && !queueMode) || disabled || sending || adding.current || queueBusy || (queueMode && queueFull) || (!text.trim() && !attachments.length)) return;
    setError('');
    if (!queueMode && (!selection.model || !selection.providerId)) { setModelOpen(true); return; }
    setSending(true);
    try {
      const submit = queueMode ? onQueue! : onSend;
      const ok = await submit(text.trim() || 'Please review the attached files.', attachments);
      if (ok && alive.current) { setContextOpen(false); input.current?.focus(); }
    } catch (e) { if (alive.current) setError(errorMessage(e)); } finally { if (alive.current) setSending(false); }
  }
  // Steering sends the composer text into the RUNNING response (between steps);
  // it never carries attachments and never touches the queue. Kept separate from
  // send() so Enter still queues — steering is an explicit secondary action.
  async function steer() {
    if (!onSteer || !running || disabled || sending || queueBusy || !text.trim()) return;
    if (text.trim().length > 4000) { setError('Steering notes can contain up to 4,000 characters. Shorten this note or add it to the queue.'); return; }
    setError(''); setSending(true);
    try {
      const ok = await onSteer(text.trim());
      if (ok && alive.current) { setText(''); input.current?.focus(); }
    } catch (e) { if (alive.current) setError(errorMessage(e)); } finally { if (alive.current) setSending(false); }
  }
  async function addFiles(selected: FileList | File[]) {
    if (adding.current || disabled || sending) return;
    adding.current = true; setReadingFiles(true); setError('');
    try {
      for (const file of Array.from(selected)) {
        if (file.size > 3 * 1024 * 1024) { setError(`${file.name} exceeds the 3 MiB attachment limit. Use a smaller file or attach a workspace file by path.`); continue; }
        if (latestDraft.current.attachments.length >= 6) { setError('Attach up to 6 files per message.'); break; }
        let attachment: Attachment;
        if (file.type.startsWith('image/')) {
          if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { setError(`${file.name}: use a PNG, JPEG, GIF, or WebP image.`); continue; }
          const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file); });
          attachment = { name: file.name, mimeType: file.type, dataUrl };
        } else {
          const content = await file.text();
          if (content.includes('\0')) { setError(`${file.name} is a binary file. Attach an image or a text file instead.`); continue; }
          if (content.length > 200_000) { setError(`${file.name} exceeds the 200,000 character text attachment limit.`); continue; }
          attachment = { name: file.name, mimeType: file.type || 'text/plain', content };
        }
        if (!alive.current) return;
        const current = latestDraft.current, next = [...current.attachments, attachment];
        // Upload limits are independent of browser persistence: large drafts remain usable in memory.
        latestDraft.current = { ...current, attachments: next }; setAttachments(next);
      }
    } finally { adding.current = false; if (alive.current) setReadingFiles(false); }
  }
  function addContext(path: string) {
    if (disabled || sending) return;
    if (attachments.length >= 6) { setError('Attach up to 6 files per message.'); return; }
    const next = attachments.some(v => v.path === path) ? attachments : [...attachments, { name: path.split('/').at(-1) || path, path }];
    setAttachments(next);
    if (/@[^\s]*$/.test(text)) setText(text.replace(/@[^\s]*$/, ''));
    setContextOpen(false); setContextQuery(''); input.current?.focus();
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (contextOpen && files.length) addContext(files[0]); else void send(); }
    if (e.key === 'Escape') setContextOpen(false);
  }
  return <>
    {queue && queueCount > 0 && <section className="message-queue" aria-label="Queued messages">
      <div className="queue-header"><strong><ListPlus size={14} />Next messages <span>{queueCount}/20</span></strong><span className="queue-status" role="status">{queue.paused ? 'Paused' : running ? 'After this response' : 'Ready'}</span>
        {queueCount > 0 && <button className="text-button" disabled={disabled || queueBusy} onClick={() => onQueueAction?.(queue.paused || !running ? 'resume' : 'pause')}>{queue.paused || !running ? <Play size={12} /> : <Pause size={12} />}{queue.paused || !running ? 'Resume queue' : 'Pause queue'}</button>}
      </div>
      {queue.reason && <p className="queue-reason">{queue.reason}</p>}
      {queueFull && <p className="queue-reason" role="status">Queue is full. Remove a message or resume to make room.</p>}
      {queueCount > 0 && <ol className="queue-items">{queue.items.map((item, index) => <li key={item.id}><span className="queue-position" aria-hidden="true">{index + 1}</span><div className="queue-item-content"><p title={item.content}>{item.content || 'Attached files'}</p>{item.attachments?.length > 0 && <span>{item.attachments.length} attachment{item.attachments.length === 1 ? '' : 's'} · {item.attachments.map(attachment => attachment.name).join(', ')}</span>}</div>{running && <button className="text-button queue-steer" aria-label={`Steer with queued message ${index + 1}`} title="Send this message to the driver now" disabled={disabled || queueBusy || sending} onClick={() => onQueueAction?.('steer', item.id)}><Navigation size={13} />Steer now</button>}<button className="icon-button" aria-label={`Remove queued message ${index + 1}`} disabled={disabled || queueBusy} onClick={() => onQueueAction?.('remove', item.id)}><X size={13} /></button></li>)}</ol>}
    </section>}
    <div className={`composer ${welcome ? 'welcome-composer' : ''} ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files).catch(e => setError(errorMessage(e))); }}>
      {dragging && <div className="drop-overlay"><Paperclip size={22} />Drop files to add context</div>}
      {attachments.length > 0 && <div className="attachments">{attachments.map((a, i) => <div className="attachment-chip" key={`${a.name}-${i}`} title={a.path || a.name}>{a.dataUrl ? <Image size={13} /> : <File size={13} />}<span>{a.path || a.name}</span><button aria-label={`Remove ${a.name}`} disabled={sending} onClick={() => setAttachments(attachments.filter((_, n) => n !== i))}><X size={12} /></button></div>)}</div>}
      <label className="sr-only" htmlFor="message-input">Message Lite</label><textarea ref={input} id="message-input" placeholder={welcome ? 'What do you want to build?' : queueMode ? 'Add the next message to your queue…' : 'Ask a follow-up, or start something new…'} value={text} maxLength={200000} rows={welcome ? 3 : 2} onKeyDown={onKey} disabled={disabled || sending} onChange={e => { setText(e.target.value); const mention = e.target.value.match(/(?:^|\s)@([^\s]*)$/); if (mention) { setContextOpen(true); setContextQuery(mention[1]); } else setContextOpen(false); }} />
      {contextOpen && <div className="context-picker"><div className="context-search"><Search size={15} /><input autoFocus aria-label="Search workspace files" placeholder="Find a file in your workspace…" value={contextQuery} onChange={e => setContextQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setContextOpen(false); input.current?.focus(); } if (e.key === 'Enter' && files.length) { e.preventDefault(); addContext(files[0]); } }} /><button className="icon-button" aria-label="Close file picker" onClick={() => setContextOpen(false)}><X size={14} /></button></div>{fileLoading ? <div className="picker-empty"><SpeedRail compact active />Finding files…</div> : files.length ? <div className="context-results">{files.slice(0, 30).map(f => <button key={f} onClick={() => addContext(f)}><File size={14} /><span>{f}</span>{attachments.some(a => a.path === f) && <Check size={14} />}</button>)}</div> : <div className="picker-empty">No files found. Try a different name.</div>}</div>}
      <div className="composer-toolbar"><div className="composer-tools">
        <div className="mode-switch"><select aria-label="Agent mode" value={selection.mode} disabled={configDisabled} onChange={event => { if (!configDisabled) onSelection({ ...selection, mode: event.target.value as Mode }); }}><option value="build">Build</option><option value="plan">Plan</option></select></div>
        {/* The trigger names the model that will run the NEXT turn: the planner
            on Plan-mode turns when one is set, else the executor (session model). */}
        <button className="model-trigger" onClick={() => setModelOpen(true)} disabled={configDisabled} title={selection.mode === 'build' && selection.architecture ? `${architectureInfo(selection.architecture.kind).name} · ${selection.model || 'none'} + ${architectureWorker(selection.architecture).model}` : selection.mode === 'plan' && selection.planner ? `Planner · ${selection.planner.model} (executor: ${selection.model || 'none'})` : `${provider?.name || 'Choose provider'} · ${selection.model || 'Choose model'}${selection.planner ? ` (+planner: ${selection.planner.model})` : ''}`}><span>{(selection.mode === 'plan' && selection.planner ? selection.planner.model : selection.model)?.split('/').at(-1) || 'Select model'}</span>{selection.mode === 'build' && selection.architecture && <span className="model-companion" title={architectureInfo(selection.architecture.kind).name}>+ {architectureInfo(selection.architecture.kind).roles[0].id}</span>}{selection.mode === 'plan' && selection.planner && <span className="planner-tag">planner</span>}<ChevronDown size={12} /></button>

        <details className="permission-select"><summary><Shield size={12} />{selection.mode === 'plan' ? 'Read only' : selection.permissionMode === 'ask' ? 'Ask first' : 'Allow all tools'}<ChevronDown size={10} /></summary><div className="permission-menu"><strong>Permissions</strong><button disabled={onPermissionMode ? disabled || sending : configDisabled} onClick={e => { if (onPermissionMode) onPermissionMode('ask'); else onSelection({ ...selection, permissionMode: 'ask' }); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Shield size={16} /><span>Ask before changes<small>Review edits and commands first</small></span>{selection.permissionMode === 'ask' && <Check size={14} />}</button><button disabled={onPermissionMode ? disabled || sending : configDisabled} onClick={e => { if (onPermissionMode) onPermissionMode('auto'); else onSelection({ ...selection, permissionMode: 'auto' }); e.currentTarget.closest('details')?.removeAttribute('open'); }}><ShieldCheck size={16} /><span>Allow all tools<small>This session and its workers</small></span>{selection.permissionMode === 'auto' && <Check size={14} />}</button></div></details>
      </div><div className="composer-actions"><input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-label="Attach files" onChange={e => { if (e.target.files) void addFiles(e.target.files).catch(e => setError(errorMessage(e))); e.target.value = ''; }} /><button className="icon-button attach-button" title="Attach files" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button><button className="icon-button context-button" title="Add workspace file" aria-label="Add workspace file context" onClick={() => { setContextOpen(v => !v); setContextQuery(''); }}><AtSign size={17} /></button>
        {onSteer && running && <button className="text-button steer-button" aria-label="Steer the running response" title="Send this note to the driver now" disabled={disabled || sending || queueBusy || !text.trim()} onClick={() => void steer()}><Navigation size={13} />Steer</button>}
        {queueMode ? <button className="send-button queue-send" aria-label="Add to queue" title="Add to queue (Enter)" disabled={disabled || sending || readingFiles || queueBusy || queueFull || (!text.trim() && !attachments.length)} onClick={() => void send()}>{sending ? <span className="send-loading" /> : <ListPlus size={16} />}<span>Queue</span></button> : !running && <button className="send-button" aria-label="Send message" title="Send (Enter) · New line (Shift + Enter)" disabled={disabled || sending || readingFiles || (!text.trim() && !attachments.length)} onClick={() => void send()}>{sending ? <span className="send-loading" /> : <ArrowUp size={20} />}</button>}
        {running && <button className="send-button stop" aria-label="Stop generation" title="Stop generation and pause queued messages" disabled={disabled} onClick={onCancel}><Square size={14} fill="currentColor" /></button>}
      </div></div>
    </div>

    {draftNotice && <div className="draft-notice" role="status">{draftNotice}</div>}
    {error && <div className="inline-alert" role="alert">{error}<button className="icon-button" aria-label="Dismiss attachment error" onClick={() => setError('')}><X size={13} /></button></div>}
    {modelOpen && <ModelPicker disabled={configDisabled} settings={settings} selection={selection} onChange={onSelection} onClose={closeModel} onSettings={onSettings} workspace={workspace} />}
  </>;
}
