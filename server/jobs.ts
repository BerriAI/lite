import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { shellEnvironment } from './tools.js';

// Background shell jobs are IN-MEMORY and PER-PROCESS: they do NOT survive a
// server restart. Every "unknown job" message says so honestly, because after a
// restart a job id the model still remembers simply no longer exists here.
const OUTPUT_CAP = 64 * 1024;         // Rolling buffer: last 64 KiB retained.
const MAX_RUNNING = 4;                 // Concurrent running jobs per session.
const MAX_RETAINED = 16;               // Total jobs retained per session.
const HARD_CAP_MS = 30 * 60 * 1000;    // No default timeout, but a hard 30-min ceiling.
const KILL_ESCALATE_MS = 2000;         // SIGTERM -> SIGKILL grace for kill_shell.
const COMMAND_LIMIT = 128 * 1024;      // Same command size as the bash tool.

export type JobStatus = 'running' | 'exited' | 'killed' | 'failed';
export interface JobView { id: string; command: string; status: JobStatus; pid?: number; startedAt: number; endedAt?: number; exitCode?: number; signal?: string; timedOut: boolean; truncated: boolean }

interface Job {
  id: string; sessionId: string; command: string;
  child?: ChildProcess; pid?: number;
  startedAt: number; endedAt?: number;
  status: JobStatus; exitCode?: number; signal?: string;
  timedOut: boolean; truncated: boolean;
  output: Buffer;          // Rolling tail, capped at OUTPUT_CAP.
  cursor: number;          // Bytes of `output` already returned via bash_output.
  dropped: number;         // Bytes discarded from the head since cursor last read.
  consumed: boolean;       // Whether the completion notice has been drained.
  waiters: Set<() => void>;// Resolved on any status/output change.
  timer?: ReturnType<typeof setTimeout>;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const RESTART_NOTE = 'No such job in this session. Background jobs do not survive a server restart.';

/** In-memory registry of model-initiated background shell jobs. One instance
 * lives on the Runner; jobs are keyed by session so notices and limits are
 * per-session. Nothing here is persisted. */
export class Jobs {
  private jobs = new Map<string, Job>();       // Global id -> job.
  private counters = new Map<string, number>();  // Per-session 'job-N' counter.

  private key(sessionId: string, id: string): string { return `${sessionId}\0${id}`; }
  private find(sessionId: string, id: string): Job | undefined { return this.jobs.get(this.key(sessionId, id)); }
  private forSession(sessionId: string): Job[] { return [...this.jobs.values()].filter(job => job.sessionId === sessionId); }

