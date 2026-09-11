import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jobs, finishedNotice, executeBashOutput, executeWait } from '../server/jobs.js';

// Unit tests for the in-memory background-job registry. Real short shell
// commands drive real spawn/exit behavior; nothing here touches the runner.
const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 5)); } };

describe('Jobs background shell registry', () => {
  let dir: string, jobs: Jobs;
  beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'litespeed-jobs-'))); jobs = new Jobs(); });
  afterEach(async () => { jobs.killAll(); await rm(dir, { recursive: true, force: true }); });

  it('starts a job, captures output, and records the exit status', async () => {
    const view = jobs.start('s1', 'echo hello world', dir);
    expect(view.id).toBe('job-1');
    expect(view.status).toBe('running');
    await until(() => jobs.list('s1')[0].status === 'exited');
    const out = await jobs.output('s1', 'job-1', 0);
    expect(out).toContain('hello world');
    expect(out).toContain('exited (code 0)');
    expect(jobs.list('s1')[0].exitCode).toBe(0);
  });

  it('numbers jobs per session with readable ids', async () => {
    jobs.start('s1', 'true', dir); jobs.start('s1', 'true', dir);
    const other = jobs.start('s2', 'true', dir);
    expect(jobs.list('s1').map(j => j.id)).toEqual(['job-1', 'job-2']);
    expect(other.id).toBe('job-1'); // Counter is per-session.
  });

  it('trims the rolling buffer to the last 64 KiB and notes the trim', async () => {
    // Print ~200 KiB so the head slides off the 64 KiB tail.
    jobs.start('s1', 'for i in $(seq 1 4000); do printf "LINE%05d_%s\\n" "$i" "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done', dir);
    await until(() => jobs.list('s1')[0].status === 'exited');
    expect(jobs.list('s1')[0].truncated).toBe(true);
    const out = await jobs.output('s1', 'job-1', 0);
    expect(out).toContain('rolling buffer'); // Honest trim note.
    expect(out).not.toContain('LINE00001_'); // Head dropped.
    expect(out).toContain('LINE04000_'); // Tail retained.
  });

  it('rejects the 5th concurrent running job in a session', async () => {
    for (let i = 0; i < 4; i++) jobs.start('s1', 'sleep 2', dir);
    expect(() => jobs.start('s1', 'sleep 2', dir)).toThrow(/Too many background jobs/);
    expect(jobs.list('s1')).toHaveLength(4);
  });

  it('retains at most 16 jobs per session, evicting the oldest finished', async () => {
    for (let i = 0; i < 16; i++) { jobs.start('s1', 'true', dir); await until(() => jobs.list('s1').every(j => j.status !== 'running')); }
    jobs.start('s1', 'true', dir); // 17th: evicts job-1.
    const ids = jobs.list('s1').map(j => j.id);
    expect(ids).toHaveLength(16);
    expect(ids).not.toContain('job-1');
    expect(ids).toContain('job-17');
  });

  it('kills a long-running job, escalating to SIGKILL, and reports final status', async () => {
    const view = jobs.start('s1', 'sleep 30', dir);
    const pid = view.pid!;
    const result = await jobs.kill('s1', 'job-1');
    expect(result).toContain('killed');
    expect(jobs.list('s1')[0].status).toBe('killed');
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });

  it('reports the restart caveat for an unknown job on output and kill', async () => {
    expect(await jobs.output('s1', 'job-99', 0)).toBe('No such job in this session. Background jobs do not survive a server restart.');
    expect(await jobs.kill('s1', 'job-99')).toContain('do not survive a server restart');
  });

  it('advances a per-job cursor so a second read returns only new output', async () => {
    jobs.start('s1', 'echo first; sleep 0.3; echo second', dir);
    // Block until 'first' is emitted, consuming it (advancing the cursor).
    let first = '';
    for (let i = 0; i < 100 && !first.includes('first'); i++) first = await jobs.output('s1', 'job-1', 100);
    expect(first).toContain('first');
    // Second read (blocking) picks up only the later 'second' line.
    const second = await jobs.output('s1', 'job-1', 2000);
    expect(second).toContain('second');
    expect(second).not.toContain('first');
    await until(() => jobs.list('s1')[0].status === 'exited');
    const third = await jobs.output('s1', 'job-1', 0);
    expect(third).toContain('[No new output.]');
  });

  it('wait resolves when a job exits', async () => {
    jobs.start('s1', 'sleep 0.1', dir);
    const result = await jobs.wait('s1', ['job-1'], 5000);
    expect(result).toContain('job-1');
    expect(result).toContain('exited');
    expect(result).not.toContain('Timed out');
  });

  it('wait reports an honest timeout with per-job status while a job is still running', async () => {
    jobs.start('s1', 'sleep 30', dir);
    const result = await jobs.wait('s1', ['job-1'], 100);
    expect(result).toContain('running');
    expect(result).toContain('Timed out');
  });

  it('drains finished jobs exactly once for the completion notice', async () => {
    jobs.start('s1', 'true', dir);
    await until(() => jobs.list('s1')[0].status === 'exited');
    const first = jobs.drainFinished('s1');
    expect(first).toHaveLength(1);
    expect(finishedNotice(first)).toContain('Background jobs finished since the last turn: job-1 (exit 0');
    expect(jobs.drainFinished('s1')).toHaveLength(0); // Consumed.
  });

  it('killSession terminates and forgets a session\'s jobs', async () => {
    const view = jobs.start('s1', 'sleep 30', dir);
    const pid = view.pid!;
    jobs.killSession('s1');
    expect(jobs.list('s1')).toHaveLength(0);
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });

  it('validates arguments through the dispatch helpers', async () => {
    await expect(executeBashOutput(jobs, 's1', {})).rejects.toThrow(/job_id/);
    await expect(executeWait(jobs, 's1', { job_ids: [] })).rejects.toThrow(/1 to 4/);
    await expect(executeWait(jobs, 's1', { job_ids: ['a', 'b', 'c', 'd', 'e'] })).rejects.toThrow(/1 to 4/);
  });
});
