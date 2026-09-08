import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, AtSign, Check, ChevronDown, CornerDownLeft, File, Hammer, Image, ListTree, Paperclip, Search, Shield, ShieldCheck, Square, X } from 'lucide-react';
import type { Attachment, Mode, Model, PermissionMode, Settings } from '../../shared/types';
import { api, errorMessage, query } from './api';
import { Modal, SpeedRail } from './ui';

export interface Selection { providerId: string; model: string; mode: Mode; permissionMode: PermissionMode; }
interface Props {
  settings: Settings; selection: Selection; onSelection: (value: Selection) => void;
  onSend: (content: string, attachments: Attachment[]) => Promise<boolean>; onCancel: () => void;
  running: boolean; disabled?: boolean; welcome?: boolean; workspace: string;
  text: string; setText: (value: string) => void; onSettings: () => void;
}
export function Composer({ settings, selection, onSelection, onSend, onCancel, running, disabled, welcome, workspace, text, setText, onSettings }: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeModel = useCallback(() => setModelOpen(false), []);
  const provider = settings.providers.find(p => p.id === selection.providerId);
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
    if (running || disabled || sending || (!text.trim() && !attachments.length)) return;
    setError('');
    if (!selection.model || !selection.providerId) { setModelOpen(true); return; }
    setSending(true);
    try {
      const ok = await onSend(text.trim() || 'Please review the attached files.', attachments);
      if (ok) { setText(''); setAttachments([]); setContextOpen(false); input.current?.focus(); }
    } catch (e) { setError(errorMessage(e)); } finally { setSending(false); }
  }
  async function addFiles(selected: FileList | File[]) {
    const additions: Attachment[] = [];
    setError('');
    for (const file of Array.from(selected)) {
      if (file.size > 3 * 1024 * 1024) { setError(`${file.name} exceeds the 3 MB attachment limit.`); continue; }
      if (attachments.length + additions.length >= 6) { setError('Attach up to 6 files per message.'); break; }
      if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file); });
        additions.push({ name: file.name, mimeType: file.type, dataUrl });
      } else {
        const content = await file.text();
        if (content.includes('\0')) { setError(`${file.name} is a binary file. Attach an image or a text file instead.`); continue; }
        additions.push({ name: file.name, mimeType: file.type || 'text/plain', content });
      }
    }
    setAttachments(a => [...a, ...additions].slice(0, 6));
  }
  function addContext(path: string) {
    if (attachments.length >= 6) { setError('Attach up to 6 files per message.'); return; }
    setAttachments(a => a.some(v => v.path === path) ? a : [...a, { name: path.split('/').at(-1) || path, path }]);
    if (/@[^\s]*$/.test(text)) setText(text.replace(/@[^\s]*$/, ''));
    setContextOpen(false); setContextQuery(''); input.current?.focus();
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (contextOpen && files.length) addContext(files[0]); else void send(); }
    if (e.key === 'Escape') setContextOpen(false);
  }
  return <>
    <div className={`composer ${welcome ? 'welcome-composer' : ''} ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={e => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files).catch(e => setError(errorMessage(e))); }}>
      {dragging && <div className="drop-overlay"><Paperclip size={22} />Drop files to add context</div>}
      {attachments.length > 0 && <div className="attachments">{attachments.map((a, i) => <div className="attachment-chip" key={`${a.name}-${i}`} title={a.path || a.name}>{a.dataUrl ? <Image size={13} /> : <File size={13} />}<span>{a.path || a.name}</span><button aria-label={`Remove ${a.name}`} onClick={() => setAttachments(v => v.filter((_, n) => n !== i))}><X size={12} /></button></div>)}</div>}
      <label className="sr-only" htmlFor="message-input">Message Lite</label><textarea ref={input} id="message-input" placeholder={welcome ? 'What do you want to build?' : running ? 'Draft your next message while Lite works…' : 'Ask a follow-up, or start something new…'} value={text} rows={welcome ? 3 : 2} onKeyDown={onKey} disabled={disabled} onChange={e => { setText(e.target.value); const mention = e.target.value.match(/(?:^|\s)@([^\s]*)$/); if (mention) { setContextOpen(true); setContextQuery(mention[1]); } else setContextOpen(false); }} />
      {contextOpen && <div className="context-picker"><div className="context-search"><Search size={15} /><input autoFocus aria-label="Search workspace files" placeholder="Find a file in your workspace…" value={contextQuery} onChange={e => setContextQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setContextOpen(false); input.current?.focus(); } if (e.key === 'Enter' && files.length) { e.preventDefault(); addContext(files[0]); } }} /><button className="icon-button" aria-label="Close file picker" onClick={() => setContextOpen(false)}><X size={14} /></button></div>{fileLoading ? <div className="picker-empty"><SpeedRail compact active />Finding files…</div> : files.length ? <div className="context-results">{files.slice(0, 30).map(f => <button key={f} onClick={() => addContext(f)}><File size={14} /><span>{f}</span>{attachments.some(a => a.path === f) && <Check size={14} />}</button>)}</div> : <div className="picker-empty">No files found. Try a different name.</div>}</div>}
      <div className="composer-toolbar"><div className="composer-tools">
        <div className="mode-switch" role="group" aria-label="Agent mode"><button className={selection.mode === 'build' ? 'selected' : ''} aria-pressed={selection.mode === 'build'} disabled={running || sending} onClick={() => onSelection({ ...selection, mode: 'build' })}><Hammer size={13} />Build</button><button className={selection.mode === 'plan' ? 'selected' : ''} aria-pressed={selection.mode === 'plan'} disabled={running || sending} onClick={() => onSelection({ ...selection, mode: 'plan' })}><ListTree size={14} />Plan</button></div>
        <span className="toolbar-divider" />
        <button className="model-trigger" onClick={() => setModelOpen(true)} disabled={running || sending} title={`${provider?.name || 'Choose provider'} · ${selection.model || 'Choose model'}`}><span className="model-dot" /><span>{selection.model?.split('/').at(-1) || 'Select model'}</span><ChevronDown size={12} /></button>
      </div><div className="composer-actions"><input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Attach files" onChange={e => { if (e.target.files) void addFiles(e.target.files).catch(e => setError(errorMessage(e))); e.target.value = ''; }} /><button className="icon-button attach-button" title="Attach files" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Paperclip size={17} /></button><button className="icon-button context-button" title="Add workspace file" aria-label="Add workspace file context" onClick={() => { setContextOpen(v => !v); setContextQuery(''); }}><AtSign size={17} /></button>
        {running ? <button className="send-button stop" aria-label="Stop generation" title="Stop generation" onClick={onCancel}><Square size={14} fill="currentColor" /></button> : <button className="send-button" aria-label="Send message" title="Send message (Enter)" disabled={disabled || sending || (!text.trim() && !attachments.length)} onClick={() => void send()}>{sending ? <span className="send-loading" /> : <ArrowUp size={20} />}</button>}
      </div></div>
    </div>
    <div className="composer-below"><details className="permission-select"><summary><Shield size={12} />{selection.mode === 'plan' ? 'Read-only plan' : selection.permissionMode === 'ask' ? 'Ask before changes' : 'Auto-approve changes'}<ChevronDown size={10} /></summary><div className="permission-menu"><strong>Permissions</strong><button disabled={running || sending} onClick={e => { onSelection({ ...selection, permissionMode: 'ask' }); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Shield size={16} /><span>Ask before changes<small>Review edits and commands first</small></span>{selection.permissionMode === 'ask' && <Check size={14} />}</button><button disabled={running || sending} onClick={e => { onSelection({ ...selection, permissionMode: 'auto' }); e.currentTarget.closest('details')?.removeAttribute('open'); }}><ShieldCheck size={16} /><span>Auto-approve<small>Allow edits and shell commands</small></span>{selection.permissionMode === 'auto' && <Check size={14} />}</button></div></details><span className="enter-hint"><CornerDownLeft size={11} />Send<span>·</span>Shift + Enter for a new line</span></div>
    {error && <div className="inline-alert" role="alert">{error}<button className="icon-button" aria-label="Dismiss attachment error" onClick={() => setError('')}><X size={13} /></button></div>}
    {modelOpen && <ModelPicker settings={settings} selection={selection} onChange={onSelection} onClose={closeModel} onSettings={onSettings} />}
  </>;
}

function ModelPicker({ settings, selection, onChange, onClose, onSettings }: { settings: Settings; selection: Selection; onChange: (s: Selection) => void; onClose: () => void; onSettings: () => void }) {
  const [providerId, setProviderId] = useState(selection.providerId || settings.providers[0]?.id || '');
  const [search, setSearch] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setLoading(true); setError(''); setModels([]);
    if (!providerId) { setLoading(false); return; }
    api<{ models: Model[]; error?: string }>(`/models?${query({ providerId })}`).then(r => { if (alive) { setModels(r.models); setError(r.error ?? ''); } }).catch(e => { if (alive) setError(errorMessage(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [providerId]);
  const configured = settings.providers.find(p => p.id === providerId)?.models ?? [];
  const all = [...models, ...configured.filter(id => id && !models.some(m => m.id === id)).map(id => ({ id, name: id, providerId }))];
  const filtered = all.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
  function choose(model: string) { onChange({ ...selection, providerId, model }); onClose(); }
  return <Modal title="Choose a model" onClose={onClose}><div className="model-picker"><label>Provider<select value={providerId} onChange={e => { setProviderId(e.target.value); setSearch(''); }}>{settings.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><div className="search-field"><Search size={16} /><input placeholder="Search models or enter a model ID…" aria-label="Search models" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && search.trim()) choose(search.trim()); }} /></div>
    {loading && <SpeedRail active compact />}{error && <p className="field-hint error-text">{error} You can still enter a model ID manually.</p>}
    <div className="model-list">{filtered.map(m => <button key={m.id} onClick={() => choose(m.id)}><span className="model-dot" /><span><strong>{m.name}</strong>{m.name !== m.id && <small>{m.id}</small>}</span>{m.id === selection.model && providerId === selection.providerId && <Check size={16} />}</button>)}{!loading && !filtered.length && <div className="picker-empty">{search ? 'No matching models.' : 'No models discovered. Enter a model ID above or check your provider settings.'}</div>}{search.trim() && !all.some(m => m.id === search.trim()) && <button className="custom-model" onClick={() => choose(search.trim())}>Use <strong>{search.trim()}</strong><CornerDownLeft size={14} /></button>}</div>
    <button className="text-button" onClick={() => { onClose(); onSettings(); }}>Manage providers and API keys</button>
  </div></Modal>;
}
