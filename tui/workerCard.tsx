/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import type { DelegationDetail, DelegationSummary, ToolCall } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { InvocationSync } from './invocation.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';
import { terminalText } from './protocol.js';
import { Button } from './ui.js';

type TranscriptRenderer = (detail: DelegationDetail, width: number) => ReactNode;

function WorkerTranscript({ task, controller, width, renderTranscript }: { task: DelegationSummary; controller: TerminalController; width: number; renderTranscript: TranscriptRenderer }) {
  const theme = useTheme(), { height } = useTerminalDimensions();
  const sync = useMemo(() => new InvocationSync(controller.client, task), [controller.client, task.id, task.parentMessageId, task.toolCallId]);
  const { detail, error } = useSyncExternalStore(sync.subscribe, sync.getState);
  useEffect(() => { void sync.start(); return () => sync.stop(); }, [sync]);
  useEffect(() => { if (task.status !== 'running') void sync.refresh(); }, [sync, task.status]);
  return <box flexDirection="column" flexShrink={0}>
    {error && <><text fg={toHex(theme.warning)} wrapMode="word">{terminalText(error, true)}</text><Button onPress={() => { void sync.start(); }}>Retry transcript</Button></>}
    {!detail && !error && <text fg={toHex(theme.textMuted)}>Connecting to transcript…</text>}
    {detail && <box width="100%" height={Math.max(4, Math.min(12, height - 12))} flexShrink={0}>{renderTranscript(detail, Math.max(24, width - 2))}</box>}
  </box>;
}

export function WorkerCard({ task, call, label, controller, width, needsApproval, renderTranscript }: { task?: DelegationSummary; call: ToolCall; label: string; controller?: TerminalController; width: number; needsApproval: boolean; renderTranscript: TranscriptRenderer }) {
  // WorkLog mounts cards only while its response activity is visible, matching
  // the web client where a visible work log opens its bound task transcript.
  const theme = useTheme(), [expanded, setExpanded] = useState(true);
  const status = task ? task.status === 'running' ? task.activity || 'Working' : task.status.replaceAll('_', ' ') : needsApproval ? 'Needs approval' : call.status === 'pending' ? 'Queued' : call.status === 'running' ? 'Starting' : call.status;
  const description = task?.description || String(call.args.description || 'Assignment');
  return <box border={['left']} borderColor={toHex(theme.primary)} paddingLeft={1} marginTop={0} marginBottom={1} flexDirection="column" flexShrink={0}>
    <box flexDirection="row">
      <Button onPress={() => setExpanded(open => !open)}>{`${expanded ? '▾' : '▸'} Driver → ${label} · ${terminalText(status)}`}</Button>
      <box flexGrow={1} />
      {task?.status === 'running' && controller && <Button onPress={() => { void controller.action('Stopping worker', () => controller.client.api(`/sessions/${task.parentSessionId}/delegations/${task.id}/cancel`, {})); }}>Stop {label}</Button>}
    </box>
    <text fg={toHex(theme.text)} wrapMode="word">{terminalText(description)}</text>
    {expanded && task && controller ? <WorkerTranscript key={`${task.id}:${task.parentMessageId}:${task.toolCallId}`} task={task} controller={controller} width={width} renderTranscript={renderTranscript} /> : null}
    {expanded && !task ? <box paddingLeft={1} flexDirection="column"><text fg={toHex(theme.textMuted)} wrapMode="word">{terminalText(JSON.stringify(call.args), true)}</text><text fg={toHex(call.status === 'error' ? theme.error : theme.textMuted)} wrapMode="word">{terminalText(call.output || (call.status === 'pending' ? 'Waiting to start. Activity will appear here.' : call.status === 'running' ? 'Starting this assignment…' : 'No transcript is available for this assignment.'), true)}</text></box> : null}
    {task?.error && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(task.error, true)}</text>}
  </box>;
}
