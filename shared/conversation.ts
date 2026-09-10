import type { Message, Usage } from './types.js';

/** Group response steps by accepted turn. System notices and tool results do
 * not start another response or prematurely reveal its usage. Older imports
 * use user-message boundaries when they predate explicit turn identities. */
export function groupRuns(messages: Message[]) {
  const rendered = messages.filter(message => message.role !== 'tool');
  const keys: string[] = [];
  const runs = new Map<string, Message[]>();
  let turn = 'legacy';
  for (const message of rendered) {
    if (message.role === 'user') turn = message.id;
    const key = message.turnId ?? turn;
    keys.push(key);
    if (message.role === 'assistant') runs.set(key, [...(runs.get(key) ?? []), message]);
  }
  return rendered.map((message, index) => {
    const run = runs.get(keys[index]) ?? [];
    const startsRun = message.role === 'assistant' && run[0] === message;
    const endsRun = message.role === 'assistant' && run.at(-1) === message;
    let runUsage: Usage | undefined = endsRun ? message.turnUsage : undefined;
    if (endsRun && !runUsage) {
      const usage = run.flatMap(step => step.usage ? [step.usage] : []);
      if (usage.length) runUsage = {
        inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
        outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
        durationMs: usage.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
        ...(usage.length === run.length && usage.every(item => item.cost !== undefined) ? {cost:usage.reduce((sum,item)=>sum+item.cost!,0)} : {}),
      };
    }
    return {message, startsRun, endsRun, closesTranscript:message.role==='assistant'&&keys[index]===keys.at(-1), runUsage, steps:startsRun?run:[]};
  });
}
