import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { SIDECAR_EVENTS, SIDECAR_LIMITS, type SidecarConfig } from '../shared/sidecars.js';
import { shellEnvironment } from './tools.js';

// Sidecar extensions (design note 4.5): a sidecar is a long-lived hook with a
// JSON-RPC stream instead of one-shot exec. One instance lives on the Runner
// (like Jobs); processes are lazy-spawned per config on first interception,
// PER-PROCESS (they do not survive a server restart), and killed on shutdown.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio. For every intercepted
// tool call the host writes one line:
//   {"jsonrpc":"2.0","id":1,"method":"tool_call","params":{"sessionId":"...","tool":"write_file","args":{...}}}
// and expects one line back within SIDECAR_LIMITS.timeoutMs:
//   {"jsonrpc":"2.0","id":1,"result":{"action":"pass"}}
//   {"jsonrpc":"2.0","id":1,"result":{"action":"modify","args":{...},"reason":"<=200 chars"}}
//   {"jsonrpc":"2.0","id":1,"result":{"action":"block","reason":"<=200 chars"}}
// FAILURE POSTURE mirrors hooks: a broken sidecar must never break the loop.
// Timeout, malformed output, spawn failure, and crash all resolve to 'pass'
// with a warn the caller renders as a system notice. A crashed sidecar
// respawns lazily on its next use, at most SIDECAR_LIMITS.respawns times per
// server process; after that it is disabled for the process lifetime with one
// notice (further calls pass silently — a dead sidecar must not spam every
// tool call). intercept() never throws.

/** Host-facing verdict for one intercepted call. `warn`, when present, is an
 * auditable notice the caller persists (pass with warn = something broke). */
export type SidecarDecision =
  | { action: 'pass'; warn?: string }
  | { action: 'modify'; args: Record<string, unknown>; reason: string }
  | { action: 'block'; reason: string };

export type SidecarPayload = { sessionId: string; tool: string; args: Record<string, unknown> };

// Validation mirrors validateHooks (zod, strict, bounded): an invalid array is
// rejected as a whole at PATCH time and revalidated defensively at read time.
// Names are slugs because they render verbatim in "modified by <name>".
const sidecarSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'name must be a lowercase slug (a-z, 0-9, hyphens, max 64 chars)'),
  command: z.string().min(1).max(SIDECAR_LIMITS.commandChars),
  events: z.array(z.enum(SIDECAR_EVENTS)).min(1).max(SIDECAR_EVENTS.length),
}).strict();
export const sidecarsArraySchema = z.array(sidecarSchema).max(SIDECAR_LIMITS.sidecars)
  .refine(list => new Set(list.map(sidecar => sidecar.name)).size === list.length, 'Sidecar names must be unique.');

export function validateSidecars(value: unknown): SidecarConfig[] {
  const parsed = sidecarsArraySchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(`Invalid sidecars: ${parsed.error.issues[0]?.message ?? 'unknown error'} at ${parsed.error.issues[0]?.path.join('.') || 'root'}.`), { status: 400 });
  return parsed.data;
}

const LINE_BUFFER_CAP = 256 * 1024;   // A response line larger than this is garbage; drop it.
const KILL_ESCALATE_MS = 2000;

type Process = {
  child: ChildProcess;
  command: string;             // The command this process was spawned with (config edits restart).
  alive: boolean;
  nextId: number;
  buffer: string;              // Partial stdout line accumulator.
  pending: Map<number, (message: Record<string, unknown> | 'dead') => void>;
};

export class Sidecars {
  /** Injectable/mutable for tests only: production runs the 3s contract. */
  constructor(public timeoutMs: number = SIDECAR_LIMITS.timeoutMs) {}
  private processes = new Map<string, Process>();
  private crashRespawns = new Map<string, number>(); // Spawns after a crash, per name, per server process.
  private disabled = new Set<string>();              // Exhausted the respawn budget; process lifetime.
  private disabledNotified = new Set<string>();      // The one disabled notice was already emitted.

