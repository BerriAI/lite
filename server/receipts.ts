import type { Message, ToolCall } from '../shared/types.js';
import { checkCommandKey, checkFailed, isCheckCommand, type TurnReceipts } from '../shared/receipts.js';
export { verificationNotice as receiptsNotice } from '../shared/verification.js';

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
  const unresolvedChecks = new Map<string, string>();
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
      const path = call.name==='code_write'&&typeof call.args.target==='string'?call.args.target:typeof call.args.path==='string'?call.args.path:undefined;
      if (call.name === 'read_file' && !call.routing && path !== undefined) {
        if (!firstRead.has(path)) firstRead.set(path, seq);
      } else if ((call.name === 'write_file' || call.name === 'edit_file' || call.name === 'code_write') && path !== undefined) {
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
          const key = JSON.stringify([call.args.cwd ?? '', checkCommandKey(command)]);
          if (checkFailed(result(call))) { checksFailed.push(command); unresolvedChecks.set(key, command); }
          else if (/(?:^|\n)Exit code: 0\s*$/.test(result(call))) unresolvedChecks.delete(key);
          lastCheck = seq;
        }
      }
    }
  }
  // Empty when no checks ran: that turn is already fully described by "no checks were run".
  const filesChangedAfterLastCheck = lastCheck < 0 ? [] : filesChanged.filter(path => lastChange.get(path)! > lastCheck);
  return { filesChanged, commandsRun, checksRun, checksFailed, unresolvedChecks: [...unresolvedChecks.values()], filesChangedAfterLastCheck, unreadFilesChanged: filesChanged.filter(path => unread.has(path)) };
}
