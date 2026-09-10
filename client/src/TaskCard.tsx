import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, RotateCw, X, Zap } from 'lucide-react';
import type { DelegationDetail, DelegationSummary } from '../../shared/delegation';
import type { RunEvent } from '../../shared/types';
import { api, applyEvent, errorMessage } from './api';
import { Conversation } from './Conversation';
import { SpeedRail } from './ui';

const statusLabels: Record<DelegationSummary['status'], string> = { running: 'Researching', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', interrupted: 'Interrupted' };
const sidekick = (task: DelegationSummary) => Boolean(task.role);
const actor = (task: DelegationSummary) => task.role === 'expert' ? 'Expert' : task.role === 'worker' ? 'Worker' : 'Sidekick';
const statusLabel = (task: DelegationSummary) => task.status === 'running' && sidekick(task) ? 'Working' : statusLabels[task.status];
export const delegationPath = (task: DelegationSummary) => `/sessions/${encodeURIComponent(task.parentSessionId)}/delegations/${encodeURIComponent(task.id)}`;
export function TaskCard({ task, expanded, onCancel, cancelling, error }: { task: DelegationSummary; expanded: boolean; onCancel: () => void; cancelling: boolean; error?: string }) {
  const running = task.status === 'running';
  const fusion = sidekick(task);
  return <section className="research-task" role="region" aria-label={fusion ? `${actor(task)} task` : 'Research task'}>
    <div className="research-task-heading">{fusion ? <Zap size={16} /> : <BookOpen size={16} />}<strong title={fusion ? `${actor(task)} · edits and commands use this session’s permissions` : "Read-only research"}>{task.description || (fusion ? `${actor(task)} task` : 'Research task')}</strong><span className="task-state" role="status">{!running && (task.status === 'completed' ? <Check size={12} /> : <X size={12} />)}<span className="sr-only">{cancelling ? 'Cancelling…' : statusLabel(task)}</span></span><div className="research-task-actions">{running && <button className="text-button" disabled={cancelling} onClick={onCancel}>Cancel task</button>}</div></div>
    {task.error && <p className="error-text" role="status">{task.error}</p>}

    {error && <p className="error-text" role="alert">{error}</p>}
    {expanded && <TaskTranscript task={task} />}

  </section>;
}

export function TaskTranscript({ task }: { task: DelegationSummary }) {
  const [detail, setDetail] = useState<DelegationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [reload, setReload] = useState(0);
  const current = useRef<DelegationDetail | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const previousStatus = useRef(task.status);
  const path = delegationPath(task);
  const fusion = sidekick(task);
  const noun = fusion ? actor(task).toLowerCase() : 'research';
  useEffect(() => {
    let live = true, source: EventSource | undefined, journal: RunEvent[] = [], latestRead = 0, journalFloor = 0;
    current.current = null; setDetail(null); setLoading(true); setError(''); setConnection('connecting');
    const valid = (value: DelegationDetail) => value.readOnly === true && value.session.id === task.childSessionId && value.delegation.id === task.id && value.delegation.parentSessionId === task.parentSessionId && value.delegation.childSessionId === task.childSessionId && value.delegation.parentTurnId === task.parentTurnId && value.delegation.parentMessageId === task.parentMessageId && value.delegation.toolCallId === task.toolCallId;
    const read = async () => {
      const request = ++latestRead;
      try {
        const next = await api<DelegationDetail>(path);
        if (!live || request !== latestRead) return;
        if (!valid(next)) throw new Error(fusion ? 'Sidekick transcript does not match this task.' : 'Research transcript does not match this task.');
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
      } catch (e) { if (live && request === latestRead) { setError(`Could not load ${noun} transcript: ${errorMessage(e)}`); setLoading(false); } }
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
          if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid ${noun} event cursor`);
          data.id = id; journal.push(data);
          if (journal.length > 2000) journalFloor = Math.max(journalFloor, journal.shift()!.id!);
          const next = { ...applyEvent(current.current, data), delegation: current.current.delegation, readOnly: true } as DelegationDetail;
          current.current = next; setDetail(next);
          if (data.type === 'done' || data.type === 'error' || data.type === 'reset') void read();
        } catch { setError(`A ${noun} update could not be read. Refresh the transcript to restore its current state.`); }
      };
    };
    void read();
    return () => { live = false; latestRead++; source?.close(); refresh.current = async () => {}; };
  }, [path, task.childSessionId, task.parentTurnId, task.parentMessageId, task.toolCallId, reload]);
  useEffect(() => {
    if (previousStatus.current !== task.status) { previousStatus.current = task.status; void refresh.current(); }
  }, [task.status]);
  return <div className="research-transcript inline-transcript" role="region" aria-label={`${fusion ? actor(task) : 'Research'} transcript`}>
    <button className="icon-button transcript-refresh" title="Refresh transcript" disabled={loading} onClick={() => { if (detail) void refresh.current(); else setReload(value => value + 1); }}><RotateCw size={12} /><span className="sr-only">Refresh transcript</span></button>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {loading && <div className="research-loading"><SpeedRail compact active /><p>Loading {noun} transcript…</p></div>}
    {detail && <Conversation detail={detail} connection={connection} busy={false} readOnly inline onDecide={() => {}} onFork={() => {}} renderQuestion={() => null} />}
  </div>;
}