  /** Start a background job. cwd is validated by the caller (the bash tool path).
   * Rejects when the per-session running cap is reached. */
  start(sessionId: string, command: string, cwd: string): JobView {
    if (typeof command !== 'string' || !command.trim()) throw new Error('command must be a non-empty string.');
    if (command.length > COMMAND_LIMIT || command.includes('\0')) throw new Error('Command is too large or contains a null byte.');
    const session = this.forSession(sessionId);
    if (session.filter(job => job.status === 'running').length >= MAX_RUNNING) throw new Error(`Too many background jobs are already running in this session (limit ${MAX_RUNNING}). Wait for one to finish or kill it first.`);
    // Retain at most MAX_RETAINED per session: evict the oldest FINISHED job.
    if (session.length >= MAX_RETAINED) {
      const oldest = session.filter(job => job.status !== 'running').sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))[0];
      if (oldest) this.jobs.delete(this.key(sessionId, oldest.id));
    }
    const count = (this.counters.get(sessionId) ?? 0) + 1;
    this.counters.set(sessionId, count);
    const id = `job-${count}`;
    const job: Job = { id, sessionId, command, startedAt: Date.now(), status: 'running', timedOut: false, truncated: false, output: Buffer.alloc(0), cursor: 0, dropped: 0, consumed: false, waiters: new Set() };
    this.jobs.set(this.key(sessionId, id), job);
    // Same shell and environment as the foreground bash tool: /bin/bash -c with
    // harness credentials stripped. detached so we can signal the whole tree.
    let child: ChildProcess;
    try {
      child = spawn(process.platform === 'win32' ? 'bash.exe' : '/bin/bash', ['-c', command], { cwd, env: shellEnvironment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      job.status = 'failed'; job.endedAt = Date.now();
      job.output = Buffer.from(`Could not start job: ${errorMessage(error)}`);
      return this.view(job);
    }
    job.child = child; job.pid = child.pid;
    const append = (chunk: Buffer) => {
      job.output = Buffer.concat([job.output, chunk]);
      if (job.output.length > OUTPUT_CAP) {
        const overflow = job.output.length - OUTPUT_CAP;
        job.output = job.output.subarray(overflow);
        job.truncated = true;
        // Keep the cursor pointing at unread bytes as the head slides off.
        job.dropped += Math.max(0, overflow - job.cursor);
        job.cursor = Math.max(0, job.cursor - overflow);
      }
      this.wake(job);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', error => { if (job.status === 'running') { job.status = 'failed'; job.endedAt = Date.now(); append(Buffer.from(`\n[Job process error: ${errorMessage(error)}]`)); this.settle(job); } });
    child.once('exit', (code, signal) => {
      // A shell can exit before its background descendants. Reap the owned
      // process group now, while its identity still belongs to this job.
      this.signalTree(job, 'SIGKILL');
      if (job.status !== 'running') { this.settle(job); return; }
      job.exitCode = code ?? undefined; job.signal = signal ?? undefined;
      job.status = job.timedOut ? 'killed' : signal ? 'killed' : 'exited';
      job.endedAt = Date.now();
      this.settle(job);
    });
    // Hard 30-minute ceiling: SIGTERM then SIGKILL, reported as timed out.
    job.timer = setTimeout(() => { job.timedOut = true; this.signalTree(job, 'SIGTERM'); setTimeout(() => this.signalTree(job, 'SIGKILL'), KILL_ESCALATE_MS); }, HARD_CAP_MS);
    job.timer.unref?.();
    return this.view(job);
  }

  private settle(job: Job): void { if (job.timer) { clearTimeout(job.timer); job.timer = undefined; } this.wake(job); }
  private wake(job: Job): void { for (const resolve of job.waiters) resolve(); job.waiters.clear(); }
  private waitChange(job: Job, ms: number): Promise<void> {
    if (job.status !== 'running' || ms <= 0) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); job.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms); timer.unref?.();
      job.waiters.add(done);
    });
  }
  private signalTree(job: Job, signal: NodeJS.Signals): void {
    if (!job.child?.pid || job.status !== 'running') return;
    try {
      if (process.platform !== 'win32') process.kill(-job.child.pid, signal);
      else job.child.kill(signal);
    } catch { try { job.child.kill(signal); } catch { /* already gone */ } }
  }

  view(job: Job): JobView {
    return { id: job.id, command: job.command, status: job.status, pid: job.pid, startedAt: job.startedAt, endedAt: job.endedAt, exitCode: job.exitCode, signal: job.signal, timedOut: job.timedOut, truncated: job.truncated };
  }
  /** Detail-only projection for the session API. */
  list(sessionId: string): JobView[] { return this.forSession(sessionId).sort((a, b) => a.startedAt - b.startedAt).map(job => this.view(job)); }

  private statusLine(job: Job): string {
    if (job.status === 'running') return `Status: running (pid ${job.pid ?? 'unknown'}).`;
    const elapsed = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
    if (job.status === 'exited') return `Status: exited (code ${job.exitCode ?? 'unknown'}) after ${elapsed}s.`;
    if (job.status === 'killed') return `Status: ${job.timedOut ? `timed out after ${elapsed}s (30-minute cap; SIGTERM then SIGKILL)` : `killed${job.signal ? ` (${job.signal})` : ''} after ${elapsed}s`}.`;
    return `Status: failed after ${elapsed}s.`;
  }

  /** bash_output: return new output since the last read, advancing the cursor.
   * Optionally block up to wait_ms for a change. */
  async output(sessionId: string, jobId: string, waitMs: number): Promise<string> {
    let job = this.find(sessionId, jobId);
    if (!job) return RESTART_NOTE;
    if (waitMs > 0 && job.cursor >= job.output.length && job.status === 'running') await this.waitChange(job, waitMs);
    job = this.find(sessionId, jobId); if (!job) return RESTART_NOTE;
    const slice = job.output.subarray(job.cursor);
    const dropped = job.dropped; job.dropped = 0;
    job.cursor = job.output.length;
    const header = this.statusLine(job);
    const trimNote = dropped > 0 || (job.truncated && job.cursor === 0) ? `\n[${dropped > 0 ? `${dropped} earlier byte(s) dropped from the 64 KiB rolling buffer.` : 'Output buffer trimmed to the last 64 KiB.'}]` : '';
    const body = slice.length ? slice.toString('utf8') : '[No new output.]';
    return `${header}${trimNote}\n${body}`;
  }

  /** kill_shell: SIGTERM, escalate to SIGKILL after 2s, return final status. */
  async kill(sessionId: string, jobId: string): Promise<string> {
    const job = this.find(sessionId, jobId);
    if (!job) return RESTART_NOTE;
    if (job.status !== 'running') return `Job ${job.id} is not running. ${this.statusLine(job)}`;
    this.signalTree(job, 'SIGTERM');
    const escalate = setTimeout(() => this.signalTree(job, 'SIGKILL'), KILL_ESCALATE_MS); escalate.unref?.();
    // Wait for exit (bounded by the escalation plus a short grace) then report.
    for (let waited = 0; job.status === 'running' && waited < KILL_ESCALATE_MS + 1000; waited += 50) await this.waitChange(job, 50);
    clearTimeout(escalate);
    return `Job ${job.id}: ${this.statusLine(job)}`;
  }

  /** wait: block until all listed jobs finish or the timeout elapses. */
  async wait(sessionId: string, jobIds: string[], timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const pending = () => jobIds.filter(id => this.find(sessionId, id)?.status === 'running');
    while (pending().length && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      await Promise.race(pending().map(id => this.waitChange(this.find(sessionId, id)!, remaining)));
    }
    const lines = jobIds.map(id => {
      const job = this.find(sessionId, id);
      return job ? `${job.id}: ${this.statusLine(job)}` : `${id}: ${RESTART_NOTE}`;
    });
    const timedOut = pending().length ? `\n[Timed out after ${Math.round(timeoutMs / 1000)}s; some jobs are still running.]` : '';
    return `${lines.join('\n')}${timedOut}`;
  }

  /** Completion drain: unconsumed finished jobs for this session, marked
   * consumed so the next-turn notice appears exactly once. */
  drainFinished(sessionId: string): JobView[] {
    const finished = this.forSession(sessionId).filter(job => job.status !== 'running' && !job.consumed).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const job of finished) job.consumed = true;
    return finished.map(job => this.view(job));
  }

  /** Kill every job in one session (session delete). Best-effort SIGKILL. */
  killSession(sessionId: string): void { for (const job of this.forSession(sessionId)) { if (job.status === 'running') this.signalTree(job, 'SIGKILL'); this.jobs.delete(this.key(sessionId, job.id)); } this.counters.delete(sessionId); }

  /** Keep the output receipts, but settle owned processes before a worker ends. */
  async stopSession(sessionId: string): Promise<void> {
    const running=this.forSession(sessionId).filter(job=>job.status==='running');
    await Promise.all(running.map(job=>this.kill(sessionId,job.id)));
    if (running.some(job=>job.status==='running')) throw new Error('Background process cleanup is still pending.');
  }

  /** Kill all jobs across all sessions (server shutdown). Does not wait. */
  killAll(): void { for (const job of this.jobs.values()) if (job.status === 'running') this.signalTree(job, 'SIGTERM'); }
}

