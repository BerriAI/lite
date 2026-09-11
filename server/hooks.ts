import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { HOOK_EVENTS, HOOK_LIMITS, type HookConfig, type HookEvent } from '../shared/hooks.js';
import type { Settings } from '../shared/types.js';
import { captureProjectHooksFile, projectHooksFileExists, shellEnvironment } from './tools.js';

// Lifecycle hooks (design note 4.3). Two sources, both CAPTURED AT ACCEPTANCE
// into the RunPolicy like permission rules — later edits to Settings.hooks or
// .litespeed/hooks.json never change a running turn. Project hooks execute only for
// a workspace the user marked trusted (Settings.trustedWorkspaces, canonical
// paths); an untrusted workspace with a hooks file present gets a visible
// advisory instead of silent skipping. Hooks NEVER run for researcher children
// (their read-only ceiling doesn't warrant it, and project hooks would be an
// authority leak into an unattended context) and must NEVER crash a turn.

/** Acceptance-time snapshot: the merged runnable hooks plus any advisory about
 * ignored configuration. An empty `hooks` array means zero hook execution. */
export type CapturedHooks = { hooks: HookConfig[]; advisory?: string };

/** JSON payload delivered on the hook's stdin. Shapes per event:
 * PreToolUse: {event, sessionId, workspace, tool, args}
 * PostToolUse: {event, sessionId, workspace, tool, args, output} (output bounded 8 KiB)
 * UserPromptSubmit: {event, sessionId, workspace, prompt} (prompt bounded 8 KiB)
 * Stop: {event, sessionId, workspace, finalText} (bounded 8 KiB) */
export type HookPayload = { event: HookEvent; sessionId: string; workspace: string; actorSessionId?: string; invocationId?: string; tool?: string; args?: Record<string, unknown>; output?: string; prompt?: string; finalText?: string };

export type HookResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

// Same v1 matcher posture as permission-rule tools: exact names only. The
// schema mirrors validateRuleSet (zod, strict, bounded) so an invalid file is
// rejected as a whole — never partially applied.
const hookSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  command: z.string().min(1).max(HOOK_LIMITS.commandChars),
  matcher: z.string().min(1).max(HOOK_LIMITS.matcherChars).optional(),
}).strict();
export const hooksArraySchema = z.array(hookSchema).max(HOOK_LIMITS.hooks);
// The project file wraps the array like .litespeed/permissions.json wraps rules.
const projectHooksSchema = z.object({ version: z.literal(1), hooks: hooksArraySchema }).strict();

export function validateHooks(value: unknown): HookConfig[] {
  const parsed = hooksArraySchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error(`Invalid hooks: ${parsed.error.issues[0]?.message ?? 'unknown error'} at ${parsed.error.issues[0]?.path.join('.') || 'root'}.`), { status: 400 });
  return parsed.data;
}

const utf8Bounded = (text: string, limit: number) => { const bytes = Buffer.from(text); if (bytes.length <= limit) return text; let end = limit; while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; return bytes.subarray(0, end).toString('utf8'); };

export class Hooks {
  /** Injectable/mutable for tests only: production runs the 10s contract. */
  constructor(public timeoutMs: number = HOOK_LIMITS.timeoutMs) {}

