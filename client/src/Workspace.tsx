import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronRight, Circle, File, FileCode2, Folder, GitBranch, GitCompareArrows, ListTodo, RefreshCw, Undo2, X } from 'lucide-react';
import type { FileChange, FileEntry, Todo } from '../../shared/types';
import { api, errorMessage, query } from './api';
import { CopyButton, EmptyState, Modal, SpeedRail } from './ui';

type Git = { branch: string; files: { path: string; status: string }[]; isRepo: boolean };
export function Workspace({ workspace, sessionId, todos, refreshKey, onClose, onUndo, running }: { workspace: string; sessionId?: string; todos: Todo[]; refreshKey: number; onClose: () => void; onUndo: () => void; running: boolean }) {
  const [tab, setTab] = useState<'files' | 'changes' | 'todos'>('files');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [git, setGit] = useState<Git | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<{ path: string; content: string; language?: string; truncated?: boolean } | null>(null);
  const [previewLoading, setPreviewLoading] = useState('');
  const [change, setChange] = useState<FileChange | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const closeChange = useCallback(() => setChange(null), []);
  useEffect(() => { setPath(''); setPreview(null); setChange(null); }, [workspace]);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    const load = async () => {
      if (tab === 'files') { const r = await api<{ entries: FileEntry[] }>(`/files?${query({ workspace, path })}`); if (live) setEntries(r.entries); }
      else if (tab === 'changes') {
        const [g, c] = await Promise.all([api<Git>(`/git?${query({ workspace })}`), sessionId ? api<{ changes: FileChange[] }>(`/sessions/${sessionId}/changes`) : Promise.resolve({ changes: [] })]);
        if (live) { setGit(g); setChanges(c.changes); }
      }
    };
    load().catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workspace, path, tab, sessionId, refreshKey, refresh]);
  async function openFile(file: string) {
    setPreviewLoading(file); setError('');
    try { setPreview(await api(`/file?${query({ workspace, path: file })}`)); } catch (e) { setError(errorMessage(e)); } finally { setPreviewLoading(''); }
  }
  return <aside className="workspace-panel" aria-label="Workspace"><div className="panel-header"><div><Folder size={15} /><strong>Workspace</strong></div><div><button className="icon-button" aria-label="Refresh workspace" onClick={() => setRefresh(v => v + 1)} disabled={loading}><RefreshCw size={14} className={loading ? 'spinning' : ''} /></button><button className="icon-button" aria-label="Close workspace" onClick={onClose}><X size={16} /></button></div></div>
    <div className="workspace-name" title={workspace}>{workspace.split('/').filter(Boolean).at(-1) || workspace}</div>
    <div className="panel-tabs" role="tablist" aria-label="Workspace views">{([{ id: 'files', name: 'Files', Icon: FileCode2 }, { id: 'changes', name: 'Changes', Icon: GitCompareArrows }, { id: 'todos', name: 'Plan', Icon: ListTodo }] as const).map(({ id, name, Icon }) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}><Icon size={14} />{name}{id === 'todos' && todos.length > 0 && <span>{todos.length}</span>}</button>)}</div>
    <div className="panel-body" role="tabpanel" aria-label={tab}>{error && <div className="inline-alert" role="alert">{error}<button className="text-button" onClick={() => setRefresh(v => v + 1)}>Retry</button></div>}
      {loading && <div className="panel-loading"><SpeedRail compact active /><span>Loading {tab}…</span></div>}
      {!loading && tab === 'files' && <><div className="file-breadcrumb"><button onClick={() => setPath('')} aria-label="Workspace root"><Folder size={12} /></button>{path.split('/').filter(Boolean).map((part, i, parts) => <span key={i}><ChevronRight size={11} /><button onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{part}</button></span>)}</div>{entries.length === 0 && !error ? <EmptyState icon={<Folder size={23} />} title="Nothing here yet">This directory has no visible files.</EmptyState> : <div className="file-list">{[...entries].sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)).map(entry => <button key={entry.path} onClick={() => entry.type === 'directory' ? setPath(entry.path) : void openFile(entry.path)} disabled={previewLoading === entry.path} title={entry.path}>{entry.type === 'directory' ? <Folder size={15} className="folder-icon" /> : <File size={15} />}<span>{entry.name}</span>{entry.type === 'directory' ? <ChevronRight size={12} /> : previewLoading === entry.path ? <span className="working-dot" /> : null}</button>)}</div>}</>}
      {!loading && tab === 'changes' && <>{git?.isRepo && <div className="git-branch"><GitBranch size={13} />{git.branch || 'Detached HEAD'}<span>{git.files.length} changed</span></div>}{git && !git.isRepo && <div className="quiet-panel-note">This workspace is not a Git repository. Session file changes still appear below.</div>}
        {changes.length > 0 && <><div className="panel-section-label">Session edits<button className="text-button" disabled={running} onClick={onUndo}><Undo2 size={12} />Undo edits</button></div><div className="file-list changes-list">{changes.map((c, i) => <button key={`${c.path}-${i}`} onClick={() => setChange(c)}><span className={`git-status ${c.before === null ? 'added' : c.after === null ? 'deleted' : ''}`}>{c.before === null ? 'A' : c.after === null ? 'D' : 'M'}</span><span>{c.path}</span><ChevronRight size={12} /></button>)}</div></>}
        {git?.files.length ? <><div className="panel-section-label">Working tree</div><div className="file-list changes-list">{git.files.map(f => <button key={f.path} onClick={() => void openFile(f.path)} title={`Git status: ${f.status}`}><span className={`git-status ${f.status.includes('?') || f.status.includes('A') ? 'added' : f.status.includes('D') ? 'deleted' : ''}`}>{f.status.trim()}</span><span>{f.path}</span></button>)}</div></> : null}
        {!changes.length && !git?.files.length && !error && <EmptyState icon={<GitCompareArrows size={25} />} title="A clean slate">File changes from this session will appear here.</EmptyState>}
      </>}
      {tab === 'todos' && (todos.length ? <div className="todo-list">{todos.map(t => <div className={`todo ${t.status}`} key={t.id}>{t.status === 'completed' ? <Check size={15} /> : t.status === 'in_progress' ? <span className="working-dot" /> : <Circle size={14} />}<span>{t.content}</span><span className="sr-only">{t.status.replace('_', ' ')}</span></div>)}</div> : <EmptyState icon={<ListTodo size={25} />} title="Room for a plan">When your agent creates a task list, follow its progress here.</EmptyState>)}
    </div><div className="workspace-footer"><ShieldNote />Files are scoped to this workspace</div>
    {preview && <Modal title={preview.path.split('/').at(-1) || 'File'} onClose={closePreview} wide><div className="file-preview"><div className="preview-meta"><span>{preview.path}</span><CopyButton text={preview.content} /></div>{preview.truncated && <div className="quiet-callout">This file is large. Showing a truncated preview.</div>}<pre><code>{preview.content || '(Empty file)'}</code></pre></div></Modal>}
    {change && <Modal title="Review file change" onClose={closeChange} wide><div className="file-preview"><div className="preview-meta">{change.path}</div><div className="diff-columns"><section><h4>Before</h4><pre>{change.before === null ? '(File did not exist)' : change.before || '(Empty file)'}</pre></section><section><h4>After</h4><pre>{change.after === null ? '(File deleted)' : change.after || '(Empty file)'}</pre></section></div></div></Modal>}
  </aside>;
}
function ShieldNote() { return <span className="workspace-footer-dot" />; }
