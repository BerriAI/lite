import { ShieldAlert } from 'lucide-react';
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
  if (!recovery) return null;
  return <section className="turn-history" aria-label="Turn history" aria-busy={busy}>
    {recovery && <div className="history-recovery" role="alert"><strong><ShieldAlert size={15} />History needs recovery</strong><p>{recovery.reason}</p>
      {recovery.paths.length > 0 && <><p>Check these workspace paths before retrying. Conflicting edits will not be overwritten.</p><ul aria-label="Recovery paths">{recovery.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
      <button className="button secondary" disabled={disabled} onClick={() => onAction('recover')}>Recover history</button>
    </div>}

  </section>;
}