  /** Intercept one tool call through one sidecar. Never throws; every failure
   * is a 'pass' (with a warn the first time it is informative). */
  async intercept(config: SidecarConfig, payload: SidecarPayload): Promise<SidecarDecision> {
    if (this.disabled.has(config.name)) {
      // One notice when disablement is first observed, then silence: the
      // interception layer must not turn a dead sidecar into per-call spam.
      if (this.disabledNotified.has(config.name)) return { action: 'pass' };
      this.disabledNotified.add(config.name);
      return { action: 'pass', warn: `Sidecar crashed repeatedly and was disabled for the rest of this server process (${SIDECAR_LIMITS.respawns}-respawn limit). Tool calls proceed unmodified. Fix the sidecar and restart the server.` };
    }
    const entry = this.ensure(config);
    if (entry === 'disabled') { this.disabledNotified.add(config.name); return { action: 'pass', warn: `Sidecar crashed repeatedly and was disabled for the rest of this server process (${SIDECAR_LIMITS.respawns}-respawn limit). Tool calls proceed unmodified. Fix the sidecar and restart the server.` }; }
    if (entry === null) return { action: 'pass', warn: 'Sidecar could not be started; the tool call proceeds unmodified.' };
    const id = entry.nextId++;
    const answer = await new Promise<Record<string, unknown> | 'dead' | 'timeout'>(resolve => {
      const timer = setTimeout(() => { entry.pending.delete(id); resolve('timeout'); }, this.timeoutMs);
      timer.unref?.();
      entry.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      try { entry.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tool_call', params: payload })}\n`); }
      catch { entry.pending.delete(id); clearTimeout(timer); resolve('dead'); }
    });
    // A hung sidecar keeps running (it may just be slow); each timeout warns
    // and passes — a sidecar can never acquire veto power by not answering.
    if (answer === 'timeout') return { action: 'pass', warn: `Sidecar did not respond within ${this.timeoutMs / 1000}s; the tool call proceeds unmodified (timeouts pass, never block).` };
    if (answer === 'dead') return { action: 'pass', warn: 'Sidecar crashed before answering; the tool call proceeds unmodified. It will be restarted on its next use.' };
    if (answer.error !== undefined) return { action: 'pass', warn: 'Sidecar returned a JSON-RPC error; the tool call proceeds unmodified.' };
    return this.decision(answer.result);
  }

  /** Validate one JSON-RPC result into a decision. Anything off-contract is a
   * 'pass' with a warn: a malformed sidecar cannot block or modify. */
  private decision(result: unknown): SidecarDecision {
    const malformed: SidecarDecision = { action: 'pass', warn: 'Sidecar returned a malformed result; the tool call proceeds unmodified.' };
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return malformed;
    const { action, args, reason } = result as Record<string, unknown>;
    if (action === 'pass') return { action: 'pass' };
    const validReason = typeof reason === 'string' && reason.trim().length > 0 && reason.length <= SIDECAR_LIMITS.reasonChars;
    if (action === 'block') return validReason ? { action: 'block', reason: reason as string } : malformed;
    if (action === 'modify') return validReason && args !== null && typeof args === 'object' && !Array.isArray(args) ? { action: 'modify', args: args as Record<string, unknown>, reason: reason as string } : malformed;
    return malformed;
  }

  /** Lazy spawn / respawn / config-change restart. Returns the live process,
   * null when spawn itself failed, or 'disabled' when the crash-respawn budget
   * is exhausted. A CONFIG EDIT (same name, new command) restarts the process
   * without spending the respawn budget — the budget guards crashloops, not
   * deliberate user changes. */
  private ensure(config: SidecarConfig): Process | null | 'disabled' {
    let entry = this.processes.get(config.name);
    if (entry && entry.alive && entry.command === config.command) return entry;
    if (entry && entry.alive) { this.kill(entry); entry = undefined; this.processes.delete(config.name); } // Config changed: deliberate restart.
    if (entry && !entry.alive) {
      const count = (this.crashRespawns.get(config.name) ?? 0) + 1;
      if (count > SIDECAR_LIMITS.respawns) { this.disabled.add(config.name); this.processes.delete(config.name); return 'disabled'; }
      this.crashRespawns.set(config.name, count);
      this.processes.delete(config.name);
    }
    return this.spawn(config);
  }

  /** Same spawn posture as hooks and background jobs: /bin/bash -c with the
   * harness-credential-stripped environment. No cwd override: sidecars are
   * app-level (not project-scoped), so they run from the server's own cwd. */
  private spawn(config: SidecarConfig): Process | null {
    let child: ChildProcess;
    try {
      child = spawn(process.platform === 'win32' ? 'bash.exe' : '/bin/bash', ['-c', config.command], { env: shellEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { return null; }
    const entry: Process = { child, command: config.command, alive: true, nextId: 1, buffer: '', pending: new Map() };
    this.processes.set(config.name, entry);
    const dead = () => {
      if (!entry.alive) return;
      entry.alive = false;
      for (const resolve of entry.pending.values()) resolve('dead');
      entry.pending.clear();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      entry.buffer += chunk.toString('utf8');
      if (entry.buffer.length > LINE_BUFFER_CAP && !entry.buffer.includes('\n')) { entry.buffer = ''; return; } // Firehose without newlines: drop, don't balloon.
      const lines = entry.buffer.split('\n');
      entry.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message && typeof message === 'object' && typeof message.id === 'number') {
            const resolve = entry.pending.get(message.id);
            if (resolve) { entry.pending.delete(message.id); resolve(message as Record<string, unknown>); }
          }
        } catch { /* Non-JSON stdout noise is ignored; the request times out to 'pass'. */ }
      }
    });
    child.stderr?.on('data', () => { /* Sidecar stderr is its own log, not ours. */ });
    child.stdin?.on('error', () => { /* Write-after-death surfaces as 'dead' at the write site. */ });
    child.once('error', dead);
    child.once('exit', dead);
    return entry;
  }

  private kill(entry: Process): void {
    for (const resolve of entry.pending.values()) resolve('dead');
    entry.pending.clear();
    entry.alive = false;
    try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
    const escalate = setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_ESCALATE_MS);
    escalate.unref?.();
  }

  /** Kill every sidecar (server shutdown / test teardown). Does not wait. */
  stopAll(): void {
    for (const entry of this.processes.values()) if (entry.alive) this.kill(entry);
    this.processes.clear();
  }
}
