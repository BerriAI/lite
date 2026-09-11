/** @jsxImportSource @opentui/react */
import { goalTurnLabel } from '../shared/goals.js';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useBlur, useFocus, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from '@opentui/react';
import type { TextareaRenderable } from '@opentui/core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Message, Session } from '../shared/types.js';
import { terminalText, parseSlash } from './protocol.js';
import type { ProfileCatalog, ProjectSkill } from '../shared/profiles.js';
import { skillCommand, skillCommands } from '../shared/skill-commands.js';
import { Profiles } from './profiles.js';
import { TerminalController, effectiveModel, isRunning } from './controller.js';
import { ConfigContext, ThemeContext, useConfig, useTheme } from './context.js';
import { getTheme, listThemes, toHex, type Theme } from './theme.js';
import { BUILTIN_THEMES } from './themes.js';
import type { TuiConfig } from './tuiConfig.js';
import type { TerminalStorage } from './storage.js';
import { KEYBIND_DEFAULTS } from './keybinds.js';
import { ACTIVE_KEY_ACTIONS, COMMAND_ORDER, KEY_COMMANDS } from './commands.js';
import { parseBinding, strokeMatches, LEADER_TOKEN, type KeymapRouter } from './keymap.js';
import { Button, Menu, TextPrompt, TextViewer, type MenuItem } from './ui.js';
import { EditorKeys } from './editor.js';
import { Sessions } from './sessions.js';
import { FilePicker } from './files.js';
import { attachmentFromFile, editDraft, openShell, suspendTerminal } from './terminalIO.js';
import { Changes, WorkInspector, WorkerInspector } from './inspectors.js';
import { conversationGroups, usageDetails } from './conversation.js';
import { TaskProgress } from './tasks.js';
import { UpdateNotice } from './updates.js';
import { Brand } from './brand.js';
import { needsSetup } from '../shared/setup.js';
import { Onboarding } from './onboarding.js';
import { workerLabels } from '../shared/worker-presentation.js';
import { ModelSettings } from './models.js';
import { GoalPanel, PlanPanel, HistoryPanel } from './sessionPanels.js';
import { SettingsPanel } from './settings.js';
import { expandProjectCommand, type ProjectCommand } from './projectCommands.js';
import { Providers } from './providers.js';
import { copyTerminalText } from './clipboard.js';
import { PermissionPrompt, QuestionPrompt } from './prompts.js';
import { DEFAULT_TRANSCRIPT_SETTINGS, InterruptHint, Transcript, TranscriptSettingsProvider, WorkingScanner, type TranscriptSettings } from './transcript.js';

export const LOADING_GRACE_MS = 500;
export const LOADING_DOT_MS = 3000;
function LoadingScreen() {
  const theme = useTheme(), [visible, setVisible] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setVisible(true), LOADING_GRACE_MS); return () => clearTimeout(timer); }, []);
  return <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">{visible && <><Brand /><box marginTop={1} flexDirection="row" gap={1}><WorkingScanner color={toHex(theme.primary)} /><text fg={toHex(theme.textMuted)}>Connecting to Litespeed…</text></box></>}</box>;
}

