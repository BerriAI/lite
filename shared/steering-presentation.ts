import type { Message } from './types.js';

/** Extract the user-authored steering note into an ordinary user message. The
 * persisted `[Steering] …` wrapper is an internal audit marker (see
 * server/runner.ts); it must never leak onto the rendered transcript. Returns
 * undefined for non-steering system messages, keeping delivery semantics
 * (the handler still sees role 'system' upstream). */
export function steeringContent(message: Message): string | undefined {
  if (message.role !== 'system') return undefined;
  const match = message.content.match(/^\[Steering\] (?:The user sent this note to the running response\. (?:Update the ongoing task using this latest instruction|It supersedes their earlier request in this turn; follow it as the user's latest instruction)|This user note arrived before the response ended and still needs attention|The user sent this note before the response was interrupted\. It still needs attention): /);
  return match ? message.content.slice(match[0].length) : undefined;
}
