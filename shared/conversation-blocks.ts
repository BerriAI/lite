import { groupRuns } from './conversation.js';
import type { Message } from './types.js';

/** Text and user/system messages form reading boundaries. Tool-only provider
 * rounds extend the preceding assistant block instead of becoming new rows. */
export function conversationBlocks(messages: Message[]) {
  const blocks: ReturnType<typeof groupRuns> = [];
  for (const entry of groupRuns(messages)) {
    const previous = blocks.at(-1);
    if (entry.message.role === 'assistant' && !entry.message.content.trim() && !entry.message.error && !entry.message.receipts && !entry.message.attachments?.length && !entry.startsRun && previous?.message.role === 'assistant') {
      previous.steps.push(entry.message);
      previous.endsRun = entry.endsRun;
      previous.closesTranscript = entry.closesTranscript;
      previous.runUsage = entry.runUsage;
    } else blocks.push({ ...entry, steps: entry.message.role === 'assistant' ? [entry.message] : [] });
  }
  return blocks;
}
