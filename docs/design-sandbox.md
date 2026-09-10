# Design note: optional OS-level command sandbox

Status: proposed. No code yet. Today Speedrail documents plainly that approval is not a sandbox; this note is the path to making that sentence weaker.

## Shape

Opt-in per workspace (`Settings → Workspace`), three states: `off` (default, current behavior), `enforce`, and `enforce-or-fail`.

- macOS: `sandbox-exec` (Seatbelt) profile generated per command: writable roots = workspace + session temp + explicitly configured extras; read denied for configured secret paths (always including the app's own config/database directory and any `.env` under the workspace root); network allowed only when the command's rule or approval says so.
- Linux: `bwrap` with the same policy vocabulary.
- Windows / missing backend: `enforce` degrades to `off` **with a visible per-command notice**; `enforce-or-fail` refuses the command. Never silently pretend.

## Interaction with existing layers

Permission rules and approvals decide *whether* a command runs; the sandbox constrains *what it can touch when it runs*. Deny rules still win first. The approval card shows the sandbox posture ("sandboxed: workspace-write, no network") so what the user approves includes the enforcement level. Terminal sessions (user-driven) are explicitly NOT sandboxed — the terminal is the user's own shell; only model-initiated `bash` calls are.

## Honest limits to document

Seatbelt/bwrap confine filesystem and network, not CPU/memory; profiles are best-effort against kernel-level escapes; and `enforce` mode on an unsupported platform is `off` with a notice, which is why `enforce-or-fail` exists for users who need the guarantee.

## Cost

Medium. One new module (profile generation + wrapper spawn), per-platform tests, runtime verification on macOS (CI has no Linux box here). Recommend scheduling after Phase 3; independent of everything else in the plan.
