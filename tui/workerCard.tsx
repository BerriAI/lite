/** @jsxImportSource @opentui/react */
import { useState, type ReactNode } from 'react';
import type { DelegationDetail, DelegationSummary, ToolCall } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { useInvocation } from './useInvocation.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';
import { terminalText } from './protocol.js';
import { Button } from './ui.js';

type TranscriptRenderer = (detail: DelegationDetail, width: number) => ReactNode;

function WorkerTranscript({ task, controller, width, renderTranscript }: { task: DelegationSummary; controller: TerminalController; width: number; renderTranscript: TranscriptRenderer }) {
  const theme = useTheme();
  const { detail, error, retry } = useInvocation(controller.client, task);
  return <box flexDirection="column" flexShrink={0}>
    {error && <><text fg={toHex(theme.warning)} wrapMode="word">{terminalText(error, true)}</text><Button onPress={retry}>Retry transcript</Button></>}
    {!detail && !error && <text fg={toHex(theme.textMuted)}>Connecting to transcript…</text>}
    {detail && renderTranscript(detail, Math.max(24, width - 2))}
  </box>;
}

export function WorkerCard({ task, call, label, controller, width, needsApproval, renderTranscript }: { task?: DelegationSummary; call: ToolCall; label: string; controller?: TerminalController; width: number; needsApproval: boolean; renderTranscript: TranscriptRenderer }) {
  // WorkLog mounts cards only while its response activity is visible, matching
  // the web client where a visible work log opens its bound task transcript.
  const theme = useTheme(), [expanded, setExpanded] = useState(true);
  const status = task ? task.status === 'running' ? 'Working' : task.status.replaceAll('_', ' ') : needsApproval ? 'Needs approval' : call.status === 'pending' ? 'Queued' : call.status === 'running' ? 'Starting' : call.status;
  const description = task?.description || String(call.args.description || 'Assignment');
  return <box border={['left']} borderColor={toHex(theme.primary)} paddingLeft={1} marginTop={0} marginBottom={1} flexDirection="column" flexShrink={0}>
    <box flexDirection="row">
      <Button onPress={() => setExpanded(open => !open)}>{`${expanded ? '▾' : '▸'} ${label} · ${terminalText(status)}`}</Button>
      <box flexGrow={1} />
      {task?.status === 'running' && controller && <Button onPress={() => { void controller.action('Stopping worker', () => controller.client.api(`/sessions/${task.parentSessionId}/delegations/${task.id}/cancel`, {})); }}>Stop {label}</Button>}
    </box>
    <text fg={toHex(theme.text)} wrapMode="word">{terminalText(description)}</text>
    {expanded && task && controller ? <WorkerTranscript key={`${task.id}:${task.parentMessageId}:${task.toolCallId}`} task={task} controller={controller} width={width} renderTranscript={renderTranscript} /> : null}
    {expanded && !task ? <text fg={toHex(call.status === 'error' ? theme.error : theme.textMuted)} wrapMode="word">{terminalText(call.output || (needsApproval ? 'Waiting for your approval.' : call.status === 'running' ? 'Starting this assignment…' : 'Waiting to start.'), true)}</text> : null}
    {task?.error && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(task.error, true)}</text>}
  </box>;
}
