import { History, Redo2, ShieldAlert, Undo2 } from 'lucide-react';
import type { HistoryState } from '../../shared/history';

interface Props {
  history: HistoryState;
  disabled: boolean;
  busy: boolean;
  running: boolean;
  preparing: boolean;
  onAction: (action: 'undo' | 'redo' | 'recover') => void;
}

export function TurnHistory({ history, disabled, busy, running, preparing, onAction }: Props) {
  const recovery = history.pendingRecovery;
  const reason = busy ? 'Updating turn history…' : preparing ? 'Wait for message preparation to finish.' : running ? 'Stop the response or wait for it to finish before changing history.' : history.unavailableReason;
  return <section className="turn-history" aria-label="Turn history" aria-busy={busy}>
    <div className="history-toolbar"><strong><History size={14} />Turn history</strong><div className="history-actions">
      <button className="text-button" disabled={disabled || Boolean(recovery) || !history.canUndo || !history.undoId} onClick={() => onAction('undo')}><Undo2 size={14} />Undo last turn</button>
      <button className="text-button" disabled={disabled || Boolean(recovery) || !history.canRedo || !history.redoId} onClick={() => onAction('redo')}><Redo2 size={14} />Redo turn</button>
    </div></div>
    {reason && <p className="history-reason" role="status">{reason}</p>}
    {recovery && <div className="history-recovery" role="alert"><strong><ShieldAlert size={15} />History needs recovery</strong><p>{recovery.reason}</p>
      {recovery.paths.length > 0 && <><p>Check these workspace paths before retrying. Conflicting edits will not be overwritten.</p><ul aria-label="Recovery paths">{recovery.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
      <button className="button secondary" disabled={disabled} onClick={() => onAction('recover')}>Recover history</button>
    </div>}
    <details className="history-scope"><summary>What undo and redo change</summary><p>Only this turn’s saved conversation, recorded file edits and plan. Shell commands, MCP actions and terminal effects are not reversed or replayed. Redo restores a snapshot without another provider request. Queued messages stay paused; drafts are kept.</p></details>
  </section>;
}
