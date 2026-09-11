/** @jsxImportSource @opentui/react */
import type { DelegationSummary, SessionDetail, Todo } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { useTheme } from './context.js';
import { useInvocation } from './useInvocation.js';
import { toHex } from './theme.js';
import { terminalText } from './protocol.js';
import { workerLabels } from '../shared/worker-presentation.js';
import { TODO_MARKERS } from './transcriptModel.js';

export function taskInvocations(detail: SessionDetail) {
  const last = detail.messages.findLast(message => message.role === 'user');
  return (detail.delegations ?? []).filter(task => task.status === 'running' || task.parentTurnId === (last?.turnId ?? last?.id));
}

function TaskItems({ todos, actor, compact }: { todos: Todo[]; actor: string; compact?: boolean }) {
  const theme = useTheme();
  if (!todos.length) return null;
  const completed = todos.filter(todo => todo.status === 'completed').length;
  const current = todos.find(todo => todo.status === 'in_progress') ?? todos.find(todo => todo.status === 'pending');
  return <box flexDirection="column" flexShrink={0} marginBottom={compact ? 0 : 1}>
    <text fg={toHex(theme.textMuted)}>{`${actor} · ${completed}/${todos.length} done`}</text>
    {(compact ? current ? [current] : [] : todos).map(todo => <text key={todo.id ?? todo.content} fg={toHex(todo.status === 'in_progress' ? theme.primary : theme.textMuted)} wrapMode="word" {...(compact ? { height: 1 } : {})}>{`${TODO_MARKERS[todo.status] ?? '○'} ${terminalText(todo.content)}`}</text>)}
  </box>;
}

function WorkerTasks({ task, label, controller, compact }: { task: DelegationSummary; label: string; controller: TerminalController; compact?: boolean }) {
  const { detail } = useInvocation(controller.client, task);
  const theme = useTheme();
  if (!detail?.todos.length) return task.status === 'running' ? <text fg={toHex(theme.textMuted)} wrapMode="word">{`${label} · No tasks yet`}</text> : null;
  return <TaskItems todos={detail.todos} actor={label} compact={compact} />;
}

export function TaskProgress({ detail, controller, compact = false }: { detail: SessionDetail; controller: TerminalController; compact?: boolean }) {
  const theme = useTheme(), tasks = taskInvocations(detail), labels = workerLabels(detail);
  const active = tasks.filter(task => task.status === 'running');
  const shown = compact ? active.slice(0, 1) : tasks;
  return <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
    {!compact && <text fg={toHex(theme.text)} marginBottom={1}><strong>Tasks</strong></text>}
    {(!compact || !active.length) && <TaskItems todos={detail.todos} actor="Driver" compact={compact} />}
    {shown.map(task => <WorkerTasks key={task.id} task={task} label={labels.get(`${task.parentMessageId}:${task.toolCallId}`) || 'Research'} controller={controller} compact={compact} />)}
    {compact && active.length > 1 && <text fg={toHex(theme.textMuted)}>{`${active.length - 1} more agents · /todos for all tasks`}</text>}
    {!compact && !detail.todos.length && !tasks.length && <text fg={toHex(theme.textMuted)}>No tasks yet.</text>}
  </box>;
}