function Composer({ controller, focused, onSubmit, onReference, commands }: { commands: {name: string; description: string}[]; controller: TerminalController; focused: boolean; onSubmit: () => void; onReference: (prefix: string) => void }) {
  const theme = useTheme(), editor = useRef<TextareaRenderable>(null);
  const { draft, pending } = useSyncExternalStore(controller.subscribe, controller.getState);
  const { height, width } = useTerminalDimensions(), config = useConfig();
  const editorKeys = useMemo(() => new EditorKeys(config.keybinds), [config.keybinds]);
  useEffect(() => () => editorKeys.dispose(), [editorKeys]);
  useEffect(() => { if (editor.current && editor.current.plainText !== draft.text) editor.current.setText(draft.text); }, [draft.text]);
  const [selected, setSelected] = useState(0), [dismissed, setDismissed] = useState(false);
  const token = draft.text.match(/^\/([\w-]*)$/);
  const matches = focused && token && !dismissed ? commands.filter(item => item.name.startsWith(token[1].toLowerCase())) : [];
  const highlighted = Math.min(selected, Math.max(0, matches.length - 1));
  const visibleCount = Math.min(6, Math.max(2, Math.floor(height / 4)));
  const start = Math.max(0, highlighted - visibleCount + 1);
  function accept(name: string) {
    const text = `/${name} `;
    if (editor.current) { editor.current.setText(text); editor.current.cursorOffset = text.length; }
    controller.setDraft({...controller.getState().draft, text}); setDismissed(true);
  }
  const rows = Math.min(Math.max(1, draft.text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / Math.max(10, width - 6))), 0)), Math.max(1, Math.min(12, Math.floor(height * config.prompt.max_height / 100) - 4)));
  return <box flexDirection="column" flexShrink={0} width={config.prompt.max_width === 'auto' ? '100%' : Math.min(width, config.prompt.max_width)} alignSelf="center">
    {matches.length > 0 && <box flexDirection="column" paddingLeft={2} paddingRight={2} marginBottom={1} flexShrink={0}>
      {matches.slice(start, start + visibleCount).map((item, offset) => <box key={item.name} height={1} backgroundColor={start + offset === highlighted ? toHex(theme.backgroundElement) : undefined} onMouseDown={() => accept(item.name)}><text fg={toHex(start + offset === highlighted ? theme.primary : theme.textMuted)}>{terminalText(`${start + offset === highlighted ? '›' : ' '} /${item.name}  ${item.description}`).slice(0, width - 6)}</text></box>)}
      <text height={1} fg={toHex(theme.textMuted)}>{`↑↓ choose · Tab/Enter complete · Esc dismiss${matches.length > visibleCount ? ` · ${highlighted + 1}/${matches.length}` : ''}`}</text>
    </box>}
    <box width={config.prompt.max_width === 'auto' ? '100%' : Math.min(width, config.prompt.max_width)} alignSelf="center" border borderColor={toHex(focused ? theme.primary : theme.border)} height={rows + 2} paddingLeft={1} paddingRight={1} flexShrink={0}>
    <textarea ref={editor} focused={focused} initialValue={draft.text} wrapMode="word"
      placeholder={pending ? `${pending}…` : isRunning(controller.detail) ? 'Queue a follow-up… (Alt+Enter to steer)' : 'Ask Litespeed to do something…'}
      backgroundColor={toHex(theme.background)} textColor={toHex(theme.text)}
      onKeyDown={key => {
        if (!editor.current) return;
        if (matches.length && !(key.name === 'return' && draft.text === `/${matches[highlighted].name}`) && !key.ctrl && !key.meta && !key.shift && ['up', 'down', 'tab', 'return', 'escape'].includes(key.name)) {
          key.preventDefault(); key.stopPropagation();
          if (key.name === 'escape') setDismissed(true);
          else if (key.name === 'up' || key.name === 'down') setSelected((highlighted + (key.name === 'up' ? -1 : 1) + matches.length) % matches.length);
          else accept(matches[highlighted].name);
          return;
        }
        const reference = /(?:^|\s)@([^\s]*)$/.exec(editor.current.plainText);
        if (key.name === 'tab' && reference) { key.preventDefault(); key.stopPropagation(); controller.setDraft({ ...controller.getState().draft, text: editor.current.plainText }); onReference(reference[1]); return; }
        editorKeys.handle(editor.current, key);
      }}
      onContentChange={() => { const text = editor.current?.plainText ?? ''; setSelected(0); setDismissed(false); if (text !== controller.getState().draft.text) controller.setDraft({ ...controller.getState().draft, text }); }}
      onSubmit={() => { controller.setDraft({ ...controller.getState().draft, text: editor.current?.plainText ?? '' }); onSubmit(); const next = controller.getState().draft.text; if (editor.current && next !== editor.current.plainText) editor.current.setText(next); }} />
    </box>
  </box>;
}

export interface AppProps { controller: TerminalController; config: TuiConfig; theme: Theme; themeName: string; storage: TerminalStorage; router: KeymapRouter; onQuit: (code?: number) => void }
export function App({ controller, config, theme: initialTheme, themeName: initialName, storage, router, onQuit }: AppProps) {
  const renderer = useRenderer(), [name, setName] = useState(initialName), [mode, setMode] = useState<'system' | 'light' | 'dark'>(storage.preferences().mode ?? 'system');
  const [terminalMode, setTerminalMode] = useState(renderer.themeMode ?? 'dark');
  useEffect(() => { const change = (mode: 'light' | 'dark') => setTerminalMode(mode); renderer.on('theme_mode', change); return () => { renderer.off('theme_mode', change); }; }, [renderer]);
  const theme = getTheme(name, mode === 'system' ? terminalMode : mode, BUILTIN_THEMES) ?? initialTheme;
  const chooseTheme = (next: string, nextMode: 'system' | 'light' | 'dark') => { setName(next); setMode(nextMode); try { storage.savePreferences({ theme: next, mode: nextMode }); } catch { controller.notice('Theme changed for this run; preferences could not be saved.'); } };
  return <ConfigContext.Provider value={config}><ThemeContext.Provider value={theme}><SessionApp controller={controller} router={router} onQuit={onQuit} chooseTheme={chooseTheme} themeName={name} themeMode={mode} /></ThemeContext.Provider></ConfigContext.Provider>;
}

