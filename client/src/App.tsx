import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleHelp, Command, Download, FileCode2, Folder, GitFork, Hammer, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PanelRight, Pencil, Plus, Search, Settings2, Shield, Sparkles, Terminal, Trash2, Undo2, Upload, WandSparkles, X } from 'lucide-react';
import type { Attachment, RunEvent, Session, SessionDetail, Settings as SettingsType } from '../../shared/types';
import { api, applyEvent, errorMessage, patch, post, query } from './api';
import { Composer, type Selection } from './Composer';
import { Conversation } from './Conversation';
import { Settings } from './Settings';
import { Workspace } from './Workspace';
import { EmptyState, Logo, Modal, SpeedRail } from './ui';

type Confirm = { title: string; description: string; label: string; danger?: boolean; action: () => Promise<void> };
type SlashCommand = { name: string; description: string; content: string };
const readSessionHash = () => { const value = window.location.hash.match(/^#session\/([\w-]+)$/); return value?.[1] ?? null; };
const suggestions = [
  { Icon: FileCode2, label: 'Understand a codebase', description: 'Find the big picture', prompt: 'Explore this workspace and explain how the project is structured, how to run it, and where the main functionality lives.' },
  { Icon: Hammer, label: 'Build something new', description: 'From idea to first version', prompt: 'I want to build a new feature in this project. First, explore the codebase and ask me what I have in mind.' },
  { Icon: WandSparkles, label: 'Make it better', description: 'Find a worthwhile improvement', prompt: 'Review this project for one high-impact improvement. Explain your recommendation and wait for my approval before making changes.' },
];
export default function App() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readSessionHash);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [selection, setSelection] = useState<Selection>({ providerId: '', model: '', mode: 'build', permissionMode: 'ask' });
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionReload, setSessionReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState(false);
  const [rename, setRename] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [refreshKey, setRefreshKey] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const pendingSession = useRef<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const currentId = useRef(activeId); currentId.current = activeId;
  const eventJournal = useRef<RunEvent[]>([]);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const archiveRef = useRef(archived); archiveRef.current = archived;
  const running = detail?.session.status === 'running' || detail?.session.status === 'waiting';
  const workspace = detail?.session.workspace ?? settings?.workspace ?? '';
  const provider = settings?.providers.find(p => p.id === selection.providerId);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const closeRename = useCallback(() => setRename(null), []);

  const refreshSessions = useCallback(async () => {
    const r = await api<{ sessions: Session[] }>(`/sessions?${query({ archived: String(archiveRef.current) })}`);
    setSessions(r.sessions);
  }, []);
  const refreshDetail = useCallback(async (id: string) => {
    const next = await api<SessionDetail>(`/sessions/${id}`);
    if (currentId.current === id) {
      const newer = eventJournal.current.filter(event => event.sessionId === id && (event.id ?? 0) > (next.lastEventId ?? 0));
      const reconciled = newer.reduce(applyEvent, next);
      setDetail(current => current?.session.id === id && (current.lastEventId ?? 0) > (reconciled.lastEventId ?? 0) ? current : reconciled);
      eventJournal.current = newer;
    }
    return next;
  }, []);
  const navigate = useCallback((id: string | null) => {
    window.history.pushState(null, '', id ? `#session/${id}` : window.location.pathname + window.location.search);
    setActiveId(id); setSidebarOpen(false); setSessionMenu(false); setError(''); setText('');
  }, []);
  const newSession = useCallback(() => {
    pendingSession.current = null;
    navigate(null); setDetail(null);
    const s = settingsRef.current;
    if (s) setSelection({ providerId: s.defaultProvider, model: s.defaultModel, mode: 'build', permissionMode: s.permissionMode });
    setTimeout(() => document.getElementById('message-input')?.focus(), 50);
  }, [navigate]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, r] = await Promise.all([api<SettingsType>('/settings'), api<{ sessions: Session[] }>('/sessions?archived=false')]);
      setSettings(s); setSessions(r.sessions);
      if (!currentId.current) setSelection({ providerId: s.defaultProvider, model: s.defaultModel, mode: 'build', permissionMode: s.permissionMode });
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (settings) void refreshSessions().catch(e => setError(errorMessage(e))); }, [archived, refreshSessions, Boolean(settings)]);
  useEffect(() => {
    function change() { setActiveId(readSessionHash()); setDetail(null); setError(''); }
    window.addEventListener('hashchange', change); window.addEventListener('popstate', change);
    return () => { window.removeEventListener('hashchange', change); window.removeEventListener('popstate', change); };
  }, []);
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme; else root.dataset.theme = settings.theme;
  }, [settings?.theme]);
  useEffect(() => {
    if (!workspace) return;
    let live = true;
    api<{ commands: SlashCommand[] }>(`/commands?${query({ workspace })}`).then(r => { if (live) setCommands(r.commands); }).catch(() => { if (live) setCommands([]); });
    return () => { live = false; };
  }, [workspace]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(v => !v); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
      if (e.key === 'Escape') { setSidebarOpen(false); setSessionMenu(false); }
    }
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [newSession]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4200); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => { if (sidebarRef.current) sidebarRef.current.inert = media.matches && !sidebarOpen; };
    update(); media.addEventListener('change', update);
    if (!sidebarOpen) return () => media.removeEventListener('change', update);
    const previous = document.activeElement as HTMLElement;
    sidebarRef.current?.querySelector<HTMLElement>('button')?.focus();
    function trap(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !media.matches) return;
      const items = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, summary') ?? []).filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); media.removeEventListener('change', update); previous?.focus(); };
  }, [sidebarOpen]);
  useEffect(() => {
    if (!activeId) { setDetail(null); return; }
    const id = activeId;
    let live = true, source: EventSource | undefined;
    let lastEventId = 0;
    eventJournal.current = [];
    setSessionLoading(true); setConnection('connecting'); setDetail(null);
    async function open() {
      try {
        const initial = await api<SessionDetail>(`/sessions/${id}`);
        if (!live) return;
        setDetail(initial); setSelection({ providerId: initial.session.providerId, model: initial.session.model, mode: initial.session.mode, permissionMode: initial.session.permissionMode }); setSessionLoading(false);
        source = new EventSource(`/api/sessions/${id}/events`);
        source.onopen = () => {
          if (!live) return;
          setConnection('connected');
          // The atomic cursor lets snapshots and replay overlap without lost or repeated deltas.
          void refreshDetail(id).catch(e => { if (live) setError(errorMessage(e)); });
        };
        source.onmessage = e => {
          if (!live) return;
          try {
            const event = JSON.parse(e.data) as RunEvent;
            const eventId = Number(e.lastEventId || event.id || 0);
            if (eventId && eventId <= lastEventId) return;
            if (eventId) lastEventId = eventId;
            if (event.sessionId !== id) return;
            event.id = eventId || event.id;
            eventJournal.current.push(event);
            if (eventJournal.current.length > 2000) eventJournal.current.splice(0, 1000);
            setDetail(d => d ? applyEvent(d, event) : d);
            if (event.type === 'session') { const s = event.data.session ?? event.data; setSessions(list => list.some(v => v.id === id) ? list.map(v => v.id === id ? { ...v, ...s } : v).sort((a, b) => b.updatedAt - a.updatedAt) : [s, ...list]); }
            if (event.type === 'error') setError(event.data.message ?? event.data.error ?? 'The agent run encountered an error.');
            if (event.type === 'done') {
              setRefreshKey(v => v + 1);
              void refreshDetail(id).catch(e => { if (live) setError(errorMessage(e)); });
              void refreshSessions().catch(() => {});
            }
          } catch { setError('A live update could not be read. Reload this session to restore its history.'); }
        };
        source.onerror = () => { if (live) setConnection('reconnecting'); };
      } catch (e) { if (live) { setError(errorMessage(e)); setSessionLoading(false); } }
    }
    void open();
    return () => { live = false; source?.close(); };
  }, [activeId, sessionReload, refreshDetail, refreshSessions]);

  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function changeSelection(next: Selection) {
    if (running) return;
    const previous = selection; setSelection(next);
    if (activeId) {
      try { const session = await patch<Session>(`/sessions/${activeId}`, next); setDetail(d => d ? { ...d, session } : d); }
      catch (e) { setSelection(previous); setError(errorMessage(e)); }
    }
  }
  async function send(content: string, attachments: Attachment[]) {
    setError('');
    let id = activeId ?? pendingSession.current;
    try {
      if (!id) {
        const session = await post<Session>('/sessions', { ...selection, workspace, title: content.slice(0, 70) });
        id = session.id; pendingSession.current = id;
        setSessions(list => [session, ...list]);
      } else if (!activeId) {
        await patch(`/sessions/${id}`, selection);
      }
      await post(`/sessions/${id}/messages`, { content, attachments });
      pendingSession.current = null;
      if (!activeId) navigate(id);
      else await refreshDetail(id);
      return true;
    } catch (e) {
      // Keep the same composer mounted after a failed request so attachments and draft survive.
      setError(errorMessage(e));
      return false;
    }
  }
  function saveSettings(next: SettingsType) {
    setSettings(next); setRefreshKey(v => v + 1);
    if (!activeId) setSelection(s => ({ ...s, providerId: next.defaultProvider, model: next.defaultModel, permissionMode: next.permissionMode }));
  }
  function askDelete(session: Session) {
    setConfirm({ title: 'Delete this session?', description: `“${session.title}” and its conversation history will be permanently removed. Your workspace files will not be deleted.`, label: 'Delete session', danger: true, action: async () => { await api(`/sessions/${session.id}`, { method: 'DELETE' }); if (activeId === session.id) newSession(); await refreshSessions(); setToast('Session deleted'); } });
  }
  function askUndo() {
    if (!activeId) return;
    const id = activeId;
    setConfirm({ title: 'Undo this session’s file changes?', description: 'Restore all file edits recorded by this session. Lite will refuse if any file has changed since. Shell commands and external side effects cannot be undone.', label: 'Undo session changes', action: async () => { await post(`/sessions/${id}/undo`); await refreshDetail(id); setRefreshKey(v => v + 1); setToast('Session file changes restored'); } });
  }
  async function fork(messageId?: string) {
    if (!activeId) return;
    await act(async () => { const session = await post<Session>(`/sessions/${activeId}/fork`, { messageId }); navigate(session.id); await refreshSessions(); setToast('Conversation forked. Workspace files are shared.'); });
  }
  async function archive(session: Session) {
    await act(async () => { await patch(`/sessions/${session.id}`, { archived: !session.archived }); await refreshSessions(); if (activeId === session.id) await refreshDetail(session.id); setToast(session.archived ? 'Session restored' : 'Session archived'); });
  }
  async function exportSession() {
    if (!activeId) return;
    await act(async () => {
      const data = await api(`/sessions/${activeId}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `lite-${(detail?.session.title || 'session').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 48)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setToast('Session exported');
    });
  }
  async function importSession(file: File) {
    await act(async () => {
      if (file.size > 15 * 1024 * 1024) throw new Error('Choose a session export under 15 MB.');
      let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('This is not a valid JSON session export.'); }
      const session = await post<Session>('/sessions/import', data); navigate(session.id); await refreshSessions(); setToast('Session imported');
    });
  }
  const visibleSessions = sessions.filter(s => s.title.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const groups = [
    { title: 'Today', rows: visibleSessions.filter(s => s.updatedAt >= +today) },
    { title: 'Yesterday', rows: visibleSessions.filter(s => s.updatedAt < +today && s.updatedAt >= +today - 86400000) },
    { title: 'Earlier', rows: visibleSessions.filter(s => s.updatedAt < +today - 86400000) },
  ];
  return <div className={`app ${sidebarOpen ? 'sidebar-is-open' : ''}`}>
    <a className="skip-link" href="#main-content">Skip to conversation</a>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside ref={sidebarRef} className="sidebar" aria-label="Session navigation"><div className="sidebar-brand"><button className="brand" onClick={newSession} aria-label="Lite home"><Logo /><span>lite<span className="brand-period">.</span></span></button><button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17} /></button><span className="local-label">LOCAL</span></div>
      <div className="sidebar-top"><button className="new-session" onClick={newSession}><Plus size={17} /><span>New session</span><kbd>⌘ N</kbd></button><button className="sidebar-search-launch" onClick={() => setPaletteOpen(true)}><Search size={16} /><span>Search anything</span><kbd>⌘ K</kbd></button></div>
      <div className="sessions-heading"><span>{archived ? 'Archived sessions' : 'Your sessions'}</span><button className={`icon-button ${archived ? 'selected' : ''}`} aria-label={archived ? 'Show recent sessions' : 'Show archived sessions'} title={archived ? 'Show recent sessions' : 'Show archived sessions'} onClick={() => setArchived(v => !v)}><Archive size={14} /></button></div>
      {sessions.length > 5 || search ? <div className="session-search"><Search size={13} /><input aria-label="Filter sessions" placeholder="Filter sessions…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear session search" onClick={() => setSearch('')}><X size={12} /></button>}</div> : null}
      <div className="session-list">{loading ? <div className="sidebar-loading"><SpeedRail compact active /><span>Loading your space…</span></div> : groups.map(group => group.rows.length > 0 && <section className="session-group" key={group.title}><h3>{group.title}</h3>{group.rows.map(session => <div className={`session-row ${activeId === session.id ? 'active' : ''}`} key={session.id}><button className="session-link" onClick={() => navigate(session.id)} title={session.title}><MessageSquare size={14} /><span>{session.title || 'Untitled session'}</span>{(session.status === 'running' || session.status === 'waiting') && <span className={`session-activity ${session.status}`} aria-label={session.status} />}</button><details className="session-context"><summary aria-label={`Actions for ${session.title}`}><MoreHorizontal size={16} /></summary><div className="session-context-menu"><button onClick={e => { setRename(session); setRenameValue(session.title); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Pencil size={13} />Rename</button><button disabled={busy} onClick={e => { void archive(session); e.currentTarget.closest('details')?.removeAttribute('open'); }}>{session.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{session.archived ? 'Restore' : 'Archive'}</button><button className="danger" disabled={session.status === 'running' || session.status === 'waiting'} onClick={e => { askDelete(session); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Trash2 size={13} />Delete</button></div></details></div>)}</section>)}
        {!loading && !visibleSessions.length && <div className="sidebar-empty"><MessageSquare size={20} /><p>{search ? 'No matching sessions' : archived ? 'No archived sessions' : 'A little space for what’s next.'}</p><span>{search ? 'Try another search.' : archived ? 'Archive sessions to keep things tidy.' : 'Your conversations will live here.'}</span></div>}
      </div>
      <div className="sidebar-bottom"><button className="sidebar-footer-button" onClick={() => importInput.current?.click()}><Upload size={15} /><span>Import session</span></button><button className="sidebar-footer-button" onClick={() => setSettingsOpen(true)} disabled={!settings}><Settings2 size={16} /><span>Settings</span></button><div className="workspace-identity"><span className="workspace-avatar"><Terminal size={16} /></span><div><strong>{workspace.split('/').filter(Boolean).at(-1) || 'Your workspace'}</strong><span>On your machine</span></div><button className="icon-button" aria-label="Workspace settings" disabled={!settings} onClick={() => setSettingsOpen(true)}><ChevronDown size={14} /></button></div></div>
    </aside>
    <main className="main" id="main-content"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><span className="breadcrumb-project"><Folder size={14} />{workspace.split('/').filter(Boolean).at(-1) || 'Workspace'}</span><span className="breadcrumb-slash">/</span><span className="topbar-title">{detail?.session.title || (activeId ? 'Session' : 'New session')}</span></div><div className="topbar-actions">{detail && <><span className={`session-state ${detail.session.status}`}><span />{detail.session.status === 'running' ? 'Working' : detail.session.status === 'waiting' ? 'Needs approval' : detail.session.status === 'error' ? 'Run error' : detail.session.archived ? 'Archived' : 'Saved locally'}</span><div className="session-menu-wrap"><button className="icon-button" aria-label="Session actions" aria-expanded={sessionMenu} onClick={() => setSessionMenu(v => !v)}><MoreHorizontal size={19} /></button>{sessionMenu && <><button className="menu-dismiss" aria-label="Close session actions" onClick={() => setSessionMenu(false)} /><div className="session-menu"><button onClick={() => { setRename(detail.session); setRenameValue(detail.session.title); setSessionMenu(false); }}><Pencil size={14} />Rename session</button><button disabled={running || busy} onClick={() => { void fork(); setSessionMenu(false); }}><GitFork size={14} />Fork conversation</button><button onClick={() => { void exportSession(); setSessionMenu(false); }}><Download size={14} />Export session</button><button disabled={running || busy} onClick={() => { setSessionMenu(false); setConfirm({ title: 'Compact this conversation?', description: 'Summarize older context to make room for your next steps. This changes the context used by future model calls.', label: 'Compact context', action: async () => { await post(`/sessions/${activeId}/compact`); await refreshDetail(activeId!); setToast('Conversation compacted'); } }); }}><ArrowDownToLine size={14} />Compact context</button><button disabled={running || busy} onClick={() => { askUndo(); setSessionMenu(false); }}><Undo2 size={14} />Undo session file changes</button><button onClick={() => { void archive(detail.session); setSessionMenu(false); }}><Archive size={14} />{detail.session.archived ? 'Restore session' : 'Archive session'}</button><hr /><button className="danger" disabled={running} onClick={() => { askDelete(detail.session); setSessionMenu(false); }}><Trash2 size={14} />Delete session</button></div></>}</div></>}
        <button className={`icon-button workspace-toggle ${workspaceOpen ? 'selected' : ''}`} aria-label={workspaceOpen ? 'Hide workspace panel' : 'Show workspace panel'} title="Files, changes, and plan" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen(v => !v)}><PanelRight size={18} /></button></div></header>
      {error && <div className="global-alert" role="alert"><span>{error}</span>{!settings ? <button onClick={() => void load()}>Retry connection</button> : activeId && !detail ? <button onClick={() => { setError(''); setSessionReload(v => v + 1); }}>Retry</button> : null}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      <div className="main-panels"><div className={`main-stage ${!activeId ? 'welcome-stage' : ''}`}>
        {loading ? <div className="app-loading"><Logo /><SpeedRail active /><p>Opening your workspace…</p></div> : !settings ? <EmptyState icon={<Terminal size={30} />} title="Let’s get connected.">The local server is not available. Check that Lite is running, then retry the connection.<button className="button primary" onClick={() => void load()}>Try again</button></EmptyState> : activeId ? <>
          {sessionLoading ? <div className="app-loading"><SpeedRail active /><p>Opening this conversation…</p></div> : detail ? <Conversation detail={detail} connection={connection} busy={busy} onDecide={(id, decision) => void act(async () => { await post(`/sessions/${activeId}/permissions/${id}`, { decision }); await refreshDetail(activeId); })} onFork={messageId => void fork(messageId)} onUndo={askUndo} /> : <EmptyState title="This session couldn’t be opened">Choose another session, or start a fresh one.<button className="button secondary" onClick={newSession}><Plus size={15} />New session</button></EmptyState>}
          {detail && <div className="chat-composer"><Composer key={activeId} settings={settings} selection={selection} onSelection={v => void changeSelection(v)} onSend={send} onCancel={() => void act(async () => { await post(`/sessions/${activeId}/cancel`); await refreshDetail(activeId); })} running={running} disabled={busy} workspace={workspace} text={text} setText={setText} onSettings={() => setSettingsOpen(true)} /></div>}
        </> : <div className="welcome"><div className="welcome-visual"><SpeedRail /></div><div className="welcome-eyebrow">LESS FRICTION. MORE FLOW.</div><h1>Good ideas move fast<span>.</span></h1><p className="welcome-description">A little space to think big. What’s on your mind?</p>
          <div className="welcome-input"><Composer settings={settings} selection={selection} onSelection={v => void changeSelection(v)} onSend={send} onCancel={() => {}} running={false} disabled={busy} welcome workspace={workspace} text={text} setText={setText} onSettings={() => setSettingsOpen(true)} /></div>
          <div className="suggestions">{suggestions.map(({ Icon, label, description, prompt }) => <button key={label} onClick={() => { setText(prompt); document.getElementById('message-input')?.focus(); }}><span className="suggestion-icon"><Icon size={17} /></span><span><strong>{label}</strong><small>{description}</small></span><ArrowRight className="suggestion-arrow" size={14} /></button>)}</div>
          {(!provider?.configured && provider?.baseUrl && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) && <button className="setup-hint" onClick={() => setSettingsOpen(true)}><Shield size={13} />Connect your provider to get started<ArrowRight size={13} /></button>}
          <div className="welcome-footnote"><span className="mini-speed"><i /><i /><i /></span>Powered by your models. Grounded in your workspace.</div>
        </div>}
      </div>{workspaceOpen && settings && <Workspace workspace={workspace} sessionId={activeId ?? undefined} todos={detail?.todos ?? []} refreshKey={refreshKey} onClose={() => setWorkspaceOpen(false)} onUndo={askUndo} running={running} />}</div>
    </main>
    <input type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} ref={importInput} aria-label="Import session JSON" onChange={e => { const f = e.target.files?.[0]; if (f) void importSession(f); e.target.value = ''; }} />
    {settingsOpen && settings && <Settings settings={settings} onClose={closeSettings} onSave={saveSettings} />}
    {paletteOpen && <CommandPalette sessions={sessions} commands={commands} onClose={closePalette} onSession={navigate} onPrompt={p => { setText(p); setPaletteOpen(false); setTimeout(() => document.getElementById('message-input')?.focus(), 50); }} actions={[{ name: 'New session', description: 'Start with a clean slate', Icon: Plus, run: newSession, shortcut: '⌘ N' }, { name: 'Settings', description: 'Models, providers, and workspace', Icon: Settings2, run: () => setSettingsOpen(true) }, { name: 'Toggle workspace', description: 'Files, Git changes, and plan', Icon: PanelRight, run: () => setWorkspaceOpen(v => !v) }, { name: 'Import session', description: 'Restore a conversation from JSON', Icon: Upload, run: () => importInput.current?.click() }, ...(activeId ? [{ name: 'Export session', description: 'Save this conversation as JSON', Icon: Download, run: () => void exportSession() }] : [])]} />}
    {rename && <Modal title="Rename session" onClose={closeRename}><form className="rename-form" onSubmit={e => { e.preventDefault(); void act(async () => { const session = await patch<Session>(`/sessions/${rename.id}`, { title: renameValue.trim() }); setSessions(list => list.map(s => s.id === session.id ? session : s)); if (activeId === session.id) setDetail(d => d ? { ...d, session } : d); setRename(null); }); }}><label>Session name<input autoFocus maxLength={160} value={renameValue} onChange={e => setRenameValue(e.target.value)} /></label><div className="form-actions"><button className="button secondary" type="button" onClick={closeRename}>Cancel</button><button className="button primary" disabled={!renameValue.trim() || busy}>Save name</button></div></form></Modal>}
    {confirm && <Modal title={confirm.title} onClose={closeConfirm}><div className="confirm-content"><p>{confirm.description}</p><div className="form-actions"><button className="button secondary" onClick={closeConfirm} disabled={busy}>Cancel</button><button className={`button ${confirm.danger ? 'destructive' : 'primary'}`} disabled={busy} onClick={() => void act(async () => { await confirm.action(); setConfirm(null); })}>{busy ? 'Working…' : confirm.label}</button></div></div></Modal>}
    {toast && <div className="toast" role="status"><Check size={15} />{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={13} /></button></div>}
  </div>;
}

function CommandPalette({ sessions, commands, actions, onClose, onSession, onPrompt }: { sessions: Session[]; commands: SlashCommand[]; actions: { name: string; description: string; Icon: typeof Plus; run: () => void; shortcut?: string }[]; onClose: () => void; onSession: (id: string) => void; onPrompt: (text: string) => void }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(0);
  const results = [
    ...actions.map(a => ({ ...a, type: 'Action' })),
    ...commands.map(c => ({ name: `/${c.name}`, description: c.description, Icon: Terminal, run: () => onPrompt(c.content), shortcut: undefined, type: 'Workspace command' })),
    ...sessions.map(s => ({ name: s.title, description: s.archived ? 'Archived session' : new Date(s.updatedAt).toLocaleDateString(), Icon: MessageSquare, run: () => onSession(s.id), shortcut: undefined, type: 'Session' })),
  ].filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase())).slice(0, 30);
  function run(index: number) { const item = results[index]; if (!item) return; onClose(); item.run(); }
  return <Modal title="Find your next step" onClose={onClose}><div className="command-palette" onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.min(i + 1, results.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(i - 1, 0)); } if (e.key === 'Enter') { e.preventDefault(); run(selected); } }}><div className="palette-search"><Search size={19} /><input autoFocus placeholder="Search sessions, actions, and commands…" aria-label="Search commands and sessions" role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={results[selected] ? `palette-item-${selected}` : undefined} value={search} onChange={e => { setSearch(e.target.value); setSelected(0); }} /><kbd>esc</kbd></div><div className="palette-results" role="listbox" id="palette-results">{results.length ? results.map((item, i) => <button id={`palette-item-${i}`} role="option" aria-selected={i === selected} tabIndex={-1} className={i === selected ? 'selected' : ''} key={`${item.type}-${item.name}-${i}`} onMouseMove={() => setSelected(i)} onClick={() => run(i)}><item.Icon size={17} /><span><strong>{item.name}</strong><small>{item.description}</small></span>{item.shortcut ? <kbd>{item.shortcut}</kbd> : <span className="command-type">{item.type}</span>}</button>) : <EmptyState icon={<Search size={22} />} title="Nothing found">Try a session name or an action like “settings”.</EmptyState>}</div><div className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to open</span><Command size={14} /></div></div></Modal>;
}
