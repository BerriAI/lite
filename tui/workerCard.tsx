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
  const status = task ? task.status === 'running' ? 'Working' : task.status === 'completed' && task.verificationNote ? 'Completed · Needs review' : task.status.replaceAll('_', ' ') : needsApproval ? 'Needs approval' : call.status === 'pending' ? 'Queued' : call.status === 'running' ? 'Starting' : call.status;
  const description = task?.description || String(call.args.description || 'Assignment');
  const count = detail?.messages.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0);
  const summary = count === undefined ? description : count ? `${count} ${count === 1 ? 'step' : 'steps'}` : 'Response';
  return <box marginTop={1} marginBottom={1} flexDirection="column" flexShrink={0}>
    <text paddingLeft={3} fg={toHex(theme.textMuted)}>{terminalText(label)}</text>
    <box border={['left']} borderColor={toHex(theme.primary)} paddingLeft={1} flexDirection="column" flexShrink={0}>
      <box flexDirection="row">
        <Button onPress={() => setExpanded(!open)}>{`${open ? '▾' : '▸'} ${terminalText(summary)} · ${terminalText(status)}`}</Button>
        <box flexGrow={1} />
        {task?.status === 'running' && controller && <Button onPress={() => { void controller.action('Stopping worker', () => controller.client.api(`/sessions/${task.parentSessionId}/delegations/${task.id}/cancel`, {})); }}>Stop {label}</Button>}
      </box>
      {open && <>
        <text fg={toHex(theme.text)} wrapMode="word">{terminalText(description)}</text>
        {error && <><text fg={toHex(theme.warning)} wrapMode="word">{terminalText(error, true)}</text>{retry && <Button onPress={retry}>Retry transcript</Button>}</>}
        {task && !detail && !error && <text fg={toHex(theme.textMuted)}>Connecting to transcript…</text>}
        {detail && renderTranscript(detail, Math.max(24, width - 2))}
        {task?.verificationNote && <text fg={toHex(theme.warning)} wrapMode="word">{terminalText(task.verificationNote, true)}</text>}
        {!task && <text fg={toHex(call.status === 'error' ? theme.error : theme.textMuted)} wrapMode="word">{terminalText(call.output || (needsApproval ? 'Waiting for your approval.' : call.status === 'running' ? 'Starting this assignment…' : 'Waiting to start.'), true)}</text>}
      </>}
      {task?.error && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(task.error, true)}</text>}
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
