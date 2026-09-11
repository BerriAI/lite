/** @jsxImportSource @opentui/react */
import { useState, type ReactNode } from 'react';
import type { DelegationDetail, DelegationSummary, ToolCall } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { useInvocation } from './useInvocation.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';
import { terminalText } from './protocol.js';
import { Button } from './ui.js';

type Props = { task?: DelegationSummary; call: ToolCall; label: string; controller?: TerminalController; width: number; needsApproval: boolean; defaultOpen?: boolean; renderTranscript: (detail: DelegationDetail, width: number) => ReactNode };

function WorkerActivity({ detail, error, retry, task, call, label, controller, width, needsApproval, defaultOpen = false, renderTranscript }: Props & { detail?: DelegationDetail | null; error?: string; retry?: () => void }) {
  const theme = useTheme(), [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? defaultOpen;
  const status = task ? task.status === 'running' ? 'Working' : task.status.replaceAll('_', ' ') : needsApproval ? 'Needs approval' : call.status === 'pending' ? 'Queued' : call.status === 'running' ? 'Starting' : call.status;
  const description = task?.description || String(call.args.description || 'Assignment');
  const count = detail?.messages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0);
  const summary = [description, count ? `${count} ${count === 1 ? 'step' : 'steps'}` : undefined, status].filter(Boolean).join(' · ');
  const running = task?.status === 'running' || !task && (call.status === 'running' || call.status === 'pending');
  const failed = task ? task.status === 'failed' : call.status === 'error';
  const transcriptHasError = detail?.messages.some(message => message.error === task?.error);
  return <box flexDirection="column" flexShrink={0}>
    <text paddingLeft={3} fg={toHex(theme.textMuted)}>{terminalText(label)}</text>
    <box border={['left']} borderColor={toHex(running ? theme.primary : theme.border)} paddingLeft={1} flexDirection="column" flexShrink={0}>
      <box flexDirection="row">
        <box flexShrink={1} minWidth={1} flexDirection="column" onMouseDown={() => setExpanded(!open)}><text fg={toHex(failed ? theme.error : running ? theme.text : theme.textMuted)} wrapMode="word">{`${open ? '▾' : '▸'} ${terminalText(summary)}`}</text></box>
        <box flexGrow={1} />
        {task?.status === 'running' && controller && <Button tone="muted" onPress={() => { void controller.action('Stopping worker', () => controller.client.api(`/sessions/${task.parentSessionId}/delegations/${task.id}/cancel`, {})); }}>Stop</Button>}
      </box>
      {open && <>
        {error && <><text fg={toHex(theme.warning)} wrapMode="word">{terminalText(error, true)}</text>{retry && <Button onPress={retry}>Retry transcript</Button>}</>}
        {task && !detail && !error && <text fg={toHex(theme.textMuted)}>Connecting to transcript…</text>}
        {detail && renderTranscript(detail, Math.max(24, width - 2))}
        {!task && call.status !== 'error' && <text fg={toHex(theme.textMuted)} wrapMode="word">{terminalText(call.output || (needsApproval ? 'Waiting for your approval.' : call.status === 'running' ? 'Starting this assignment…' : 'Waiting to start.'), true)}</text>}
      </>}
      {!task && call.status === 'error' && call.output && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(call.output, true)}</text>}
      {task?.error && task.status !== 'cancelled' && (!open || !transcriptHasError) && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(task.error, true)}</text>}
    </box>
  </box>;
}
function BoundWorkerActivity(props: Props & { task: DelegationSummary; controller: TerminalController }) {
  const invocation = useInvocation(props.controller.client, props.task);
  return <WorkerActivity {...props} {...invocation} />;
}
export function WorkerCard(props: Props) {
  return props.task && props.controller ? <BoundWorkerActivity {...props} task={props.task} controller={props.controller} /> : <WorkerActivity {...props} />;
}
