import type { Message, ToolCall } from '../shared/types.js';
import { checkFailed, isCheckCommand, type TurnReceipts } from '../shared/receipts.js';

/** Pure end-of-turn accounting from tool receipts. Walks the assistant
 * messages AFTER the accepted user turn (sinceMessageId; from the start when
 * undefined or not found) in transcript order, which is execution order —
 * batches run sequentially and each call is finalized before the next starts.
 * Only status 'completed' calls count: a denied or failed write changed
 * nothing, and a background bash start is a launch receipt, not evidence the
 * command ran to completion. */
export function computeReceipts(messages: Message[], sinceMessageId: string | undefined): TurnReceipts {
  const at = sinceMessageId === undefined ? -1 : messages.findIndex(message => message.id === sinceMessageId);
  const turn = messages.slice(at + 1);
  const filesChanged: string[] = [];
  const commandsRun: string[] = [];
  const checksRun: string[] = [];
  const checksFailed: string[] = [];
  const unresolvedChecks = new Set<string>();
  // Sequence positions let "after the last check" and "read earlier" compare
  // across batches without carrying timestamps (endedAt granularity is ms and
  // ties within a batch are common).
  const lastChange = new Map<string, number>();
  const firstRead = new Map<string, number>();
  const unread = new Set<string>();
  let sequence = 0, lastCheck = -1;
  // The result content lives on the call itself once finalized; the paired
  // tool message is the fallback (e.g. transcripts imported without outputs).
  const result = (call: ToolCall) => call.output ?? turn.find(message => message.role === 'tool' && message.toolCallId === call.id)?.content ?? '';
  for (const message of turn) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const seq = sequence++;
      for(const change of call.changes??[]) {
        if(!lastChange.has(change.path))filesChanged.push(change.path);
        lastChange.set(change.path,seq);
      }
      if (call.status !== 'completed') continue;
      const path = typeof call.args.path === 'string' ? call.args.path : undefined;
      if (call.name === 'read_file' && path !== undefined) {
        if (!firstRead.has(path)) firstRead.set(path, seq);
      } else if ((call.name === 'write_file' || call.name === 'edit_file') && path !== undefined) {
        if (!lastChange.has(path)) filesChanged.push(path); // Dedupe, first-change order.
        lastChange.set(path, seq);
        // Exact read_file path match only, strictly earlier in this turn. A file
        // surfacing inside grep/glob RESULT text is too fuzzy to prove the model
        // looked at it, so those never clear the flag (documented limitation).
        const read = firstRead.get(path);
        if (read === undefined || read >= seq) unread.add(path);
      } else if ((call.name === 'bash' || call.name === 'verify') && call.args.run_in_background !== true) {
        const command = typeof call.args.command === 'string' ? call.args.command : '';
        commandsRun.push(command);
        if (call.name === 'verify' || isCheckCommand(command)) {
          checksRun.push(command);
          if (checkFailed(result(call))) { checksFailed.push(command); unresolvedChecks.add(command); }
          else unresolvedChecks.delete(command);
          lastCheck = seq;
        }
      }
    }
  }
  // Empty when no checks ran: that turn is already fully described by "no checks were run".
  const filesChangedAfterLastCheck = lastCheck < 0 ? [] : filesChanged.filter(path => lastChange.get(path)! > lastCheck);
  return { filesChanged, commandsRun, checksRun, checksFailed, unresolvedChecks: [...unresolvedChecks], filesChangedAfterLastCheck, unreadFilesChanged: filesChanged.filter(path => unread.has(path)) };
}

/** The short host line appended to a mutating turn's final assistant message
 * when the work is unverified; null when nothing needs saying (no mutation, or
 * checks ran after the last change). Observation only, never a gate. */
export function receiptsNotice(receipts: TurnReceipts): string | null {
  if (receipts.unresolvedChecks?.length) return `\n\n[Receipts: ${receipts.unresolvedChecks.length} check(s) still failing: ${receipts.unresolvedChecks.join(', ')}.]`;
  if (!receipts.filesChanged.length || (receipts.checksRun.length !== 0 && !receipts.filesChangedAfterLastCheck.length)) return null;
  const detail = receipts.checksRun.length === 0 ? ', no checks were run' : `, ${receipts.filesChangedAfterLastCheck.length} changed after the last check`;
  return `\n\n[Receipts: ${receipts.filesChanged.length} file(s) changed${detail}.]`;
}