  /** Acceptance-time capture, mirroring Runner.captureRules: app hooks from the
   * settings snapshot plus project hooks from a guarded bounded read of
   * .litespeed/hooks.json — the latter ONLY when the canonical workspace is in
   * trustedWorkspaces. Invalid or unsafe configuration is ignored with an
   * advisory; capture never throws and never blocks the turn. */
  captureHooks(workspace: string, settings: Pick<Settings, 'hooks' | 'trustedWorkspaces'>): CapturedHooks {
    const hooks: HookConfig[] = [];
    let advisory: string | undefined;
    // App hooks were validated at PATCH time, but the settings row is durable
    // state — revalidate defensively so a hand-edited database cannot smuggle
    // an unbounded command into a spawn.
    const app = hooksArraySchema.safeParse(settings.hooks ?? []);
    if (app.success) hooks.push(...app.data);
    else advisory = 'App hooks in Settings are invalid and were ignored for this turn.';
    let canonical: string | undefined;
    try { canonical = realpathSync(workspace); } catch { /* unreadable workspace: acceptance fails elsewhere */ }
    const trusted = Boolean(canonical && (settings.trustedWorkspaces ?? []).includes(canonical));
    if (!trusted) {
      // The advisory fires only when a file actually exists: a trusted-empty
      // project stays silent, an ignored real configuration stays visible.
      if (projectHooksFileExists(workspace)) advisory = [advisory, 'Project hooks are present but this workspace is not trusted; enable in Settings.'].filter(Boolean).join(' ');
      return { hooks, ...(advisory ? { advisory } : {}) };
    }
    const source = captureProjectHooksFile(workspace);
    if (source.advisory) advisory = [advisory, source.advisory].filter(Boolean).join(' ');
    if (source.text !== null) {
      try {
        const parsed = projectHooksSchema.safeParse(JSON.parse(source.text.replace(/^﻿/, '')));
        if (!parsed.success) throw new Error();
        hooks.push(...parsed.data.hooks);
      } catch { advisory = [advisory, 'Project hooks in .litespeed/hooks.json are invalid and were ignored for this turn.'].filter(Boolean).join(' '); }
    }
    return { hooks, ...(advisory ? { advisory } : {}) };
  }

  /** Hooks matching one event (and, for the tool events, one tool name).
   * A matcher on a non-tool event never matches anything by design — v1 keeps
   * the field meaningful only where the design note defines it. */
  select(captured: CapturedHooks, event: HookEvent, tool?: string): HookConfig[] {
    return captured.hooks.filter(hook => hook.event === event && (hook.matcher === undefined ? true : (event === 'PreToolUse' || event === 'PostToolUse') && hook.matcher === tool));
  }

  /** Run ONE hook: /bin/bash -c <command> with the harness-credential-stripped
   * environment (same posture as the bash tool and background jobs), the JSON
   * payload on stdin, stdout/stderr each bounded to 8 KiB, and a hard timeout
   * (SIGTERM, then SIGKILL after 2s). Never throws: every failure — spawn
   * error, timeout, signal death — comes back as a result the caller renders
   * as a warn notice. A timeout is a WARN, never a block: a hung hook must not
   * acquire veto power it did not earn with an explicit exit 2. */
  run(payload: HookPayload, hook: HookConfig, workspace: string, signal?: AbortSignal): Promise<HookResult> {
    return new Promise(resolve => {
      let stdout = '', stderr = '', timedOut = false, settled = false;
      const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalate); signal?.removeEventListener('abort', abort); kill('SIGKILL'); resolve({ code, stdout: utf8Bounded(stdout, HOOK_LIMITS.stdioBytes), stderr: utf8Bounded(stderr, HOOK_LIMITS.stdioBytes), timedOut }); };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.platform === 'win32' ? 'bash.exe' : '/bin/bash', ['-c', hook.command], { cwd: workspace, env: shellEnvironment(), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: `Could not start hook: ${error instanceof Error ? error.message : String(error)}`, timedOut: false });
        return;
      }
      const kill=(kind: NodeJS.Signals)=>{try {if(process.platform !== 'win32' && child.pid)process.kill(-child.pid,kind);else child.kill(kind);} catch {/* Process group is already gone. */}};
      const abort=()=>kill('SIGKILL');
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      let escalate: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); escalate = setTimeout(() => { kill('SIGKILL'); }, 2000); escalate.unref?.(); }, this.timeoutMs);
      timer.unref?.();
      // Cap collection at the bound plus one byte so a firehose hook cannot
      // balloon memory; the final utf8Bounded trims to a clean boundary.
      child.stdout?.on('data', chunk => { if (Buffer.byteLength(stdout) <= HOOK_LIMITS.stdioBytes) stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', chunk => { if (Buffer.byteLength(stderr) <= HOOK_LIMITS.stdioBytes) stderr += chunk.toString('utf8'); });
      child.once('error', error => { stderr += `\nHook process error: ${error instanceof Error ? error.message : String(error)}`; finish(null); });
      child.once('exit', code => finish(code));
      // A hook that never reads stdin closes the pipe: EPIPE here is normal.
      child.stdin?.on('error', () => { /* hook does not read stdin */ });
      try { child.stdin?.end(JSON.stringify(payload)); } catch { /* stdin already closed */ }
    });
  }
}