function SessionApp({ controller, router, onQuit, chooseTheme, themeName, themeMode }: { controller: TerminalController; router: KeymapRouter; onQuit: (code?: number) => void; chooseTheme: (name: string, mode: 'system' | 'light' | 'dark') => void; themeName: string; themeMode: 'system' | 'light' | 'dark' }) {
  const theme = useTheme(), { width } = useTerminalDimensions(), renderer = useRenderer();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const config = useConfig(), terminalFocused = useRef(true), previousStatus = useRef<string | undefined>(undefined);
  useFocus(() => { terminalFocused.current = true; }); useBlur(() => { terminalFocused.current = false; });
  useSelectionHandler(selection => {
    const text = selection.getSelectedText();
    if (!selection.isDragging && text) void copyTerminalText(renderer, text).catch(error => controller.notice(error.message));
  });
  useEffect(() => { const status = state.sync.detail?.session.status; if (config.attention.enabled && config.attention.sounds !== false && (!config.attention.focus_only || terminalFocused.current) && previousStatus.current === 'running' && (status === 'waiting' || status === 'idle' || status === 'error')) process.stdout.write('\x07'); previousStatus.current = status; }, [state.sync.detail?.session.status]);
  const detail = state.sync.detail, busy = isRunning(detail);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [projectCommands, setProjectCommands] = useState<ProjectCommand[]>([]);
  useEffect(() => {
    setProjectCommands([]); setSkills([]); let live = true;
    if (detail) void controller.client.api<ProfileCatalog>(`/profiles?workspace=${encodeURIComponent(detail.session.workspace)}`).then(value => { if (live) setSkills(value.skills); }).catch(() => {});
    if (detail) void controller.client.api<{ commands: ProjectCommand[] }>(`/commands?workspace=${encodeURIComponent(detail.session.workspace)}`).then(value => { if (live) setProjectCommands(value.commands); }).catch(() => {});
    return () => { live = false; };
  }, [detail?.session.workspace, detail?.session.configRevision]);
  const [promptOverlay, setPromptOverlay] = useState(false);
  const [panel, setPanel] = useState<ReactNode>(null), [escPressed, setEscPressed] = useState(false);
  const [settings, setSettings] = useState<TranscriptSettings>(DEFAULT_TRANSCRIPT_SETTINGS);
  const lastCtrlC = useRef(0), escapeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingLeader = useSyncExternalStore(listener => router.subscribe(listener), () => router.pending.length > 0);
  const permission = detail?.permissions[0], question = !permission ? detail?.questions?.[0] : undefined;
  const close = () => setPanel(null);
  const run = (operation: () => unknown | Promise<unknown>) => { void Promise.resolve().then(operation).catch(error => controller.notice(error instanceof Error ? error.message : String(error))); };
  const menu = (title: string, items: MenuItem[]) => setPanel(<Menu key={title} title={title} items={items} onClose={close} />);
  const prompt = (title: string, value: string, save: (value: string) => unknown | Promise<unknown>) => setPanel(<TextPrompt key={title} title={title} value={value} onClose={close} onSave={value => { close(); run(() => save(value)); }} />);
  const toggle = (key: keyof TranscriptSettings) => setSettings(current => ({ ...current, [key]: !current[key] }));
  const sessions = () => setPanel(<Sessions controller={controller} onClose={close} />);
  const queue = () => {
    const current = controller.getState().sync.detail?.queue;
    menu('Queued messages', [{ id: 'toggle', label: current?.paused ? 'Resume queue' : 'Pause queue', description: current?.reason, action: () => { close(); run(() => controller.queue(current?.paused ? 'resume' : 'pause')); } }, ...(current?.items ?? []).map(item => ({ id: item.id, label: terminalText(item.content), description: 'Steer the driver or remove from queue', action: () => menu('Queued message', [{id:'steer',label:'Steer driver now',disabled:!isRunning(controller.detail) || Boolean(item.attachments?.length),action:()=>{close();run(()=>controller.steerQueued(item.id));}},{id:'remove',label:'Remove from queue',action:()=>{close();run(()=>controller.queue('remove',item.id));}}]) }))]);
  };
  const permissions = () => menu('Permissions', [
    { id: 'ask', label: `${controller.detail?.session.permissionMode === 'ask' ? '●' : '○'} Ask first`, description: 'Review actions; remember tools you trust for this session.', action: () => { close(); run(() => controller.permissionMode('ask')); } },
    { id: 'auto', label: `${controller.detail?.session.permissionMode === 'auto' ? '●' : '○'} Allow all tools`, description: 'This session and its workers. Explicit ask/deny rules still apply.', action: () => { close(); run(() => controller.permissionMode('auto')); } },
    { id: 'settings', label: 'Rules and defaults', action: () => openSettings() },
  ]);
  const openSettings = () => setPanel(<SettingsPanel controller={controller} onClose={close} />);
  const openModels = () => {
    if (!controller.detail || !controller.getState().settings) return;
    controller.configurationReady();
    setPanel(<ModelSettings controller={controller} initial={controller.detail.session} settings={controller.getState().settings!} onClose={close} onProviders={() => setPanel(<Providers controller={controller} onClose={close} />)} />);
  };
  const openSetup = (quick = false) => { controller.configurationReady(); if (controller.detail) setPanel(<Onboarding quick={quick} controller={controller} initial={controller.detail.session} onClose={close} />); };
  const inspect = useCallback((steps: Message[]) => { if (controller.detail) setPanel(<WorkInspector controller={controller} steps={steps} detail={controller.detail} onClose={() => setPanel(null)} />); }, [controller]);
  const showUsage = useCallback((message: Message, usage?: import('../shared/types.js').Usage) => setPanel(<TextViewer title="Turn usage" text={usageDetails(message, usage)} onClose={() => setPanel(null)} />), []);
  const attach = (filename: string) => controller.action('Attaching file', async () => {
    const current = controller.getState().draft;
    if (current.attachments.length >= 10) throw new Error('A message can have up to 10 attachments.');
    const attachment = await attachmentFromFile(filename, controller.detail!.session.workspace);
    controller.setDraft({ ...controller.getState().draft, attachments: [...controller.getState().draft.attachments, attachment] });
  });
  const copyResponse = () => { const text = renderer.getSelection()?.getSelectedText() || controller.detail?.messages.findLast(message => message.role === 'assistant' && message.content)?.content; if (text) run(async () => { await copyTerminalText(renderer, text); controller.notice('Copied.'); }); else controller.notice('There is no response to copy yet.'); close(); };
  const commands: MenuItem[] = [
    { id: 'copy', label: 'Copy selected text or last response', action: copyResponse },
    { id: 'timeline', label: 'Conversation timeline', description: 'Inspect, copy, or fork from a response', action: () => menu('Conversation timeline', conversationGroups(controller.detail!).filter(group => group.footer).reverse().map(group => ({ id: group.message.id, label: terminalText(group.message.content).slice(0, 100) || 'Response', action: () => menu('Response actions', [
      { id: 'read', label: 'Read response', action: () => setPanel(<TextViewer title="Response" text={group.message.content} onClose={close} />) },
      { id: 'copy', label: 'Copy response', action: () => { run(() => copyTerminalText(renderer, group.message.content)); close(); } },
      { id: 'usage', label: 'Turn usage', action: () => setPanel(<TextViewer title="Turn usage" text={usageDetails(group.message, group.runUsage)} onClose={close} />) },
      { id: 'fork', label: 'Fork from here', disabled: busy, action: () => { close(); run(() => controller.fork(group.message.id)); } },
    ]) }))) },

    { id: 'theme', label: 'Terminal theme', action: () => menu('Terminal theme', [{ id: 'mode', label: `Appearance: ${themeMode}`, description: 'Cycle system / light / dark', action: () => { chooseTheme(themeName, themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system'); close(); } }, ...listThemes(BUILTIN_THEMES).map(name => ({ id: name, label: `${name === themeName ? '● ' : ''}${name}`, action: () => { chooseTheme(name, themeMode); close(); } }))]) },
    { id: 'timestamps', label: 'Toggle timestamps', action: () => { toggle('timestamps'); close(); } },
    { id: 'outputs', label: 'Toggle tool output', action: () => { toggle('genericToolOutput'); close(); } },
    { id: 'animations', label: 'Toggle animations', action: () => { toggle('animations'); close(); } },
    { id: 'files', label: 'Add a workspace file reference', description: 'The server snapshots the file when you send', action: () => setPanel(<FilePicker controller={controller} onClose={close} onPick={file => { const draft = controller.getState().draft; if (draft.attachments.length >= 10) { controller.notice('A message can have up to 10 attachments.'); return; } controller.setDraft({ ...draft, attachments: [...draft.attachments, { name: file.name, path: file.path }] }); close(); }} />) },
    { id: 'attach', label: 'Attach a text file or image', description: 'Read a file from this computer', action: () => prompt('File to attach', '', attach) },
    { id: 'attachments', label: 'Manage draft attachments', action: () => menu('Draft attachments', controller.getState().draft.attachments.map((item, index) => ({ id: String(index), label: item.name, description: 'Select to remove', action: () => { const draft = controller.getState().draft; controller.setDraft({ ...draft, attachments: draft.attachments.filter((_, offset) => offset !== index) }); close(); } }))) },
    { id: 'editor', label: 'Open draft in external editor', description: 'Uses VISUAL or EDITOR, then returns to Litespeed', action: () => { close(); run(() => controller.action('Editing draft', async () => { const text = await editDraft(renderer, controller.getState().draft.text, controller.detail!.session.workspace); controller.setDraft({ ...controller.getState().draft, text }); })); } },
    { id: 'shell', label: 'Open workspace shell', description: 'Type exit to return to Litespeed', action: () => { close(); run(() => openShell(renderer, controller.detail!.session.workspace)); } },
    { id: 'skills', label: 'Browse and use project skills', disabled: busy, action: () => run(() => { controller.configurationReady(); if (controller.detail) setPanel(<Profiles skillsOnly controller={controller} initial={controller.detail.session} onCatalog={catalog => setSkills(catalog.skills)} onClose={close} />); }) },
    { id: 'commands', label: 'Project command templates', description: 'Workspace prompt templates with argument substitution', action: () => menu('Project commands', projectCommands.map(item => ({ id: item.name, label: `/${item.name}`, description: item.description, action: () => { controller.setDraft({ ...controller.getState().draft, text: `/${item.name} ` }); close(); } }))) },
    { id: 'drafts', label: 'Input history', description: 'Restore a previous message to the composer', action: () => menu('Input history', controller.inputHistory().reverse().map((text, index) => ({ id: String(index), label: terminalText(text).slice(0, 100), action: () => { controller.setDraft({ ...controller.getState().draft, text }); close(); } }))) },
    { id: 'export', label: 'Export session', description: 'Save this conversation as JSON', action: () => prompt('Export to file (new file)', `litespeed-session-${controller.sessionId}.json`, async filename => { const data = await controller.client.api(controller.path('/export')); const path = resolve(controller.detail!.session.workspace, filename); await writeFile(path, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 }); controller.notice(`Exported to ${path}`); }) },
    { id: 'import', label: 'Import session', description: 'Open an exported JSON conversation as a new session', action: () => prompt('Session JSON file', '', async filename => { const data = JSON.parse(await readFile(resolve(controller.detail!.session.workspace, filename), 'utf8')); let session: Session | undefined; if (await controller.action('Importing session', async () => { session = await controller.client.api<Session>('/sessions/import', data); }) && session) await controller.open(session.id); }) },
    { id: 'archive', label: detail?.session.archived ? 'Unarchive session' : 'Archive session', disabled: busy, action: () => { close(); run(() => controller.configure({ archived: !detail?.session.archived })); } },
    { id: 'delete', label: 'Delete session…', description: 'Permanently remove this conversation', disabled: busy, action: () => menu('Delete this session?', [{ id: 'cancel', label: 'Cancel', action: close }, { id: 'delete', label: 'Delete permanently', description: 'The conversation cannot be restored.', action: () => { close(); run(async () => { const workspace = controller.detail!.session.workspace; if (await controller.action('Deleting session', () => controller.client.api(controller.path(), undefined, 'DELETE'))) await controller.create(workspace); }); } }]) },

    { id: 'history', label: 'File history and recovery', description: 'Undo, Redo, interrupted operations, and protected paths', action: () => setPanel(<HistoryPanel controller={controller} onClose={close} />) },
    { id: 'notice', label: 'Read last notice', disabled: !state.notice, action: () => setPanel(<TextViewer title="Last notice" text={state.notice} onClose={close} />) },
    { id: 'goal', label: 'Session goal', description: 'Set an objective with an optional turn limit', action: () => setPanel(<GoalPanel controller={controller} onClose={close} />) },
    { id: 'todos', label: 'Task list', description: 'Follow the agent’s plan and progress', action: () => setPanel(<PlanPanel controller={controller} onClose={close} />) },
    { id: 'changes', label: 'Review changed files', description: 'Recorded file edits and diffs', action: () => setPanel(<Changes controller={controller} onClose={close} />) },
    { id: 'work', label: 'Inspect response steps', description: 'Thinking, commands, outputs, and worker assignments', action: () => menu('Response turns', conversationGroups(controller.detail!).filter(group => group.steps.some(message => message.reasoning || message.toolCalls?.length)).reverse().map((group, index) => ({ id: group.message.id, label: group.steps.find(message => message.content)?.content.slice(0, 100) || `Response ${index + 1}`, description: `${group.steps.flatMap(message => message.toolCalls ?? []).length} steps`, action: () => inspect(group.steps) }))) },
    { id: 'workers', label: 'Worker assignments', description: 'Brief, report, evidence, and invocation transcript', action: () => menu('Worker assignments', (controller.detail?.delegations ?? []).map(task => ({ id: task.id, label: `${workerLabels(controller.detail!).get(`${task.parentMessageId}:${task.toolCallId}`) || 'Research'} · ${task.description}`, description: `${task.role ?? 'research'} · ${task.status}`, action: () => setPanel(<WorkerInspector controller={controller} invocation={task} onClose={close} />) }))) },
    { id: 'fork', label: 'Fork session', description: 'Continue from a copy of this conversation', disabled: busy, action: () => { close(); run(() => controller.fork()); } },
    { id: 'compact', label: 'Compact context', description: 'Summarize earlier context for the next response', disabled: busy, action: () => { close(); run(() => controller.action('Compacting context', () => controller.client.api(controller.path('/compact'), {}))); } },
    { id: 'setup', label: 'Set up Litespeed', description: 'A quick guide to architecture, models, and permissions', disabled: busy, action: () => run(() => openSetup()) },
    { id: 'models', label: 'Choose models', description: 'Architecture, driver, worker, planner, and output style', disabled: busy, action: () => run(openModels) },
    { id: 'permissions', label: 'Permissions', description: 'Ask first or allow all tools, including workers', action: permissions },
    { id: 'settings', label: 'Settings', description: 'Providers, project profiles, permissions, integrations, and usage', action: openSettings },
    { id: 'sessions', label: 'Sessions', description: 'Switch sessions or start a new one', action: () => run(sessions) },
    ...['new', 'clear', 'reset'].map(id => ({ id, label: 'New session', description: 'Start with empty context; keep this session and its draft', action: () => { close(); run(() => controller.create(detail?.session.workspace ?? process.cwd())); } })),
    { id: 'rename', label: 'Rename session', action: () => prompt('Rename session', detail?.session.title ?? '', title => controller.configure({ title })) },
    { id: 'mode', label: detail?.session.mode === 'plan' ? 'Switch to Build' : 'Switch to Plan', description: 'Plan investigates without changing project files', disabled: busy, action: () => { close(); run(() => controller.configure({ mode: detail?.session.mode === 'plan' ? 'build' : 'plan' })); } },
    { id: 'queue', label: 'Queued messages', description: 'Pause, resume, or remove follow-ups', action: queue },
    { id: 'steer', label: 'Send draft as steering', description: 'Guide the current response without starting another turn', disabled: !busy, action: () => { close(); run(() => controller.send('steer')); } },
    { id: 'stop', label: 'Stop response', disabled: !busy, action: () => { close(); run(() => controller.cancel()); } },
    { id: 'undo', label: 'Undo last turn', disabled: busy || !detail?.history?.canUndo, description: detail?.history?.unavailableReason, action: () => { close(); run(() => controller.history('undo')); } },
    { id: 'redo', label: 'Redo turn', disabled: busy || !detail?.history?.canRedo, action: () => { close(); run(() => controller.history('redo')); } },
    { id: 'recover', label: 'Recover interrupted history', disabled: !detail?.history?.pendingRecovery, action: () => { close(); run(() => controller.history('recover')); } },
    { id: 'thinking', label: 'Toggle thinking', action: () => { toggle('showThinking'); close(); } },
    { id: 'actions', label: 'Toggle tool details', action: () => { toggle('toolDetails'); close(); } },
    { id: 'refresh', label: 'Reconnect', description: 'Refresh the session without resending anything', action: () => { close(); run(() => controller.open(controller.sessionId)); } },
    { id: 'quit', label: 'Quit Litespeed TUI', description: 'The server and running tasks keep working', action: onQuit },
  ];
  commands.sort((a, b) => COMMAND_ORDER.indexOf(a.id) - COMMAND_ORDER.indexOf(b.id));
  const reserved = [...commands.map(item => item.id), 'help', 'exit', 'skill', ...projectCommands.map(item => item.name)];
  const palette = () => menu('Commands', [...commands.map(item => ({ ...item, label: `${item.label}   /${item.id}` })), ...projectCommands.map(item => ({ id: `project:${item.name}`, label: `/${item.name}`, description: item.description, action: () => { controller.setDraft({ ...controller.getState().draft, text: `/${item.name} ` }); close(); } }))]);
  const submit = () => {
    if (state.pending) return;
    const slash = parseSlash(controller.getState().draft.text);
    if (slash?.name === 'steer' && slash.args) { run(() => controller.send('steer', slash.args)); return; }
    if (slash?.name === 'queue' && slash.args) { run(() => controller.send('queue', slash.args)); return; }
    if (slash?.name === 'attach' && slash.args) { controller.setDraft({ ...controller.getState().draft, text: '' }); run(() => attach(slash.args)); return; }
    const skill = skillCommand(controller.getState().draft.text, skills, reserved);
    if (skill) { run(() => controller.activateSkill(skill)); return; }
    if (slash) {
      if (slash.name === 'help') { controller.setDraft({ ...controller.getState().draft, text: '' }); palette(); return; }
      const command = commands.find(item => item.id === (slash.name === 'exit' ? 'quit' : slash.name === 'skill' ? 'skills' : slash.name));
      if (command) {
        if (command.disabled) { controller.notice('That action is unavailable while the current task is running or history is incomplete.'); return; }
        controller.setDraft({ ...controller.getState().draft, text: '' }); command.action(); return;
      }
      run(() => controller.send('message', expandProjectCommand(controller.getState().draft.text, projectCommands))); return;
    }
    run(() => controller.send());
  };
  const setupSeen = useRef(new Set<string>());
  useEffect(() => {
    if (!detail || !state.settings || detail.messages.length || busy || setupSeen.current.has(detail.session.workspace) || !needsSetup(state.settings, detail.session)) return;
    setupSeen.current.add(detail.session.workspace); openSetup(true);
  }, [detail?.session.id, Boolean(state.settings)]);
  useEffect(() => () => { if (escapeTimer.current) clearTimeout(escapeTimer.current); }, []);
  useKeyboard(key => {
    if (key.defaultPrevented) return;
    if ((key.super || (key.ctrl && key.shift)) && key.name === 'c') { key.preventDefault(); key.stopPropagation(); copyResponse(); return; }
    const exitMatch = parseBinding(config.keybinds.app_exit ?? KEYBIND_DEFAULTS.app_exit).some(binding => binding.steps.length === 1 && binding.steps[0] !== LEADER_TOKEN && strokeMatches(binding.steps[0], { name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta }));
    if (key.ctrl && key.name === 'c' && exitMatch) {
      key.preventDefault(); key.stopPropagation();
      const now = Date.now();
      if (now - lastCtrlC.current < 2000) onQuit(); else { lastCtrlC.current = now; controller.notice('Ctrl+C again to exit. Running tasks continue on the server.'); }
      return;
    }
    if (panel || promptOverlay) return;
    if (key.ctrl && key.name === 'd' && controller.getState().draft.text) return;
    if (key.meta && key.name === 'return' && busy && !permission && !question) { key.preventDefault(); key.stopPropagation(); run(() => controller.send('steer')); return; }
    const result = router.dispatch({ name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta });
    if (result.preventDefault) { key.preventDefault(); key.stopPropagation(); }
    if (result.pending) return;
    if (result.command === 'terminal.suspend') return suspendTerminal(renderer);
    if (result.command === 'app.exit') return onQuit();
    if (result.command === 'command.palette.show' || result.command === 'help.show') return palette();
    if (result.command === 'session.interrupt' && busy) {
      if (escPressed) { setEscPressed(false); run(() => controller.cancel()); }
      else { setEscPressed(true); escapeTimer.current = setTimeout(() => setEscPressed(false), 2000); }
      return;
    }
    const command = commands.find(item => item.id === KEY_COMMANDS[result.command ?? '']);
    if (command && !command.disabled) command.action();
  });
  const activeWorkers = detail?.delegations?.filter(task => task.status === 'running') ?? [];
  const actor = activeWorkers.length > 1 ? `${activeWorkers.length} ${activeWorkers.every(task => task.role === 'expert') ? 'experts' : 'workers'}` : activeWorkers.length ? workerLabels(detail!).get(`${activeWorkers[0].parentMessageId}:${activeWorkers[0].toolCallId}`) || 'Research' : 'Driver';
  const model = detail ? effectiveModel(detail.session) : null;
  const taskWidth = width >= 112 ? 30 : 0;
  return <TranscriptSettingsProvider value={settings}><box width="100%" height="100%" flexDirection="column" backgroundColor={toHex(theme.background)}>
    {detail ? <>
      <box height={1} flexDirection="row" flexShrink={0}><Button onPress={() => run(sessions)}>{terminalText(detail.session.title || 'New session').slice(0, Math.max(10, Math.floor((width - (busy ? 36 : 12)) / 2) - 4))}</Button><Button disabled={busy} onPress={() => run(openModels)}>{model?.model.slice(0, Math.max(10, Math.floor((width - (busy ? 36 : 12)) / 2) - 4))}</Button><Button disabled={busy} onPress={() => run(() => controller.configure({ mode: detail.session.mode === 'plan' ? 'build' : 'plan' }))}>{detail.session.mode}</Button><box flexGrow={1} />{busy ? permission || question ? <text fg={toHex(theme.warning)}>waiting for you </text> : <><WorkingScanner color={toHex(theme.primary)} /><text fg={toHex(theme.textMuted)}>{` ${actor} `}</text><InterruptHint pressed={escPressed} /></> : <text fg={toHex(theme.textMuted)}>idle </text>}</box>
      {!taskWidth && <TaskProgress detail={detail} controller={controller} compact />}
      <box flexDirection="row" flexGrow={1} minHeight={1}>
        <Transcript controller={controller} detail={detail} width={width - taskWidth} active={!panel} onInspect={inspect} onUsage={showUsage} />
        {taskWidth > 0 && <scrollbox width={taskWidth} flexShrink={0} border={['left']} borderColor={toHex(theme.border)}><TaskProgress detail={detail} controller={controller} /></scrollbox>}
      </box>
      {detail.history?.pendingRecovery && <box border borderColor={toHex(theme.warning)}><text fg={toHex(theme.warning)}>History needs recovery. Your draft is saved. </text><Button onPress={() => run(() => controller.history('recover'))}>Recover history</Button></box>}
      {detail.session.goal && ['active', 'blocked'].includes(detail.session.goal.status) && <box height={1} flexShrink={0}><Button onPress={() => setPanel(<GoalPanel controller={controller} onClose={close} />)}>{`Goal ${detail.session.goal.status} · ${goalTurnLabel(detail.session.goal.turns, detail.session.goal.maxTurns)} · ${terminalText(detail.session.goal.text).slice(0, Math.max(10, width - 36))}`}</Button></box>}
      {detail.queue?.items.length ? <box flexDirection="row" height={1}><Button onPress={queue}>{`${detail.queue.items.length} queued · ${detail.queue.paused ? 'paused' : 'will run next'}`}</Button></box> : null}
      {state.draft.attachments.length > 0 && <text fg={toHex(theme.textMuted)}>{state.draft.attachments.map(item => `⌕ ${item.name}`).join('  ')}</text>}
      {!panel && permission ? <PermissionPrompt key={permission.id} request={permission} controller={controller} onOverlayChange={setPromptOverlay} disabled={Boolean(state.pending)} /> : !panel && question ? <QuestionPrompt key={question.id} request={question} controller={controller} onOverlayChange={setPromptOverlay} disabled={Boolean(state.pending)} /> : <Composer commands={[...commands.map(item => ({name:item.id, description:item.label})), {name:'help', description:'Browse all commands'}, ...projectCommands.filter(item => !commands.some(command => command.id === item.name)).map(item => ({name:item.name, description:item.description})), ...skillCommands(skills, reserved)]} controller={controller} focused={!panel} onSubmit={submit} onReference={prefix => setPanel(<FilePicker controller={controller} initialQuery={prefix} onClose={close} onPick={file => { const draft = controller.getState().draft; if (draft.attachments.length >= 10) { controller.notice('A message can have up to 10 attachments.'); return; } controller.setDraft({ text: draft.text.replace(/@[^\s]*$/, ''), attachments: [...draft.attachments, { name: file.name, path: file.path }] }); close(); }} />)} />}
    </> : state.sync.phase === 'error' ? <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column"><text fg={toHex(theme.error)}>{state.sync.error}</text><Button onPress={() => run(() => controller.open(controller.sessionId))}>Reconnect</Button><Button onPress={palette}>Commands</Button></box> : <LoadingScreen />}
    <UpdateNotice controller={controller} onRestart={() => { process.send?.({ type: 'litespeed-restart', sessionId: controller.sessionId }); onQuit(75); }} />
    {(state.notice || pendingLeader || state.sync.connection === 'reconnecting') && <text paddingLeft={1} fg={toHex(theme.warning)}>{terminalText(pendingLeader ? 'Leader…' : state.notice || 'Reconnecting… Showing the last known state.').slice(0, width - 2)}</text>}
    <box height={1} flexDirection="row" flexShrink={0}><Button onPress={palette}>Ctrl+P Commands</Button><Button onPress={permissions}>{detail?.session.permissionMode === 'auto' ? 'Allow all tools' : 'Ask first'}</Button><Button onPress={openSettings}>Settings</Button><text fg={toHex(theme.textMuted)}>{state.pending ? `${state.pending}…` : permission || question ? 'Choose an answer above · Esc Esc stop' : 'Enter send · Shift+Enter newline'}</text></box>
    {panel}
  </box></TranscriptSettingsProvider>;
}
