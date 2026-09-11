/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { DelegationSummary, ToolCall } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { InvocationSync } from './invocation.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';
import { terminalText } from './protocol.js';
import { toolRow } from './transcriptModel.js';
import { Button } from './ui.js';

function WorkerTranscript({ task, controller, width, label }: { task: DelegationSummary; controller: TerminalController; width: number; label: string }) {
  const theme = useTheme();
  const sync = useMemo(() => new InvocationSync(controller.client, task), [controller.client, task.id, task.parentMessageId, task.toolCallId]);
  const { detail, error } = useSyncExternalStore(sync.subscribe, sync.getState);
  const [expanded, setExpanded] = useState(false), [brief, setBrief] = useState(false);
  useEffect(() => { void sync.start(); return () => sync.stop(); }, [sync]);
  useEffect(() => { if (task.status !== 'running') void sync.refresh(); }, [sync, task.status]);
  const rows = detail?.messages.flatMap(message => message.role !== 'assistant' ? [] : [
    ...(message.content.trim() ? [{ id: message.id, text: message.content.trim(), prose: true }] : []),
    ...(message.toolCalls ?? []).flatMap(call => [{ id: `${message.id}:${call.id}`, text: `${call.status === 'running' || call.status === 'pending' ? '›' : call.status === 'completed' ? '✓' : '×'} ${toolRow(call).text.split('\n')[0]}`, prose: false },...(call.shunt&&call.output?[{id:`${message.id}:${call.id}:answer`,text:call.output,prose:true}]:[])]),
  ]) ?? [];
  const visible = expanded ? rows : rows.slice(-4);
  const lines = <>{visible.map(row => <text key={row.id} fg={toHex(theme.textMuted)} wrapMode="word">{row.prose ? <em>{terminalText(expanded ? row.text : row.text.replace(/\s+/g, ' ').slice(0, Math.max(20, width - 8)), true)}</em> : terminalText(expanded ? row.text : row.text.slice(0, Math.max(20, width - 8)))}</text>)}</>;
  return <box flexDirection="column" flexShrink={0}>
    <text fg={toHex(theme.text)} wrapMode="word">{terminalText(task.description)}<span fg={toHex(theme.textMuted)}>{detail ? ` · ${terminalText(detail.session.model)}` : ''}</span></text>
    {error && <><text fg={toHex(theme.warning)}>{error}</text><Button onPress={() => { void sync.start(); }}>Retry transcript</Button></>}
    {!detail && !error && <text fg={toHex(theme.textMuted)}>Connecting to transcript…</text>}
    {detail && <>
      {expanded ? <scrollbox height={Math.min(12, Math.max(4, rows.length + 2))} stickyScroll stickyStart="bottom">{lines}</scrollbox> : lines}
      <box flexDirection="row"><Button onPress={() => setExpanded(!expanded)}>{expanded ? 'Less' : rows.length > 4 ? `Transcript · ${rows.length} updates` : 'Full transcript'}</Button><Button onPress={() => setBrief(!brief)}>{brief ? 'Hide assignment' : 'Assignment'}</Button>{task.status === 'running' && <Button onPress={() => { void controller.action('Stopping worker', () => controller.client.api(`/sessions/${task.parentSessionId}/delegations/${task.id}/cancel`, {})); }}>Stop {label}</Button>}</box>
      {brief && <text fg={toHex(theme.textMuted)} wrapMode="word">{terminalText(detail.messages.find(message => message.role === 'user')?.content ?? '', true)}</text>}
    </>}
  </box>;
}

export function WorkerCard({ task, call, label, controller, width, needsApproval }: { task?: DelegationSummary; call: ToolCall; label: string; controller?: TerminalController; width: number; needsApproval: boolean }) {
  const theme = useTheme();
  const status = task ? task.status === 'running' ? task.activity || 'Working' : task.status.replaceAll('_', ' ') : needsApproval ? 'Needs approval' : call.status === 'pending' ? 'Queued' : call.status === 'running' ? 'Starting' : call.status;
  return <box border={['left']} borderColor={toHex(theme.primary)} paddingLeft={1} marginTop={0} marginBottom={1} flexDirection="column" flexShrink={0}>
    <box flexDirection="row"><text fg={toHex(theme.primary)}><strong>{`Driver → ${label}`}</strong></text><text fg={toHex(theme.textMuted)}>{` · ${terminalText(status)}`}</text></box>
    {!task && <text fg={toHex(theme.text)} wrapMode="word">{terminalText(String(call.args.description || 'Assignment'))}</text>}
    {task && controller ? <WorkerTranscript task={task} controller={controller} width={width} label={label} /> : <text fg={toHex(theme.textMuted)}>{call.status === 'pending' ? 'Waiting to start. Activity will appear here.' : call.output ? terminalText(call.output, true).slice(0, 300) : 'Starting this assignment…'}</text>}
    {task?.error && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(task.error, true)}</text>}

  </box>;
}
