import { workerLabels } from './worker-presentation';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Archive, ArchiveRestore, ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleHelp, Command, Download, FileCode2, Folder, GitFork, Hammer, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PanelRight, Pencil, Plus, Redo2, Search, Settings2, Shield, Sparkles, Target, Terminal, Trash2, Undo2, Upload, WandSparkles, X } from 'lucide-react';
import type { Attachment, QueueState, RunEvent, Session, SessionDetail, Settings as SettingsType } from '../../shared/types';
import { api, applyEvent, errorMessage, patch, post, query, reconcileSession, useSessionDraft, visibleDelegations } from './api';
import { TaskCard, delegationPath } from './TaskCard';
import type { DelegationSummary } from '../../shared/delegation';
import { Composer, type Selection } from './Composer';
import { ProfilePicker } from './ProfilePicker';
import type { ApplyProfileRequest, ProfileChoice } from '../../shared/profiles';
import { Conversation } from './Conversation';
import { QuestionCard, emptyQuestionDraft, type QuestionDraft } from './QuestionCard';
import type { QuestionAnswer, QuestionRequest } from '../../shared/questions';
import { TurnHistory } from './TurnHistory';
import { ContextIndicator } from './ContextIndicator';
import { Settings } from './Settings';
import { Workspace } from './Workspace';
import { EmptyState, Logo, Modal, SpeedRail } from './ui';

const SessionTerminal = lazy(() => import('./Terminal').then(module => ({default:module.Terminal})));

