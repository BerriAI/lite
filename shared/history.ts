export interface HistoryState {
  hasCheckpoints: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoId?: string;
  redoId?: string;
  unavailableReason?: string;
  effectsNotice?: string;
  pendingRecovery?: { reason: string; paths: string[] };
}
