import { Worker } from 'node:worker_threads';
import type { McpCodeResult } from '../shared/mcp.js';

export const MCP_CODE_LIMITS = {
  codeBytes: 64 * 1024, argumentBytes: 1024 * 1024, resultBytes: 2 * 1024 * 1024,
  outputBytes: 16 * 1024, calls: 50, concurrentCalls: 4,
  timeoutMs: 120_000, cpuMs: 2000, memoryBytes: 64 * 1024 * 1024,
} as const;
export class McpCodeDenied extends Error {}

export interface McpCodeOptions {
  code: string;
  names: string[];
  signal: AbortSignal;
  invoke(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCodeResult>;
  /** Injectable only by local callers, never by model arguments. */
  limits?: Partial<{ [K in keyof typeof MCP_CODE_LIMITS]: number }>;
}

/** The guest is QuickJS/WASM in a disposable worker, NOT node:vm or eval in
 * the application. Only JSON crosses the bridge. The host remains the sole
 * authority for catalog membership, approval, and remote dispatch. */
export async function executeMcpCode(options: McpCodeOptions): Promise<string> {
  const limits = { ...MCP_CODE_LIMITS, ...options.limits };
  if (typeof options.code !== 'string' || !options.code.trim() || Buffer.byteLength(options.code) > limits.codeBytes) throw new Error('code must be non-empty TypeScript, at most 64 KiB.');
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const names = new Set(options.names);
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './mcp-code-worker.ts' : './mcp-code-worker.js', import.meta.url), {
    workerData: { code: options.code, names: [...names], limits },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    // Do not inherit a development runner, inspector, preload, or loader.
    execArgv: [], env: {}, stdout: true, stderr: true,
  });
  worker.stdout?.resume(); worker.stderr?.resume();
  const pending = new Set<Promise<void>>();
  const queue: { id: number; name: string; args: Record<string, unknown> }[] = [];
  let active = 0, calls = 0, settled = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        controller.abort(); queue.length = 0;
        if (error) reject(error); else resolve(output ?? '');
      };
      const abort = () => finish(new Error('MCP code execution cancelled. Calls already sent may have completed; they were not retried.'));
      const timer = setTimeout(() => finish(new Error('MCP code execution timed out. Calls already sent may have completed; they were not retried.')), limits.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const drain = () => {
        while (!settled && active < limits.concurrentCalls && queue.length) {
          const request = queue.shift()!; active++;
          const task = (async () => {
            try {
              signal.throwIfAborted();
              const result = await options.invoke(request.name, request.args, signal);
              if (settled) return;
              const json = JSON.stringify(result);
              if (Buffer.byteLength(json) > limits.resultBytes) throw new Error('MCP result exceeds the code execution limit. Narrow the tool request.');
              worker.postMessage({ id: request.id, json });
            } catch (error) {
              // A denied, stale, or failed call stops the entire script, even
              // if guest code tries to catch it and continue making changes.
              finish(error instanceof Error ? error : new Error('MCP tool execution failed.'));
            } finally { active--; }
          })();
          pending.add(task);
          void task.finally(() => { pending.delete(task); drain(); });
        }
      };
      worker.on('error', () => finish(new Error('MCP code worker failed or exceeded its memory limit.')));
      worker.on('exit', () => { if (!settled) finish(new Error('MCP code worker exited before returning a result.')); });
      worker.on('message', (message: { type?: string; id?: number; name?: string; args?: string; output?: string; error?: string }) => {
        if (settled) return;
        try {
          if (message.type === 'done') {
            if (active || queue.length) throw new Error('Await every tool call before returning from the script.');
            if (message.error) throw new Error(message.error.slice(0, 2000));
            if (typeof message.output !== 'string' || Buffer.byteLength(message.output) > limits.outputBytes + 200) throw new Error('Invalid code execution output.');
            finish(undefined, message.output); return;
          }
          if (message.type !== 'call' || !Number.isInteger(message.id) || typeof message.name !== 'string' || !names.has(message.name)) throw new Error('The script requested a tool outside this turn’s MCP catalog.');
          if (++calls > limits.calls) throw new Error('MCP code execution exceeds the 50-call limit. Split the workflow into smaller steps.');
          if (typeof message.args !== 'string' || Buffer.byteLength(message.args) > limits.argumentBytes) throw new Error('MCP script arguments exceed the limit.');
          const args: unknown = JSON.parse(message.args);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP tool arguments must be a JSON object.');
          queue.push({ id: message.id!, name: message.name, args: args as Record<string, unknown> }); drain();
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid MCP code request.')); }
      });
    });
  } finally {
    controller.abort();
    await worker.terminate();
    await Promise.allSettled([...pending]);
  }
}
