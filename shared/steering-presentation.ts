import type { Message } from './types.js';

/** Unwrap known steering notices for display without changing their delivery role.
 * An empty string is a valid attachment-only note; undefined means no match. */
export function steeringContent(message: Message): string | undefined {
  if (message.role !== 'system') return undefined;
  const match = message.content.match(/^\[Steering\] (?:The user sent this note to the running response\. (?:Update the ongoing task using this latest instruction|It supersedes their earlier request in this turn; follow it as the user's latest instruction)|This user note arrived before the response ended and still needs attention|The user sent this note before the response was interrupted\. It still needs attention): /);
  return match ? message.content.slice(match[0].length) : undefined;
}
