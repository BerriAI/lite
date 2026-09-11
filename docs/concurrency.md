# Concurrent tasks and workspace access

Read-only tools and recognized shell inspections can run while another session changes the same workspace. The shell inspection path supports literal Git status, branch listings, remotes, diff/log, file reads with cat/head/tail, ls, wc, pwd, and gh --version. Every command in a sequence separated by `;`, `&&`, or `||` must qualify. Substitutions, redirects, pipes, background jobs, unknown commands, and unrecognized flags keep normal write coordination. This classification does not grant permission or enable Bash in Plan mode.

Inspections execute parsed arguments directly. Git optional index locks, fsmonitor, configured clean/process filters, external diff/text conversion, lazy object fetching, and pagers are disabled. Unsafe Git metadata/configuration can still produce an actionable error. Inspection results are live observations, not a consistent snapshot of a changing checkout, and are not recorded as file edits for Undo.

An edit or other shell command waits until the session currently changing that workspace finishes its turn. Both clients show the owning task and a waiting status inline. Waiting can be cancelled without executing the command. File history starts after the wait, so Undo attributes the resulting edit to the correct task. The lock coordinates sessions inside this server; commands in external terminals and unrelated applications are not covered.

## Parallel editing

Team Fusion and Expert Fusion already run simultaneous workers in isolated working copies and integrate their results under the parent task. Independent top-level sessions opened on the same workspace still share its files and serialize writes. To edit independently, select separate Git worktree directories as the sessions' workspaces. Automatic worktree creation and integration for every independent session is a separate product change; the inspection fix does not silently move existing sessions or their uncommitted files.

Public harness designs follow the isolation pattern:

| Harness | Documented approach |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/environments/git-worktrees) | Independent chats can use Git worktrees, with separate files and shared repository metadata. Handoff moves work between a worktree and the local checkout. |
| [Claude Code](https://code.claude.com/docs/en/worktrees) | `--worktree` isolates sessions; subagents can use `isolation: worktree`. Its worktree checks prevent edits and Git redirects into the main checkout. Worktrees share Git metadata and permission rules. |
| [Devin](https://docs.devin.ai/work-with-devin/advanced-capabilities) | Managed sessions run in separate VMs. A coordinator scopes tasks, monitors them, resolves conflicts, and combines results. |

These are documented capabilities, not claims about private internal locking algorithms. Isolation reduces collisions; it does not remove the need to review integration conflicts or coordinate shared services such as databases and development-server ports.
