/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import type { Session } from '../shared/types.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt } from './ui.js';
import { terminalText } from './protocol.js';

export function Sessions({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]), [archived, setArchived] = useState(false), [projectOnly, setProjectOnly] = useState(true), [revision, setRevision] = useState(0);
  const [newWorkspace, setNewWorkspace] = useState(false), [error, setError] = useState('');
  const workspace = controller.detail?.session.workspace ?? controller.getState().settings?.workspace ?? process.cwd();
  useEffect(() => { let live = true; controller.client.api<{ sessions: Session[] }>(`/sessions?archived=${archived}`).then(value => { if (live) setSessions(value.sessions); }).catch(error => { if (live) setError(error.message); }); return () => { live = false; }; }, [archived, revision]);
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); onClose(); } catch (error) { setError((error as Error).message); } };
  if (newWorkspace) return <TextPrompt title="Start a session in a workspace" value={workspace} error={error} onClose={() => setNewWorkspace(false)} onSave={value => { void run(() => controller.create(value)); }} />;
  return <Menu title="Sessions" onClose={onClose} footer={error || '↑↓ choose · Enter open · Esc back'} items={[
    { id: 'new', label: '+ New session', description: workspace, action: () => { void run(() => controller.create(workspace)); } },
    { id: 'workspace', label: '+ New session in another workspace…', action: () => setNewWorkspace(true) },
    { id: 'project', label: projectOnly ? 'Showing this project · Show all projects' : 'Showing all projects · Show this project', action: () => setProjectOnly(!projectOnly) },
    { id: 'archived', label: archived ? 'Showing archived · Show active sessions' : 'Show archived sessions', action: () => setArchived(!archived) },
    ...sessions.filter(session => !projectOnly || session.workspace === workspace).map(session => ({ id: session.id, label: `${session.id === controller.sessionId ? '● ' : ''}${terminalText(session.title || 'Untitled')}`, description: `${session.workspace} · ${session.status}`, action: () => { void run(() => controller.open(session.id)); } })),
    { id: 'refresh', label: 'Reload sessions', action: () => setRevision(value => value + 1) },
  ]} />;
}