type Confirm = { title: string; description: string; label: string; danger?: boolean; sessionId?: string; historyAction?: boolean; action: () => Promise<void> };
type SlashCommand = { name: string; description: string; content: string };
const positionalArgs = (raw: string) => (raw.match(/"[^"]*"|\S+/g) ?? []).map(value => value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
function expandSlashCommand(content: string, commands: SlashCommand[]): string {
  const match = content.match(/^\/(\S+)([\s\S]*)$/);
  const command = match && commands.find(c => c.name === match[1]);
  if (!match || !command) return content;
  const args = match[2].trim(), positional = positionalArgs(args);
  return command.content.replace(/\$(ARGUMENTS|[1-9])/g, (_, key: string) => key === 'ARGUMENTS' ? args : positional[Number(key) - 1] ?? '');
}
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
  const configOperation = useRef(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [newProfile, setNewProfile] = useState<{ workspace: string; choice: ProfileChoice } | null>(null);
  const [profileDialog, setProfileDialog] = useState<{ id: string | null; workspace: string; revision: number; choice: ProfileChoice; selection: Selection; view: number } | null>(null);
  const closeProfiles = useCallback(() => setProfileDialog(null), []);
  const { draft, notice: draftNotice, setText, setAttachments, clearSubmitted, prepareDelete } = useSessionDraft(activeId);
  const { text, attachments } = draft;
  const [queueBusy, setQueueBusy] = useState(false);
  const queueOperation = useRef(false);
  const submissionOperation = useRef(false);
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const historyOperation = useRef(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [contextSession, setContextSession] = useState<string | null>(null);
  const latestContext = detail?.messages.filter(message => message.role === 'assistant' && message.context).at(-1)?.context;
  const [taskErrors, setTaskErrors] = useState(new Map<string, string>());
  const [cancellingTasks, setCancellingTasks] = useState(new Set<string>());
  const taskOperations = useRef(new Set<string>());
  const [questionDrafts, setQuestionDrafts] = useState(new Map<string, QuestionDraft>());
  const [questionErrors, setQuestionErrors] = useState(new Map<string, string>());
  const [answering, setAnswering] = useState(new Set<string>());
  const answerOperations = useRef(new Set<string>());
  const resolvedQuestions = useRef(new Set<string>());
  const cancelling = useRef(new Set<string>());
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
  const [workspaceOpen, setWorkspaceOpen] = useState(() => { try { const saved = localStorage.getItem('lite.workspace-panel-open'); return saved === null ? window.innerWidth >= 960 : saved === 'true'; } catch { return window.innerWidth >= 960; } });
  useEffect(() => { try { localStorage.setItem('lite.workspace-panel-open', String(workspaceOpen)); } catch { /* Keep the current layout if storage is unavailable. */ } }, [workspaceOpen]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => setTerminalOpen(false), [activeId]);
  const [sessionMenu, setSessionMenu] = useState(false);
  const [rename, setRename] = useState<Session | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // GOAL MODE: session-level modal state, mirroring the rename modal pattern.
  const [goalModal, setGoalModal] = useState(false);
  const [goalText, setGoalText] = useState('');
  const [goalTurns, setGoalTurns] = useState('10');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [refreshKey, setRefreshKey] = useState(0);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const pendingSession = useRef<Session | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const currentId = useRef(activeId); currentId.current = activeId;
  const eventJournal = useRef<RunEvent[]>([]);
  const selectionRequest = useRef(0);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const archiveRef = useRef(archived); archiveRef.current = archived;
  const detailRef = useRef(detail); detailRef.current = detail;
  const running = detail?.session.status === 'running' || detail?.session.status === 'waiting';
  const delegations = detail ? visibleDelegations(detail) : [];
  const actors = detail ? workerLabels(detail) : new Map<string, string>();
  const history = detail?.history;
  const historyDisabled = running || busy || queueBusy || submissionBusy || historyBusy || configBusy || sessionLoading;
  const legacyUndo = history?.hasCheckpoints === false && !history.pendingRecovery;
  const composerDisabled = busy || historyBusy || configBusy || Boolean(history?.pendingRecovery);
  const selectionDisabled = historyDisabled || answering.size > 0 || Boolean(history?.pendingRecovery || (!activeId && pendingSession.current));
  const workspace = detail?.session.workspace ?? (!activeId ? pendingSession.current?.workspace : undefined) ?? settings?.workspace ?? '';

  useEffect(() => {
    const session = detail?.session;
    if (session && session.id === currentId.current && !configBusy) setSelection({ providerId: session.providerId, model: session.model, mode: session.mode, permissionMode: session.permissionMode, planner: session.planner, outputStyle: session.outputStyle, modelReasoning: session.modelReasoning, architecture: session.architecture });
  }, [detail?.session.modelReasoning, detail?.session.providerId, detail?.session.model, detail?.session.mode, detail?.session.permissionMode, detail?.session.planner?.providerId, detail?.session.planner?.model, detail?.session.outputStyle, detail?.session.architecture, detail?.session.configRevision, configBusy]);
  const provider = settings?.providers.find(p => p.id === selection.providerId);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setProfileDialog(null); }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const closeRename = useCallback(() => setRename(null), []);
  const closeGoal = useCallback(() => setGoalModal(false), []);
  const goal = detail?.session.goal;
  const goalVisible = goal && (goal.status === 'active' || goal.status === 'blocked');
  async function setSessionGoal() {
    const id = activeId;
    if (!id) return;
    await act(async () => {
      const session = await post<Session>(`/sessions/${id}/goal`, { text: goalText.trim(), maxTurns: Math.max(1, Math.min(25, Number(goalTurns) || 10)) });
      if (currentId.current === id) setDetail(d => d ? { ...d, session: reconcileSession(d.session, session) } : d);
      setGoalModal(false); setGoalText(''); setToast('Session goal set. Send a message to start working toward it.');
    });
  }
  async function clearSessionGoal() {
    const id = activeId;
    if (!id) return;
    await act(async () => {
      const session = await api<Session>(`/sessions/${id}/goal`, { method: 'DELETE' });
      if (currentId.current === id) setDetail(d => d ? { ...d, session: reconcileSession(d.session, session) } : d);
      setToast('Session goal cleared.');
    });
  }

  const refreshSessions = useCallback(async () => {
    const r = await api<{ sessions: Session[] }>(`/sessions?${query({ archived: String(archiveRef.current) })}`);
    setSessions(r.sessions);
  }, []);
  const refreshDetail = useCallback(async (id: string) => {
    const view = selectionRequest.current;
    const next = await api<SessionDetail>(`/sessions/${id}`);
    if (currentId.current === id && selectionRequest.current === view) {
      const newer = eventJournal.current.filter(event => event.sessionId === id && (event.id ?? 0) > (next.lastEventId ?? 0));
      const reconciled = newer.reduce(applyEvent, next);
      if (reconciled.questions) reconciled.questions = reconciled.questions.filter(question => !resolvedQuestions.current.has(question.id));
      setDetail(current => current?.session.id === id
        ? (current.lastEventId ?? 0) > (reconciled.lastEventId ?? 0) ? current : { ...reconciled, session: reconcileSession(current.session, reconciled.session) }
        : reconciled);
      eventJournal.current = newer;
    }
    return next;
  }, []);
  const navigate = useCallback((id: string | null) => {
    window.history.pushState(null, '', id ? `#session/${id}` : window.location.pathname + window.location.search);
    if (currentId.current !== id) { selectionRequest.current++; setDetail(null); setProfileDialog(null); }
    currentId.current = id; setActiveId(id); setSidebarOpen(false); setSessionMenu(false); setError('');
  }, []);
  useEffect(() => {
    if(activeId||!settings)return;
    let live=true;const request=selectionRequest.current;
    api<Partial<Selection>>(`/workspace-preferences?${query({workspace})}`).then(preferred=>{
      if(live&&!currentId.current&&selectionRequest.current===request&&!pendingSession.current)setSelection(current=>({...current,...preferred,architecture:preferred.architecture??null,planner:preferred.planner??null,outputStyle:preferred.outputStyle??null,modelReasoning:preferred.modelReasoning??{}}));
    }).catch(()=>{});
    return()=>{live=false;};
  },[activeId,workspace,settings?.defaultProvider,settings?.defaultModel]);
  const newSession = useCallback(() => {
    pendingSession.current = null; setNewProfile(null); setProfileDialog(null); selectionRequest.current++;
    navigate(null); setDetail(null);
    const s = settingsRef.current;
    if (s) setSelection({ providerId: s.defaultProvider, model: s.defaultModel, mode: 'build', permissionMode: s.permissionMode, architecture:null });
    const request=selectionRequest.current;
    if(s)void api<Partial<Selection>>(`/workspace-preferences?${query({workspace:s.workspace})}`).then(preferred=>{if(!currentId.current&&selectionRequest.current===request)setSelection(current=>({...current,...preferred,architecture:preferred.architecture??null,planner:preferred.planner??null,outputStyle:preferred.outputStyle??null,modelReasoning:preferred.modelReasoning??{}}));}).catch(()=>{});
    setTimeout(() => document.getElementById('message-input')?.focus(), 50);
  }, [navigate]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [s, r] = await Promise.all([api<SettingsType>('/settings'), api<{ sessions: Session[] }>('/sessions?archived=false')]);
      setSettings(s); setSessions(r.sessions);
      if (!currentId.current) setSelection({ providerId: s.defaultProvider, model: s.defaultModel, mode: 'build', permissionMode: s.permissionMode, architecture:null });
    } catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (settings) void refreshSessions().catch(e => setError(errorMessage(e))); }, [archived, refreshSessions, Boolean(settings)]);
  useEffect(() => {
    function change() { const id = readSessionHash(); if (currentId.current !== id) { selectionRequest.current++; setDetail(null); setProfileDialog(null); } currentId.current = id; setActiveId(id); setError(''); }
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
    if (!activeId) { setDetail(null); setSessionLoading(false); return; }
    const id = activeId;
    let live = true, source: EventSource | undefined;
    let lastEventId = 0;
    eventJournal.current = [];
    setSessionLoading(true); setConnection('connecting'); setDetail(null);
    async function open() {
      try {
        const initial = await api<SessionDetail>(`/sessions/${id}`);
        if (!live) return;
        setDetail(initial); setSelection({ providerId: initial.session.providerId, model: initial.session.model, mode: initial.session.mode, permissionMode: initial.session.permissionMode, planner: initial.session.planner, outputStyle: initial.session.outputStyle, modelReasoning: initial.session.modelReasoning, architecture: initial.session.architecture }); setSessionLoading(false);
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
            if (event.type === 'question_resolved') {
              resolvedQuestions.current.add(event.data.id);
              setQuestionDrafts(current => { const next = new Map(current); next.delete(event.data.id); return next; });
              setQuestionErrors(current => { const next = new Map(current); next.delete(event.data.id); return next; });
            }
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
  function configurationLocked() {
    const current = detailRef.current;
    return configOperation.current || busy || historyOperation.current || submissionOperation.current || queueOperation.current || answerOperations.current.size > 0 ||
      current?.session.status === 'running' || current?.session.status === 'waiting' || Boolean(current?.history?.pendingRecovery) ||
      (!currentId.current && Boolean(pendingSession.current));
  }
  function openProfiles() {
    const selectedProfile = activeId ? detail?.session.profile : newProfile?.workspace === workspace ? newProfile.choice : null;
    if (selectionDisabled || configurationLocked()) return;
    const current = detailRef.current?.session;
    setProfileDialog({ id: activeId, workspace, revision: current?.configRevision ?? 0,
      choice: selectedProfile ? { profileId: selectedProfile.profileId, skillIds: [...selectedProfile.skillIds] } : { profileId: null, skillIds: [] },
      selection: { ...selection }, view: selectionRequest.current });
  }
  async function applyProfile(choice: ProfileChoice, defaults?: ApplyProfileRequest['selection']) {
    const dialog = profileDialog;
    if (!dialog || configurationLocked() || currentId.current !== dialog.id || selectionRequest.current !== dialog.view) throw new Error('Session changed or another operation is pending.');
    if (!dialog.id) {
      setNewProfile(choice.profileId || choice.skillIds.length ? { workspace: dialog.workspace, choice } : null);
      if (defaults) setSelection(value => ({ ...value, ...defaults }));
      setProfileDialog(null); setSettingsOpen(false); return;
    }
    const id = dialog.id, stillHere = () => currentId.current === id && selectionRequest.current === dialog.view;
    configOperation.current = true; setConfigBusy(true); setError('');
    let failure = '', accepted = false;
    const cursor = detailRef.current?.lastEventId ?? 0;
    try {
      const result = await post<{ session: Session; queue: QueueState }>(`/sessions/${id}/profile`, { expectedConfigRevision: dialog.revision, choice, ...(defaults ? { selection: defaults } : {}) });
      accepted = true;
      if (stillHere()) setDetail(current => current?.session.id === id && (current.lastEventId ?? 0) <= cursor
        ? { ...current, session: reconcileSession(current.session, result.session), queue: result.queue } : current);
    } catch (e) { failure = errorMessage(e); }
    finally {
      try { await refreshDetail(id); } catch (e) { failure += `${failure ? ' ' : ''}Could not refresh the session: ${errorMessage(e)}. Reload before continuing.`; }
      if (stillHere() && accepted) {
        setProfileDialog(null); setSettingsOpen(false);
        setToast('Project configuration updated. Queued messages remain paused.');
        if (failure) setError(failure);
      }
      void refreshSessions().catch(() => {});
      configOperation.current = false; setConfigBusy(false);
    }
    if (failure && !accepted && stillHere()) { setError(failure); throw new Error(failure); }
  }
  async function changeSelection(next: Selection) {
    if (configurationLocked()) return;
    const previous = selection, id = activeId, request = ++selectionRequest.current;
    setSelection(next);
    if (!id) {
      configOperation.current=true;setConfigBusy(true);
      try {await post('/workspace-preferences',{...next,workspace});} catch(e) {if(selectionRequest.current===request){setSelection(previous);setError(errorMessage(e));}}
      finally {configOperation.current=false;setConfigBusy(false);}
      return;
    }
    configOperation.current = true; setConfigBusy(true); setError('');
    const stillHere = () => currentId.current === id && selectionRequest.current === request;
    const cursor = detailRef.current?.lastEventId ?? 0;
    try {
      const session = await patch<Session>(`/sessions/${id}`, { ...next, expectedConfigRevision: detailRef.current?.session.configRevision ?? 0 });
      if (stillHere()) setDetail(d => d?.session.id === id && (d.lastEventId ?? 0) <= cursor ? { ...d, session: reconcileSession(d.session, session) } : d);
    } catch (e) {
      if (stillHere()) { setSelection(previous); setError(errorMessage(e)); }
    } finally {
      // A conflict may have changed configuration in another tab. Refresh, but never retry implicitly.
      await refreshDetail(id).catch(e => { if (stillHere()) setError(`Could not refresh session configuration: ${errorMessage(e)}. Reload before continuing.`); });
      configOperation.current = false; setConfigBusy(false);
    }
  }
  async function send(content: string, attachments: Attachment[]) {
    if (submissionOperation.current || configOperation.current || historyOperation.current || detailRef.current?.history?.pendingRecovery) return false;
    submissionOperation.current = true; setSubmissionBusy(true); setError('');
    const view = selectionRequest.current, stillHere = () => currentId.current === activeId && selectionRequest.current === view;
    let id = activeId ?? pendingSession.current?.id;
    try {
      if (!id) {
        const profile = newProfile?.workspace === workspace ? newProfile.choice : undefined;
        const session = await post<Session>('/sessions', { ...selection, workspace, title: content.slice(0, 70), ...(profile ? { profile } : {}) });
        id = session.id;
        if (stillHere()) pendingSession.current = session;
        setSessions(list => [session, ...list]);
      }
      await post(`/sessions/${id}/messages`, { content, attachments });
      clearSubmitted(draft);
      if (pendingSession.current?.id === id) pendingSession.current = null;
      if (!activeId && stillHere()) { setNewProfile(null); navigate(id); }
      else if (currentId.current === id && stillHere()) void refreshDetail(id).catch(e => setError(`Message sent, but refreshing the session failed: ${errorMessage(e)}`));
      return true;
    } catch (e) {
      // Keep the same composer mounted after a failed request so attachments and draft survive.
      if (stillHere()) setError(errorMessage(e));
      return false;
    } finally { submissionOperation.current = false; setSubmissionBusy(false); }
  }
  async function queueMessage(content: string, attachments: Attachment[]) {
    const id = activeId;
    if (!id || queueOperation.current || configOperation.current || historyOperation.current || detailRef.current?.history?.pendingRecovery) return false;
    queueOperation.current = true; setQueueBusy(true); setError('');
    const cursor = detail?.lastEventId ?? 0;
    try {
      const queue = await post<QueueState>(`/sessions/${id}/queue`, { content, attachments });
      clearSubmitted(draft);
      // The detail cursor survives journal pruning; a bare response must not replace newer SSE/snapshot state.
      setDetail(current => current?.session.id === id && (current.lastEventId ?? 0) <= cursor ? { ...current, queue } : current);
      if (currentId.current === id) {
        setToast(queue.paused ? 'Message queued. Choose Resume queue when ready.' : 'Message added to queue');
        void refreshDetail(id).catch(e => setError(`Message queued, but refreshing failed: ${errorMessage(e)}`));
      }
      return true;
    } catch (e) {
      if (currentId.current === id) {
        setError(errorMessage(e));
        void refreshDetail(id).catch(() => {});
      }
      return false;
    } finally { queueOperation.current = false; setQueueBusy(false); }
  }
  // Mid-turn steering: the note lands between steps of the RUNNING response.
  // No detail-state update is needed — the server persists a [Steering] system
  // marker that arrives through the normal message event stream.
  async function steerMessage(content: string) {
    const id = activeId;
    if (!id || queueOperation.current || configOperation.current || historyOperation.current) return false;
    queueOperation.current = true; setQueueBusy(true); setError('');
    try {
      await post(`/sessions/${id}/steer`, { content });
      if (currentId.current === id) setToast('Steering sent to the driver.');
      return true;
    } catch (e) {
      if (currentId.current === id) setError(errorMessage(e));
      return false;
    } finally { queueOperation.current = false; setQueueBusy(false); }
  }
  async function queueAction(action: 'pause' | 'resume' | 'remove' | 'steer', queueId?: string) {
    const id = activeId;
    if (!id || queueOperation.current || configOperation.current || historyOperation.current || detailRef.current?.history?.pendingRecovery || ((action === 'remove' || action === 'steer') && !queueId)) return;
    queueOperation.current = true; setQueueBusy(true); setError('');
    const cursor = detail?.lastEventId ?? 0;
    try {
      const queue = action === 'steer'
        ? await post<QueueState>(`/sessions/${id}/queue/${encodeURIComponent(queueId!)}/steer`)
        : action === 'remove'
        ? await api<QueueState>(`/sessions/${id}/queue/${encodeURIComponent(queueId!)}`, { method: 'DELETE' })
        : await post<QueueState>(`/sessions/${id}/queue/${action}`);
      // The detail cursor survives journal pruning; a bare response must not replace newer SSE/snapshot state.
      setDetail(current => current?.session.id === id && (current.lastEventId ?? 0) <= cursor ? { ...current, queue } : current);
      if (currentId.current === id) void refreshDetail(id).catch(e => setError(errorMessage(e)));
    } catch (e) { if (currentId.current === id) setError(errorMessage(e)); }
    finally { queueOperation.current = false; setQueueBusy(false); }
  }
  async function cancelTask(task: DelegationSummary) {
    const id = task.parentSessionId, view = selectionRequest.current;
    const stillHere = () => currentId.current === id && selectionRequest.current === view;
    const current = detailRef.current && visibleDelegations(detailRef.current).find(item => item.id === task.id);
    if (!stillHere() || !current || current.status !== 'running' || taskOperations.current.has(task.id)) return;
    taskOperations.current.add(task.id); setCancellingTasks(new Set(taskOperations.current));
    setTaskErrors(errors => { const next = new Map(errors); next.delete(task.id); return next; });
    let failure = '';
    try { await post(delegationPath(task) + '/cancel'); }
    catch (e) { failure = errorMessage(e); }
    finally {
      try { if (stillHere()) await refreshDetail(id); }
      catch (e) { failure += `${failure ? ' ' : ''}Could not refresh task status: ${errorMessage(e)}.`; }
      if (stillHere() && failure) setTaskErrors(errors => new Map(errors).set(task.id, failure));
      taskOperations.current.delete(task.id); setCancellingTasks(new Set(taskOperations.current));
    }
  }
  function changeQuestionDraft(id: string, value: QuestionDraft) {
    setQuestionDrafts(current => new Map(current).set(id, value));
    setQuestionErrors(current => { const next = new Map(current); next.delete(id); return next; });
  }
  async function answerQuestion(request: QuestionRequest, answer: QuestionAnswer) {
    const { sessionId: id, id: questionId } = request, view = selectionRequest.current;
    const stillHere = () => currentId.current === id && selectionRequest.current === view;
    if (!stillHere() || busy || historyOperation.current || cancelling.current.has(id) || answerOperations.current.has(questionId) || resolvedQuestions.current.has(questionId) || !detailRef.current?.questions?.some(question => question.id === questionId && question.sessionId === id)) return;
    answerOperations.current.add(questionId); setAnswering(current => new Set(current).add(questionId));
    setQuestionErrors(current => { const next = new Map(current); next.delete(questionId); return next; });
    let failure = '';
    try {
      await post(`/sessions/${id}/questions/${encodeURIComponent(questionId)}/answer`, answer);
      resolvedQuestions.current.add(questionId);
      setQuestionDrafts(current => { const next = new Map(current); next.delete(questionId); return next; });
      // Remove only this globally unique request; never copy a stale response into session state.
      if (stillHere()) setDetail(current => current?.session.id === id ? { ...current, questions: (current.questions ?? []).filter(question => question.id !== questionId) } : current);
    } catch (e) { failure = errorMessage(e); }
    finally {
      try { await refreshDetail(id); }
      catch (e) {
        if (stillHere()) {
          if (resolvedQuestions.current.has(questionId)) setError(`Answer accepted or question resolved, but refreshing failed: ${errorMessage(e)}. Reload to check the response.`);
          else failure += `${failure ? ' ' : ''}Could not refresh the question: ${errorMessage(e)}.`;
        }
      }
      if (failure && stillHere() && !resolvedQuestions.current.has(questionId) && !cancelling.current.has(id)) setQuestionErrors(current => new Map(current).set(questionId, failure));
      answerOperations.current.delete(questionId);
      setAnswering(current => { const next = new Set(current); next.delete(questionId); return next; });
    }
  }
  async function stopResponse(id: string) {
    if (currentId.current !== id || cancelling.current.has(id)) return;
    const view = selectionRequest.current, stillHere = () => currentId.current === id && selectionRequest.current === view;
    cancelling.current.add(id); setBusy(true); setError('');
    let failure = '';
    try { await post(`/sessions/${id}/cancel`); }
    catch (e) { failure = errorMessage(e); }
    finally {
      try { await refreshDetail(id); } catch (e) { failure += `${failure ? ' ' : ''}Could not refresh the stopped response: ${errorMessage(e)}.`; }
      if (failure && stillHere()) setError(failure);
      cancelling.current.delete(id); setBusy(false);
    }
  }
  function saveSettings(next: SettingsType) {
    setSettings(next); setRefreshKey(v => v + 1);
    if (!activeId && !pendingSession.current && !submissionOperation.current) {
      setSelection(s => ({ ...s, providerId: next.defaultProvider, model: next.defaultModel, permissionMode: next.permissionMode }));
      if (next.workspace !== settings?.workspace) { setNewProfile(null); setProfileDialog(null); selectionRequest.current++; }
    }
  }
  function askDelete(session: Session) {
    const clearDeletedDraft = prepareDelete(session.id);
    setConfirm({ title: 'Delete this session?', description: `“${session.title}” and its conversation history will be permanently removed. Your workspace files will not be deleted.`, label: 'Delete session', danger: true, action: async () => {
      await api(`/sessions/${session.id}`, { method: 'DELETE' });
      const draftWarning = clearDeletedDraft();
      if (currentId.current === session.id) newSession();
      if (draftWarning) setError(`Session deleted. ${draftWarning}`);
      await refreshSessions(); setToast('Session deleted');
    } });
  }
  async function moveHistory(id: string, action: 'undo' | 'redo' | 'recover' | 'legacy', checkpointId?: string) {
    if (currentId.current !== id || configOperation.current || historyOperation.current || submissionOperation.current || queueOperation.current || busy) return;
    const current = detailRef.current, state = current?.history;
    if (current?.session.id !== id || current.session.status === 'running' || current.session.status === 'waiting') return;
    if (action === 'legacy' ? state?.hasCheckpoints !== false || state.pendingRecovery
      : action === 'recover' ? !state?.pendingRecovery
      : state?.pendingRecovery || !checkpointId || (action === 'undo' ? !state?.canUndo || state.undoId !== checkpointId : !state?.canRedo || state.redoId !== checkpointId)) {
      setError('Turn history changed. Review the latest state before trying again.');
      await refreshDetail(id).catch(e => { if (currentId.current === id) setError(errorMessage(e)); });
      return;
    }
    const view = selectionRequest.current;
    const stillHere = () => currentId.current === id && selectionRequest.current === view;
    historyOperation.current = true; setHistoryBusy(true); setError('');
    let failure = '', accepted = false;
    try {
      await post(`/sessions/${id}/${action === 'legacy' ? 'undo' : `history/${action}`}`, checkpointId ? { checkpointId } : {});
      accepted = true;
    } catch (e) { failure = errorMessage(e); }
    finally {
      // Failed restores can have durable partial progress. Always reload history, files and queue.
      try { await refreshDetail(id); }
      catch (e) { failure += `${failure ? ' ' : ''}Could not refresh history: ${errorMessage(e)}. Reload before continuing.`; }
      if (stillHere()) {
        setRefreshKey(value => value + 1);
        if (failure) setError(failure);
        if (accepted) setToast(action === 'undo' ? 'Last turn undone. Queued messages remain paused.' : action === 'redo' ? 'Turn restored without replay. Queued messages remain paused.' : action === 'recover' ? 'History recovered. Review before resuming queued messages.' : 'Session file changes restored');
      }
      void refreshSessions().catch(() => {});
      historyOperation.current = false; setHistoryBusy(false);
    }
  }
  function askHistory(action: 'undo' | 'redo' | 'recover' | 'legacy') {
    if (!activeId || historyDisabled || historyOperation.current || submissionOperation.current || queueOperation.current) return;
    const id = activeId, state = detailRef.current?.history;
    if (action === 'legacy' ? !legacyUndo : action === 'recover' ? !state?.pendingRecovery : state?.pendingRecovery || (action === 'undo' ? !state?.canUndo : !state?.canRedo)) return;
    const checkpointId = action === 'undo' ? state?.undoId : action === 'redo' ? state?.redoId : undefined;
    const label = action === 'undo' ? 'Undo last turn' : action === 'redo' ? 'Redo turn' : action === 'recover' ? 'Recover history' : 'Undo session changes';
    const description = action === 'legacy'
      ? 'Restore all file edits recorded by this legacy session, not a single turn. Changed files are not overwritten. Shell commands, MCP actions and terminal effects cannot be reversed.'
      : `${action === 'undo' ? 'Remove the last accepted turn from the conversation and restore its recorded file edits and plan.' : action === 'redo' ? 'Restore the saved conversation, recorded file edits and plan for this turn. No provider request is replayed.' : 'Finish interrupted history work after checking the listed paths. Conflicting files must be restored to their expected state before recovery can finish.'} Queued messages stay paused until you explicitly resume them. ${state?.effectsNotice || 'Shell commands, MCP actions and terminal effects are not reversed or replayed.'}`;
    setConfirm({ title: action === 'legacy' ? 'Undo this session’s file changes?' : `${label}?`, description, label, sessionId: id, historyAction: true, action: () => moveHistory(id, action, checkpointId) });
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
      <div className="sidebar-top"><button className="new-session" onClick={newSession}><Plus size={17} /><span>New session</span><kbd>⌘ N</kbd></button></div>
      <div className="sessions-heading"><span>{archived ? 'Archived sessions' : 'Your sessions'}</span><button className={`icon-button ${archived ? 'selected' : ''}`} aria-label={archived ? 'Show recent sessions' : 'Show archived sessions'} title={archived ? 'Show recent sessions' : 'Show archived sessions'} onClick={() => setArchived(v => !v)}><Archive size={14} /></button></div>
      {sessions.length > 5 || search ? <div className="session-search"><Search size={13} /><input aria-label="Filter sessions" placeholder="Filter sessions…" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear session search" onClick={() => setSearch('')}><X size={12} /></button>}</div> : null}
      <div className="session-list">{loading ? <div className="sidebar-loading"><SpeedRail compact active /><span>Loading your space…</span></div> : groups.map(group => group.rows.length > 0 && <section className="session-group" key={group.title}><h3>{group.title}</h3>{group.rows.map(session => <div className={`session-row ${activeId === session.id ? 'active' : ''}`} key={session.id}><button className="session-link" onClick={() => navigate(session.id)} title={session.title}><MessageSquare size={14} /><span>{session.title || 'Untitled session'}</span>{(session.status === 'running' || session.status === 'waiting') && activeId !== session.id && <span className={`session-activity ${session.status}`} aria-label={session.status} />}</button><details className="session-context"><summary aria-label={`Actions for ${session.title}`}><MoreHorizontal size={16} /></summary><div className="session-context-menu"><button onClick={e => { setRename(session); setRenameValue(session.title); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Pencil size={13} />Rename</button><button disabled={busy} onClick={e => { void archive(session); e.currentTarget.closest('details')?.removeAttribute('open'); }}>{session.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}{session.archived ? 'Restore' : 'Archive'}</button><button className="danger" disabled={session.status === 'running' || session.status === 'waiting'} onClick={e => { askDelete(session); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Trash2 size={13} />Delete</button></div></details></div>)}</section>)}
        {!loading && !visibleSessions.length && <div className="sidebar-empty"><MessageSquare size={20} /><p>{search ? 'No matching sessions' : archived ? 'No archived sessions' : 'A little space for what’s next.'}</p><span>{search ? 'Try another search.' : archived ? 'Archive sessions to keep things tidy.' : 'Your conversations will live here.'}</span></div>}
      </div>
      <div className="sidebar-bottom"><button className="sidebar-footer-button" onClick={() => importInput.current?.click()}><Upload size={15} /><span>Import session</span></button><div className="workspace-identity"><span className="workspace-avatar"><Terminal size={16} /></span><div><strong>{workspace.split('/').filter(Boolean).at(-1) || 'Your workspace'}</strong><span>On your machine</span></div><button className="icon-button" aria-label="Settings" title="Settings" disabled={!settings} onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button></div></div>
    </aside>
    <main className="main" id="main-content"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><span className="breadcrumb-project"><Folder size={14} />{workspace.split('/').filter(Boolean).at(-1) || 'Workspace'}</span><span className="breadcrumb-slash">/</span><span className="topbar-title">{detail?.session.title || (activeId ? 'Session' : 'New session')}</span></div><div className="topbar-actions">{detail && <>{!running && <span className={`session-state ${detail.session.status}`}><span />{detail.session.status === 'running' ? 'Working' : detail.session.status === 'waiting' ? detail.questions?.length ? 'Needs answer' : 'Needs approval' : detail.session.status === 'error' ? 'Run error' : detail.session.archived ? 'Archived' : 'Saved locally'}</span>}<div className="session-menu-wrap"><button className="icon-button" aria-label="Session actions" aria-expanded={sessionMenu} onClick={() => setSessionMenu(v => !v)}><MoreHorizontal size={19} /></button>{sessionMenu && <><button className="menu-dismiss" aria-label="Close session actions" onClick={() => setSessionMenu(false)} /><div className="session-menu"><button onClick={() => { setRename(detail.session); setRenameValue(detail.session.title); setSessionMenu(false); }}><Pencil size={14} />Rename session</button><button disabled={running || busy || goal?.status === 'active'} onClick={() => { setGoalText(''); setGoalTurns('10'); setGoalModal(true); setSessionMenu(false); }}><Target size={14} />Set session goal</button><button disabled={running || busy} onClick={() => { void fork(); setSessionMenu(false); }}><GitFork size={14} />Fork conversation</button><button disabled={running || !latestContext} onClick={() => { setContextSession(activeId); setSessionMenu(false); }}><FileCode2 size={14} />Context details</button><button onClick={() => { void exportSession(); setSessionMenu(false); }}><Download size={14} />Export session</button><button disabled={running || busy} onClick={() => { setSessionMenu(false); setConfirm({ title: 'Compact this conversation?', description: 'Summarize older context to make room for your next steps. This changes the context used by future model calls.', label: 'Compact context', action: async () => { await post(`/sessions/${activeId}/compact`); await refreshDetail(activeId!); setToast('Conversation compacted'); } }); }}><ArrowDownToLine size={14} />Compact context</button>{history && <><button disabled={historyDisabled || Boolean(history.pendingRecovery) || !history.canUndo || !history.undoId} onClick={() => { askHistory('undo'); setSessionMenu(false); }}><Undo2 size={14} />Undo last turn</button><button disabled={historyDisabled || Boolean(history.pendingRecovery) || !history.canRedo || !history.redoId} onClick={() => { askHistory('redo'); setSessionMenu(false); }}><Redo2 size={14} />Redo turn</button></>}{legacyUndo && <button disabled={historyDisabled} onClick={() => { askHistory('legacy'); setSessionMenu(false); }}><Undo2 size={14} />Undo session file changes</button>}<button onClick={() => { void archive(detail.session); setSessionMenu(false); }}><Archive size={14} />{detail.session.archived ? 'Restore session' : 'Archive session'}</button><button onClick={() => { setSessionMenu(false); void act(async () => { await api(`/sessions/${activeId}/tool-grants`, {method:'DELETE'}); setToast('Remembered tool approvals cleared. Auto mode is unchanged.'); }); }}><Shield size={14} />Reset remembered approvals</button><hr /><button className="danger" disabled={running} onClick={() => { askDelete(detail.session); setSessionMenu(false); }}><Trash2 size={14} />Delete session</button></div></>}</div></>}
        {detail && <button className={`icon-button ${terminalOpen ? 'selected' : ''}`} aria-label={terminalOpen ? 'Hide terminal pane' : 'Open terminal'} aria-expanded={terminalOpen} title="Open a local shell (not sandboxed)" onClick={() => setTerminalOpen(v => !v)}><Terminal size={18} /></button>}
        <button className={`icon-button workspace-toggle ${workspaceOpen ? 'selected' : ''}`} aria-label={workspaceOpen ? 'Hide workspace panel' : 'Show workspace panel'} title="Files, changes, and plan" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen(v => !v)}><PanelRight size={18} /></button></div></header>
      {error && <div className="global-alert" role="alert"><span>{error}</span>{!settings ? <button onClick={() => void load()}>Retry connection</button> : activeId && !detail ? <button onClick={() => { setError(''); setSessionReload(v => v + 1); }}>Retry</button> : null}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      <div className="main-panels"><div className={`main-stage ${!activeId ? 'welcome-stage' : ''}`}>
        {loading ? <div className="app-loading"><Logo /><SpeedRail active /><p>Opening your workspace…</p></div> : !settings ? <EmptyState icon={<Terminal size={30} />} title="Let’s get connected.">The local server is not available. Check that Lite is running, then retry the connection.<button className="button primary" onClick={() => void load()}>Try again</button></EmptyState> : activeId ? <>
          {goalVisible && detail && <div className={`goal-banner ${goal.status}`} role="status"><Target size={14} /><div className="goal-banner-body"><strong>{goal.status === 'blocked' ? 'Goal paused' : 'Session goal'}</strong><span title={goal.text}>{goal.text}</span></div><span className="goal-banner-turns">Turn {goal.turns} of {goal.maxTurns}</span><button className="button secondary" disabled={busy || running} onClick={() => void clearSessionGoal()}>Clear goal</button></div>}
          {sessionLoading ? <div className="app-loading"><SpeedRail active /><p>Opening this conversation…</p></div> : detail ? <Conversation detail={detail} connection={connection} busy={busy} renderTask={(tool, message, expanded) => {
            const task = delegations.find(item => item.id === tool.delegationId && item.toolCallId === tool.id && item.parentMessageId === message.id);
            return task || actors.has(`${message.id}:${tool.id}`) ? <TaskCard task={task} tool={tool} label={actors.get(`${message.id}:${tool.id}`)} awaitingApproval={detail.permissions.some(request => request.toolCallId === tool.id)} expanded={expanded} onCancel={() => { if (task) void cancelTask(task); }} cancelling={Boolean(task && cancellingTasks.has(task.id))} error={task && taskErrors.get(task.id)} /> : null;
          }} onDecide={(id, decision) => void act(async () => { await post(`/sessions/${activeId}/permissions/${id}`, { decision }); await refreshDetail(activeId); })} onFork={messageId => void fork(messageId)} renderQuestion={request => <QuestionCard key={request.id} request={request} draft={questionDrafts.get(request.id) ?? emptyQuestionDraft()} onChange={value => changeQuestionDraft(request.id, value)} onAnswer={answer => answerQuestion(request, answer)} onStop={() => void stopResponse(request.sessionId)} busy={answering.has(request.id)} disabled={busy || historyBusy || Boolean(history?.pendingRecovery)} error={questionErrors.get(request.id)} />} /> : <EmptyState title="This session couldn’t be opened">Choose another session, or start a fresh one.<button className="button secondary" onClick={newSession}><Plus size={15} />New session</button></EmptyState>}
          {detail && <div className="chat-composer">{history?.pendingRecovery && <TurnHistory history={history} disabled={historyDisabled} busy={historyBusy} running={running} preparing={submissionBusy || queueBusy} onAction={askHistory} />}<CommandArea key={activeId} commands={commands} text={text} setText={setText}><Composer key={activeId} settings={settings} selection={selection} onSelection={v => void changeSelection(v)} selectionDisabled={selectionDisabled} onSend={(content, files) => send(expandSlashCommand(content, commands), files)} onQueue={(content, files) => queueMessage(expandSlashCommand(content, commands), files)} onSteer={content => steerMessage(content)} queue={detail.queue} queueBusy={queueBusy} onQueueAction={(action, queueId) => void queueAction(action, queueId)} onCancel={() => void stopResponse(activeId)} running={running} disabled={composerDisabled} workspace={workspace} text={text} setText={setText} attachments={attachments} setAttachments={setAttachments} draftNotice={draftNotice} onSettings={() => setSettingsOpen(true)} /></CommandArea></div>}
          {terminalOpen && detail && <div className="terminal-dock"><Suspense fallback={<div className="app-loading"><SpeedRail compact active /><p>Opening terminal…</p></div>}><SessionTerminal key={activeId} sessionId={activeId} onClose={() => setTerminalOpen(false)} /></Suspense></div>}
        </> : <div className="welcome"><h1>Lite<span>.</span></h1>
          <div className="welcome-input"><CommandArea commands={commands} text={text} setText={setText}><Composer settings={settings} selection={selection} onSelection={v => void changeSelection(v)} selectionDisabled={selectionDisabled} onSend={(content, files) => send(expandSlashCommand(content, commands), files)} onCancel={() => {}} running={false} disabled={composerDisabled} welcome workspace={workspace} text={text} setText={setText} attachments={attachments} setAttachments={setAttachments} draftNotice={draftNotice} onSettings={() => setSettingsOpen(true)} /></CommandArea></div>
          <div className="suggestions">{suggestions.map(({ Icon, label, description, prompt }) => <button key={label} onClick={() => { setText(prompt); document.getElementById('message-input')?.focus(); }}><span className="suggestion-icon"><Icon size={17} /></span><span><strong>{label}</strong><small>{description}</small></span><ArrowRight className="suggestion-arrow" size={14} /></button>)}</div>
          {(!provider?.configured && provider?.baseUrl && !/localhost|127\.0\.0\.1/.test(provider.baseUrl)) && <button className="setup-hint" onClick={() => setSettingsOpen(true)}><Shield size={13} />Connect your provider to get started<ArrowRight size={13} /></button>}
        </div>}
      </div>{workspaceOpen && settings && <Workspace workspace={workspace} sessionId={activeId ?? undefined} todos={detail?.todos ?? []} refreshKey={refreshKey} onClose={() => setWorkspaceOpen(false)} onUndo={legacyUndo ? () => askHistory('legacy') : undefined} running={historyDisabled} />}</div>
    </main>
    <input type="file" accept="application/json,.json" hidden tabIndex={-1} ref={importInput} aria-label="Import session JSON" onChange={e => { const f = e.target.files?.[0]; if (f) void importSession(f); e.target.value = ''; }} />
    {!settingsOpen && profileDialog && profileDialog.id === activeId && <ProfilePicker key={`${profileDialog.id ?? 'new'}-${profileDialog.view}`} workspace={profileDialog.workspace} sessionId={profileDialog.id} initialChoice={profileDialog.choice} selection={profileDialog.selection} disabled={selectionDisabled} onClose={closeProfiles} onApply={applyProfile} />}
    {contextSession && contextSession === activeId && !running && latestContext && <Modal title="Context details" onClose={() => setContextSession(null)}><div className="context-dialog"><ContextIndicator context={latestContext} /></div></Modal>}
    {settingsOpen && settings && <Settings settings={settings} profilesDisabled={selectionDisabled} onProfiles={() => { setSidebarOpen(false); openProfiles(); }} profiles={profileDialog && profileDialog.id === activeId ? <ProfilePicker embedded key={`${profileDialog.id ?? 'new'}-${profileDialog.view}`} workspace={profileDialog.workspace} sessionId={profileDialog.id} initialChoice={profileDialog.choice} selection={profileDialog.selection} disabled={selectionDisabled} onClose={closeSettings} onApply={applyProfile} /> : null} onClose={closeSettings} onSave={saveSettings} />}
    {paletteOpen && <CommandPalette sessions={sessions} commands={commands} onClose={closePalette} onSession={navigate} onPrompt={p => { setText(p); setPaletteOpen(false); setTimeout(() => document.getElementById('message-input')?.focus(), 50); }} actions={[{ name: 'New session', description: 'Start with a clean slate', Icon: Plus, run: newSession, shortcut: '⌘ N' }, { name: 'Settings', description: 'Models, providers, and workspace', Icon: Settings2, run: () => setSettingsOpen(true) }, { name: 'Toggle workspace', description: 'Files, Git changes, and plan', Icon: PanelRight, run: () => setWorkspaceOpen(v => !v) }, { name: 'Import session', description: 'Restore a conversation from JSON', Icon: Upload, run: () => importInput.current?.click() }, ...(activeId ? [{ name: 'Export session', description: 'Save this conversation as JSON', Icon: Download, run: () => void exportSession() }] : [])]} />}
    {goalModal && activeId && <Modal title="Set session goal" onClose={closeGoal}><form className="rename-form" onSubmit={e => { e.preventDefault(); void setSessionGoal(); }}><label>Goal<textarea autoFocus rows={3} maxLength={2000} placeholder="One objective to pursue across multiple turns…" value={goalText} onChange={e => setGoalText(e.target.value)} /></label><label>Max turns (1-25)<input type="number" min={1} max={25} value={goalTurns} onChange={e => setGoalTurns(e.target.value)} /></label><p className="goal-hint">The assistant reports progress each turn and the host continues automatically until the goal completes, blocks, or reaches the turn limit. Cancelling a response pauses continuation; your next message resumes it.</p><div className="form-actions"><button className="button secondary" type="button" onClick={closeGoal}>Cancel</button><button className="button primary" disabled={!goalText.trim() || busy}>Set goal</button></div></form></Modal>}
    {rename && <Modal title="Rename session" onClose={closeRename}><form className="rename-form" onSubmit={e => { e.preventDefault(); void act(async () => { const session = await patch<Session>(`/sessions/${rename.id}`, { title: renameValue.trim() }); setSessions(list => list.map(s => s.id === session.id ? session : s)); if (activeId === session.id) setDetail(d => d ? { ...d, session } : d); setRename(null); }); }}><label>Session name<input autoFocus maxLength={160} value={renameValue} onChange={e => setRenameValue(e.target.value)} /></label><div className="form-actions"><button className="button secondary" type="button" onClick={closeRename}>Cancel</button><button className="button primary" disabled={!renameValue.trim() || busy}>Save name</button></div></form></Modal>}
    {confirm && (!confirm.sessionId || confirm.sessionId === activeId) && <Modal title={confirm.title} onClose={closeConfirm}><div className="confirm-content"><p>{confirm.description}</p><div className="form-actions"><button className="button secondary" onClick={closeConfirm} disabled={busy || historyBusy}>Cancel</button><button className={`button ${confirm.danger ? 'destructive' : 'primary'}`} disabled={confirm.historyAction ? historyDisabled : busy} onClick={() => {
      const current = confirm;
      if (current.historyAction) void current.action().finally(() => setConfirm(value => value === current ? null : value));
      else void act(async () => { await current.action(); setConfirm(value => value === current ? null : value); });
    }}>{busy || historyBusy ? 'Working…' : confirm.label}</button></div></div></Modal>}
    {toast && <div className="toast" role="status"><Check size={15} />{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={13} /></button></div>}
  </div>;
}

function CommandArea({ commands, text, setText, children }: { commands: SlashCommand[]; text: string; setText: (value: string) => void; children: ReactNode }) {
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const token = text.match(/^\/([\w-]*)/);
  const matches = token && caret >= 1 && caret <= token[0].length && !dismissed ? commands.filter(c => c.name.toLowerCase().startsWith(token[1].toLowerCase())).slice(0, 8) : [];
  const open = matches.length > 0;
  const highlighted = open ? Math.min(selected, matches.length - 1) : -1;
  const exact = text.match(/^\/(\S+)(?:\s|$)/);
  const active = exact ? commands.find(c => c.name === exact[1]) : undefined;
  useEffect(() => {
    const input = document.getElementById('message-input');
    if (!input) return;
    if (open) { input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'command-popover'); input.setAttribute('aria-activedescendant', `command-option-${highlighted}`); }
    else { input.removeAttribute('aria-expanded'); input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant'); }
  }, [open, highlighted]);
  function sync(e: SyntheticEvent) { const target = e.target as HTMLElement; if (target instanceof HTMLTextAreaElement && target.id === 'message-input') setCaret(target.selectionStart ?? 0); }
  function accept(command: SlashCommand) {
    const rest = text.slice(token?.[0].length ?? 0).replace(/^ /, '');
    setText(`/${command.name} ${rest}`);
    setSelected(0); setCaret(command.name.length + 2);
    const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
    if (input) { input.focus(); setTimeout(() => input.setSelectionRange(command.name.length + 2, command.name.length + 2), 0); }
  }
  function keydown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (!open || !(target instanceof HTMLTextAreaElement) || target.id !== 'message-input') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSelected(Math.min(highlighted + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSelected(Math.max(highlighted - 1, 0)); }
    else if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); accept(matches[highlighted]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); }
  }
  return <div className="command-area" onKeyDownCapture={keydown} onKeyUp={sync} onClick={sync} onInput={e => { sync(e); setDismissed(false); setSelected(0); }}>
    {open && <div className="command-popover" id="command-popover" role="listbox" aria-label="Workspace commands">{matches.map((c, i) => <button key={c.name} id={`command-option-${i}`} role="option" aria-selected={i === highlighted} tabIndex={-1} className={i === highlighted ? 'selected' : ''} onMouseMove={() => setSelected(i)} onMouseDown={e => e.preventDefault()} onClick={() => accept(c)}><strong>/{c.name}</strong><small>{c.description}</small></button>)}</div>}
    {children}
    {active && <div className="command-hint" role="status">Command: {active.name} — {active.description}</div>}
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
