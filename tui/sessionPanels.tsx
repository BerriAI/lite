/** @jsxImportSource @opentui/react */
import { useState, useSyncExternalStore } from 'react';
import { isRunning, type TerminalController } from './controller.js';
import { Menu, TextPrompt, TextViewer } from './ui.js';

export function GoalPanel({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState), goal = state.sync.detail?.session.goal;
  const [text, setText] = useState(''), [turns, setTurns] = useState(10), [view, setView] = useState('main'), [error, setError] = useState('');
  const blocked = isRunning(state.sync.detail) || Boolean(state.pending) || Boolean(state.sync.detail?.history?.pendingRecovery);
  if (view === 'text') return <TextPrompt title="Goal objective" multiline value={text} onClose={() => setView('main')} onSave={value => { setText(value); setView('main'); }} />;
  if (view === 'turns') return <TextPrompt title="Maximum turns (1–25)" error={error} value={String(turns)} onClose={() => setView('main')} onSave={value => { const n = Number(value); if (Number.isInteger(n) && n >= 1 && n <= 25) { setTurns(n); setError(''); setView('main'); } else setError('Enter a whole number from 1 to 25.'); }} />;
  if (view === 'details') return <TextViewer title="Session goal" text={`${goal?.text ?? ''}\n\n${goal?.lastReport?.note ?? ''}`} onClose={() => setView('main')} />;
  return <Menu title="Session goal" search={false} onClose={onClose} footer={state.notice || 'Set an objective, then send a message to begin. Stop pauses continuation.'} items={[
    ...(goal && goal.status !== 'cleared' ? [{ id: 'current', label: `${goal.status} · ${goal.turns} / ${goal.maxTurns} turns`, description: goal.text, action: () => setView('details') }, { id: 'clear', label: 'Clear goal', disabled: blocked, action: () => { void controller.action('Clearing goal', () => controller.client.api(controller.path('/goal'), undefined, 'DELETE')); } }] : []),
    { id: 'text', label: 'New objective', description: text || 'One outcome to pursue across turns', disabled: goal?.status === 'active', action: () => setView('text') },
    { id: 'turns', label: `Maximum turns: ${turns}`, disabled: goal?.status === 'active', action: () => setView('turns') },
    { id: 'save', label: 'Set goal', separatorBefore: true, disabled: blocked || goal?.status === 'active' || !text.trim() || text.length > 2000, action: () => { void controller.action('Setting goal', () => controller.client.api(controller.path('/goal'), { text: text.trim(), maxTurns: turns })); } },
  ]} />;
}

export function PlanPanel({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const { sync } = useSyncExternalStore(controller.subscribe, controller.getState);
  return <TextViewer title="Task list" text={sync.detail?.todos.map(todo => `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'} ${todo.content}`).join('\n\n') || 'The agent has not created a task list yet.'} onClose={onClose} />;
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