/** One-line completion notice for the per-turn envelope, or '' when nothing
 * finished. Format: 'job-2 (exit 0, 14s), job-3 (killed).' */
export function finishedNotice(views: JobView[]): string {
  if (!views.length) return '';
  const describe = (job: JobView): string => {
    const secs = job.endedAt ? `, ${Math.round((job.endedAt - job.startedAt) / 1000)}s` : '';
    if (job.status === 'exited') return `${job.id} (exit ${job.exitCode ?? 'unknown'}${secs})`;
    if (job.status === 'killed') return `${job.id} (${job.timedOut ? 'timed out' : 'killed'}${secs})`;
    return `${job.id} (failed${secs})`;
  };
  return `Background jobs finished since the last turn: ${views.map(describe).join(', ')}.`;
}

// The narrow arg parsers used by the runner-dispatched execute functions.
function requireJobId(args: Record<string, unknown>): string {
  const value = args.job_id;
  if (typeof value !== 'string' || !value.trim()) throw new Error('job_id must be a non-empty string.');
  return value;
}
function optionalMs(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  return value;
}

/** bash_output execution, dispatched by the runner (mirrors executeToolOutputPage).
 * async so invalid arguments surface as a rejected promise, not a sync throw. */
export async function executeBashOutput(jobs: Jobs, sessionId: string, args: Record<string, unknown>): Promise<string> {
  return jobs.output(sessionId, requireJobId(args), optionalMs(args, 'wait_ms', 0, 0, 30_000));
}
/** kill_shell execution, dispatched by the runner. */
export async function executeKillShell(jobs: Jobs, sessionId: string, args: Record<string, unknown>): Promise<string> {
  return jobs.kill(sessionId, requireJobId(args));
}
/** wait execution, dispatched by the runner. */
export async function executeWait(jobs: Jobs, sessionId: string, args: Record<string, unknown>): Promise<string> {
  const ids = args.job_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 4 || ids.some(id => typeof id !== 'string' || !id.trim())) throw new Error('job_ids must be an array of 1 to 4 non-empty strings.');
  return jobs.wait(sessionId, ids as string[], optionalMs(args, 'timeout_ms', 30_000, 1, 120_000));
}
