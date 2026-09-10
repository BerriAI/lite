/** @jsxImportSource @opentui/react */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import { createTwoFilesPatch } from 'diff';
import type { DelegationDetail, DelegationSummary, FileChange, Message, SessionDetail } from '../shared/types.js';
import { terminalText } from './protocol.js';
import { InvocationSync } from './invocation.js';
import { TerminalController } from './controller.js';
import { Menu, TextViewer, Dialog } from './ui.js';
import { Transcript } from './transcript.js';
import { toHex } from './theme.js';
import { useConfig, useTheme } from './context.js';

export function WorkerInspector({ controller, invocation, onClose }: { controller: TerminalController; invocation: DelegationSummary; onClose: () => void }) {
  const [view, setView] = useState('main');
  const { width, height } = useTerminalDimensions();
  const path = `/sessions/${encodeURIComponent(invocation.parentSessionId)}/delegations/${encodeURIComponent(invocation.id)}`;
  const sync = useMemo(() => new InvocationSync(controller.client, invocation), [controller.client, path]);
  const { detail, error } = useSyncExternalStore(sync.subscribe, sync.getState);
  useEffect(() => { void sync.start(); return () => sync.stop(); }, [sync]);
  if (view === 'transcript' && detail) return <Dialog title={`${invocation.role || 'Research'} · ${detail.delegation.status}`} width={width - 2} onClose={() => setView('main')} footer={error || 'Read-only invocation transcript · PgUp PgDn scroll · Esc back'}><box height={Math.max(2, height - 10)}><Transcript detail={detail} width={width - 8} /></box></Dialog>;
  if (view === 'brief') return <TextViewer title="Assignment brief" text={detail?.messages.filter(message => message.role === 'user').map(message => message.content).join('\n\n') || 'No brief is available.'} onClose={() => setView('main')} />;
  if (view === 'report') return <TextViewer title="Worker report" text={detail?.messages.filter(message => message.role === 'assistant' && message.content).map(message => message.content).join('\n\n') || (detail?.delegation.status === 'running' ? 'The worker is still working.' : 'No report was produced.')} onClose={() => setView('main')} />;
  if (view === 'evidence') return <TextViewer title="Tool evidence" text={detail?.messages.flatMap(message => (message.toolCalls ?? []).map(call => `${call.name} · ${call.status}\n${JSON.stringify(call.args, null, 2)}\n${call.output || ''}`)).join('\n\n') || 'No tool calls recorded.'} onClose={() => setView('main')} />;
  return <Menu title={invocation.description || 'Worker assignment'} onClose={onClose} search={false} footer={error || detail?.delegation.error || 'Worker evidence is separate from the driver’s verification.'} items={[
    { id: 'status', label: `${invocation.role || 'Research'} · ${detail?.delegation.status ?? invocation.status}`, description: detail?.delegation.activity || detail?.session.model, disabled: true, action() {} },
    ...(invocation.legacyContext ? [{ id: 'legacy', label: 'Legacy context association', description: 'This older record may cover a reused worker context.', disabled: true, action() {} }] : []),
    ...(invocation.isolated ? [{ id: 'isolated', label: 'Isolated workspace', description: 'Edits return to the parent through reviewed merge.', disabled: true, action() {} }] : []),
    ...['brief', 'report', 'evidence', 'transcript'].map(id => ({ id, label: id === 'brief' ? 'Assignment brief' : id === 'report' ? 'Worker report' : id === 'evidence' ? 'Tool evidence' : 'Full transcript', disabled: !detail, action: () => setView(id) })),
    ...(detail?.delegation.status === 'running' ? [{ id: 'cancel', label: 'Stop this worker', action: () => { void controller.action('Stopping worker', () => controller.client.api(`${path}/cancel`, {})); } }] : []),
  ]} />;
}

export function WorkInspector({ controller, steps: initialSteps, detail: initialDetail, onClose }: { controller: TerminalController; steps: Message[]; detail: SessionDetail; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const detail = state.sync.detail?.session.id === initialDetail.session.id ? state.sync.detail : initialDetail;
  const turnId = initialSteps[0]?.turnId;
  const steps = turnId ? detail.messages.filter(message => message.role === 'assistant' && message.turnId === turnId) : initialSteps.map(message => detail.messages.find(next => next.id === message.id) ?? message);
  const [text, setText] = useState<{ title: string; text: string } | null>(null), [worker, setWorker] = useState<DelegationSummary | null>(null);
  if (text) return <TextViewer {...text} onClose={() => setText(null)} />;
  if (worker) return <WorkerInspector controller={controller} invocation={worker} onClose={() => setWorker(null)} />;
  return <Menu title="Response steps" onClose={onClose} items={steps.flatMap(message => [
    ...(message.reasoning ? [{ id: `${message.id}:reasoning`, label: 'Thought process', action: () => setText({ title: 'Thought process', text: terminalText(message.reasoning, true) }) }] : []),
    ...(message.toolCalls ?? []).map(call => {
      const invocation = detail.delegations?.find(item => item.toolCallId === call.id && item.parentMessageId === message.id);
      return { id: call.id, label: `${call.name} · ${call.status}`, description: String(call.args.description ?? call.args.path ?? call.args.command ?? ''), action: () => {
        if (invocation) setWorker(invocation);
        else setText({ title: `${call.name} · ${call.status}`, text: terminalText([JSON.stringify(call.args, null, 2), call.output || '', ...(call.intercepted ? [`Modified by ${call.intercepted.by}: ${call.intercepted.reason}`, `Original arguments: ${JSON.stringify(call.intercepted.originalArgs)}`] : [])].join('\n\n'), true) });
      } };
    }),
  ])} />;
}

export function Changes({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const [changes, setChanges] = useState<FileChange[] | null>(null), [selected, setSelected] = useState<FileChange | null>(null), [error, setError] = useState('');
  const theme = useTheme(), config = useConfig(), { width, height } = useTerminalDimensions();
  useEffect(() => { let live = true; controller.client.api<{ changes: FileChange[] }>(controller.path('/changes')).then(value => { if (live) setChanges(value.changes); }).catch(error => { if (live) setError(error.message); }); return () => { live = false; }; }, [controller, controller.sessionId]);
  if (selected) {
    const patch = createTwoFilesPatch(selected.before === null ? '/dev/null' : selected.path, selected.after === null ? '/dev/null' : selected.path, selected.before ?? '', selected.after ?? '');
    return <Dialog title={selected.path} width={width - 2} onClose={() => setSelected(null)} footer="Recorded session changes · PgUp PgDn scroll · Esc files"><scrollbox focused height={Math.max(2, height - 10)}><diff diff={patch} view={config.diff_style === 'auto' && width >= 120 ? 'split' : 'unified'} fg={toHex(theme.text)} addedBg={toHex(theme.diffAddedBg)} removedBg={toHex(theme.diffRemovedBg)} contextBg={toHex(theme.diffContextBg)} addedSignColor={toHex(theme.diffAdded)} removedSignColor={toHex(theme.diffRemoved)} lineNumberFg={toHex(theme.diffLineNumber)} wrapMode="word" /></scrollbox></Dialog>;
  }
  return <Menu title="Changed files" onClose={onClose} footer={error || (changes === null ? 'Loading changes…' : changes.length ? 'Select a file to review its diff · Esc back' : 'No file changes recorded in this session.')} items={(changes ?? []).map((change, index) => ({ id: `${index}:${change.path}`, label: `${change.before === null ? '+' : change.after === null ? '−' : '~'} ${change.path}`, description: change.invocationId ? 'Worker change · recorded on parent history' : undefined, action: () => setSelected(change) }))} />;
}
