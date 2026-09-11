/** @jsxImportSource @opentui/react */
import { useTerminalDimensions } from '@opentui/react';
import { goalTurnLabel } from '../shared/goals.js';
import { TaskProgress } from './tasks.js';
import { useState, useSyncExternalStore } from 'react';
import { isRunning, type TerminalController } from './controller.js';
import { Dialog, Menu, TextPrompt, TextViewer } from './ui.js';

export function GoalPanel({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState), goal = state.sync.detail?.session.goal;
  const [text, setText] = useState(''), [turns, setTurns] = useState<number | undefined>(), [view, setView] = useState('main'), [error, setError] = useState('');
  const blocked = isRunning(state.sync.detail) || Boolean(state.pending) || Boolean(state.sync.detail?.history?.pendingRecovery);
  if (view === 'text') return <TextPrompt title="Goal objective" multiline value={text} onClose={() => setView('main')} onSave={value => { setText(value); setView('main'); }} />;
  if (view === 'turns') return <TextPrompt title="Turn limit (blank for no limit)" error={error} value={turns === undefined ? '' : String(turns)} onClose={() => setView('main')} onSave={value => { const n = value.trim() ? Number(value) : undefined; if (n === undefined || (Number.isSafeInteger(n) && n >= 1)) { setTurns(n); setError(''); setView('main'); } else setError('Enter a positive whole number, or leave blank for no limit.'); }} />;
  if (view === 'details') return <TextViewer title="Session goal" text={`${goal?.text ?? ''}\n\n${goal?.lastReport?.note ?? ''}`} onClose={() => setView('main')} />;
  return <Menu title="Session goal" search={false} onClose={onClose} footer={state.notice || 'Set an objective, then send a message to begin. Stop pauses continuation.'} items={[
    ...(goal && goal.status !== 'cleared' ? [{ id: 'current', label: `${goal.status} · ${goalTurnLabel(goal.turns, goal.maxTurns)}`, description: goal.text, action: () => setView('details') }, { id: 'clear', label: 'Clear goal', disabled: blocked, action: () => { void controller.action('Clearing goal', () => controller.client.api(controller.path('/goal'), undefined, 'DELETE')); } }] : []),
    { id: 'text', label: 'New objective', description: text || 'One outcome to pursue across turns', disabled: goal?.status === 'active', action: () => setView('text') },
    { id: 'turns', label: `Turn limit: ${turns ?? 'None'}`, disabled: goal?.status === 'active', action: () => setView('turns') },
    { id: 'save', label: 'Set goal', separatorBefore: true, disabled: blocked || goal?.status === 'active' || !text.trim() || text.length > 2000, action: () => { void controller.action('Setting goal', () => controller.client.api(controller.path('/goal'), { text: text.trim(), maxTurns: turns })); } },
  ]} />;
}

export function PlanPanel({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const { height } = useTerminalDimensions();
  const { sync } = useSyncExternalStore(controller.subscribe, controller.getState);
  return <Dialog title="Task list" onClose={onClose}><scrollbox height={Math.max(4, height - 10)} focused>{sync.detail && <TaskProgress detail={sync.detail} controller={controller} />}</scrollbox></Dialog>;
}

export function HistoryPanel({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState), history = state.sync.detail?.history;
  const [details, setDetails] = useState(false);
  const disabled = Boolean(state.pending) || isRunning(state.sync.detail);
  if (details) return <TextViewer title="History details" onClose={() => setDetails(false)} text={[state.notice, history?.pendingRecovery?.reason, ...(history?.pendingRecovery?.paths ?? []), history?.unavailableReason, history?.effectsNotice].filter(Boolean).join('\n\n') || 'Recorded changes can be undone without replaying commands. External changes are protected.'} />;
  return <Menu title="File history" search={false} onClose={onClose} footer={state.notice || history?.effectsNotice || 'Restores recorded files and conversation; commands are never replayed.'} items={[
    { id: 'details', label: 'History and recovery details', description: history?.pendingRecovery?.reason || history?.unavailableReason, action: () => setDetails(true) },
    ...(['undo', 'redo', 'recover'] as const).map(action => ({ id: action, label: action === 'recover' ? 'Recover interrupted operation' : action === 'undo' ? 'Undo last turn' : 'Redo turn', disabled: disabled || (action === 'recover' ? !history?.pendingRecovery : Boolean(history?.pendingRecovery) || !(action === 'undo' ? history?.canUndo : history?.canRedo)), action: () => { void controller.history(action); } })),
  ]} />;
}
