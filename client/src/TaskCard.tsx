import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Clock3 } from 'lucide-react';
import type { DelegationDetail, DelegationSummary } from '../../shared/delegation';
import type { RunEvent, ToolCall } from '../../shared/types';
import { api, applyEvent, errorMessage } from './api';
import { Conversation } from './Conversation';
import { CopyButton, Modal, SpeedRail } from './ui';

const statusLabels: Record<DelegationSummary['status'], string> = { running: 'Researching', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
export const delegationPath = (task: DelegationSummary) => `/sessions/${encodeURIComponent(task.parentSessionId)}/delegations/${encodeURIComponent(task.id)}`;
export function TaskCard({ task, tool, onOpen, onCancel, cancelling, error }: { task: DelegationSummary; tool: ToolCall; onOpen: () => void; onCancel: () => void; cancelling: boolean; error?: string }) {
  const running = task.status === 'running';
  return <section className="research-task" role="region" aria-label="Research task">
    <div className="research-task-heading"><BookOpen size={16} /><strong>{task.description || 'Research task'}</strong><span role="status">{cancelling ? 'Cancelling…' : statusLabels[task.status]}</span></div>
    <p className="research-scope">Read-only research · bounded foreground task. No edits, shell commands, MCP, or further delegation.</p>
    {running && <p>The parent response is waiting for this task’s report.</p>}
    {task.error && <p className="error-text" role="status">{task.error}</p>}
    <div className="research-task-actions"><button className="button secondary" onClick={onOpen}>Open transcript</button>{running && <button className="button secondary" disabled={cancelling} onClick={onCancel}>Cancel task</button>}</div>
    {error && <p className="error-text" role="alert">{error}</p>}
    {tool.output !== undefined && <details className="research-report"><summary>Task report</summary><CopyButton text={tool.output} /><pre>{tool.output || '(No output)'}</pre></details>}
    {running && <SpeedRail active compact />}
  </section>;
}

export function TaskTranscript({ task, onClose }: { task: DelegationSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<DelegationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [reload, setReload] = useState(0);
  const current = useRef<DelegationDetail | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const previousStatus = useRef(task.status);
  const path = delegationPath(task);
  useEffect(() => {
    let live = true, source: EventSource | undefined, journal: RunEvent[] = [], latestRead = 0, journalFloor = 0;
    current.current = null; setDetail(null); setLoading(true); setError(''); setConnection('connecting');
    const valid = (value: DelegationDetail) => value.readOnly === true && value.session.id === task.childSessionId && value.delegation.id === task.id && value.delegation.parentSessionId === task.parentSessionId && value.delegation.childSessionId === task.childSessionId && value.delegation.parentTurnId === task.parentTurnId && value.delegation.parentMessageId === task.parentMessageId && value.delegation.toolCallId === task.toolCallId;
    const read = async () => {
      const request = ++latestRead;
      try {
        const next = await api<DelegationDetail>(path);
        if (!live || request !== latestRead) return;
        if (!valid(next)) throw new Error('Research transcript does not match this task.');
        const newer = journal.filter(event => (event.id ?? 0) > (next.lastEventId ?? 0));
        // If a snapshot predates trimmed journal entries, only the live detail has the complete text.
        const behindJournal = next.delegation.status === 'running' && (next.lastEventId ?? 0) < journalFloor && current.current;
        let reconciled = behindJournal || { ...(next.delegation.status === 'running' ? newer.reduce(applyEvent, next) : next), delegation: next.delegation, readOnly: true } as DelegationDetail;
        // Finished snapshots are sealed by the server. Never resurrect a terminal transcript.
        if (current.current?.delegation.status !== 'running' && current.current) reconciled = current.current;
        else if (next.delegation.status === 'running' && current.current && (current.current.lastEventId ?? 0) > (reconciled.lastEventId ?? 0)) reconciled = current.current;
        current.current = reconciled; setDetail(reconciled); journal = newer; setError(''); setLoading(false);
        if (reconciled.delegation.status !== 'running') { source?.close(); source = undefined; setConnection('connected'); }
        else connect();
      } catch (e) { if (live && request === latestRead) { setError(`Could not load research transcript: ${errorMessage(e)}`); setLoading(false); } }
    };
    refresh.current = read;
    const connect = () => {
      if (!live || source || !current.current || current.current.delegation.status !== 'running') return;
      source = new EventSource(`/api${path}/events?after=${current.current.lastEventId ?? 0}`);
      source.onopen = () => { if (live && current.current?.delegation.status === 'running') { setConnection('connected'); void read(); } };
      source.onerror = () => { if (live && current.current?.delegation.status === 'running') { setConnection('reconnecting'); void read(); } };
      source.onmessage = event => {
        if (!live || !current.current || current.current.delegation.status !== 'running') return;
        try {
          const data = JSON.parse(event.data) as RunEvent;
          if (data.sessionId !== task.childSessionId) return;
          const id = Number(event.lastEventId || data.id || 0);
          if (id && id <= (current.current.lastEventId ?? 0)) return;
          if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid research event cursor');
          data.id = id; journal.push(data);
          if (journal.length > 2000) journalFloor = Math.max(journalFloor, journal.shift()!.id!);
          const next = { ...applyEvent(current.current, data), delegation: current.current.delegation, readOnly: true } as DelegationDetail;
          current.current = next; setDetail(next);
          if (data.type === 'done' || data.type === 'error' || data.type === 'reset') void read();
        } catch { setError('A research update could not be read. Refresh the transcript to restore its current state.'); }
      };
    };
    void read();
    return () => { live = false; latestRead++; source?.close(); refresh.current = async () => {}; };
  }, [path, task.childSessionId, task.parentTurnId, task.parentMessageId, task.toolCallId, reload]);
  useEffect(() => {
    if (previousStatus.current !== task.status) { previousStatus.current = task.status; void refresh.current(); }
  }, [task.status]);
  const summary = detail?.delegation ?? task;
  return <Modal title="Research transcript" onClose={onClose} wide>
    <div className="research-transcript">
      <div className="research-transcript-header"><div><strong>{task.description || 'Research task'}</strong><p>Read-only child transcript. Viewing or refreshing never starts another run.</p></div><span className="research-transcript-status" role="status">{summary.status === 'running' ? <Clock3 size={13} /> : <Check size={13} />}{statusLabels[summary.status]}</span></div>
      <div className="research-transcript-toolbar"><p>No composer, settings, approvals, or history actions. Return to the parent task to cancel.</p><button className="button secondary" disabled={loading} onClick={() => { if (detail) void refresh.current(); else setReload(value => value + 1); }}>Refresh transcript</button></div>
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {loading && <div className="research-loading"><SpeedRail compact active /><p>Loading research transcript…</p></div>}
      {detail && <Conversation detail={detail} connection={connection} busy={false} readOnly onDecide={() => {}} onFork={() => {}} renderQuestion={() => null} />}
    </div>
  </Modal>;
}
