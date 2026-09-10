# Permission rules

Permission rules let you decide, per tool and per argument pattern, whether a tool call is allowed without asking, always asks, or is denied outright — before the session's general permission mode applies. Rules narrow or confirm authority; they never widen it. Plan mode's read-only ceiling, project profile tool allowlists, and the researcher tool ceiling all still apply first.

## Where rules live

- **App rules** — Settings → Permissions. Stored with your other app settings.
- **Project rules** — a `.lite/permissions.json` file in the workspace, with the same shape:

```json
{
  "version": 1,
  "rules": [
    { "tool": "bash", "decision": "allow", "patterns": ["git status", "npm test", "npm run **"] },
    { "tool": "write_file", "decision": "deny", "patterns": ["**/*.env", ".env*"] },
    { "tool": "task", "decision": "allow" }
  ]
}
```

Rules for a turn are captured when your message is accepted, together with the session's other policy. Editing rules changes future turns, never a turn already running. An invalid project file is ignored with a visible notice rather than silently treated as empty — and it never blocks the turn.

## How a decision is made

For each tool call:

1. An explicit **deny** anywhere wins. The call is refused without a prompt — even in automatic-approval mode, and even when the tool was previously granted "Always allow".
2. An explicit **ask** forces a prompt every time — also overriding automatic approval and remembered grants.
3. Otherwise the ordinary policy applies: reads inside the workspace run, automatic mode or a remembered grant approves, and an explicit **allow** rule approves without asking.
4. No matching rule falls back to the session's permission mode.

Project rules outrank app rules at equal severity. Within one source, the most severe matching decision wins. Rule order never matters — there is no "last rule wins" trap where a catch-all silently revokes earlier rules.

A tool denied by a pattern-free rule is removed from the model's advertised tools for that turn entirely. Connected (MCP) tools cannot be targeted by rules and keep their own approval flow; `task` rules authorize or refuse launching a researcher but never widen what the researcher can do.

## Pattern matching

A rule with no patterns matches every call of its tool. Patterns match the tool's sensitive argument: the command text for `bash`, the supplied path for file tools (relative to the workspace or absolute), the URL for `web_fetch`, the pattern/path for `glob`/`grep`.

- A **wildcard-free bash pattern is a command prefix at a word boundary**: `git status` matches `git status` and `git status --short`, not `git statusx`.
- For other tools a wildcard-free pattern must match exactly.
- `*` stays within one unit: in paths it does not cross `/`; in bash commands it spans words and flags but never shell control operators (`;`, `&&`, `|`, backticks, `$(...)`, redirects). `npm run *` covers `npm run lint -- --fix` but not `npm run lint && curl evil.example`.
- `**` matches anything, and a leading `**/` also matches zero directories — `**/*.secret` covers both a root-level `deploy.secret` and `config/api.secret`.
- A bash command containing shell control operators is never auto-allowed through a wildcard pattern; it prompts instead, unless an exact wildcard-free pattern equals the full command.

## Access outside the workspace

File tools accept absolute paths and parent-relative paths such as `../lite/package.json`. In Ask mode, even an external read asks for approval in the main conversation, including calls from researchers and sidekicks. Plan mode permits these reads but continues to block writes and shell commands. Auto mode and matching allow rules can approve external access; explicit ask and deny rules retain precedence.

The prompt shows the resolved external target. “Always allow at this path” remembers that tool and target in this session; it does not grant access to other external paths or reuse a workspace-only grant. Search grants bind to the selected directory for that search tool. File rules are also checked against the resolved external path, so symlink aliases cannot bypass a matching deny. A target that changes while approval is pending must be submitted again.

External writes show their diff in the tool transcript but are not part of workspace Undo/Redo. Existing credential, hard-link, and `.git` write protections remain. The UI file browser and attachment endpoints remain confined to the session workspace; this extension is issued by the runner only after tool approval.

## Honest limits

Command pattern matching is a convenience on the command text, not a shell parser or a sandbox. An allowed command still runs with your local user's full capabilities, and a denied pattern only blocks commands that match it textually. Prefer deny rules for clear, narrow cases and treat allow rules as a way to reduce prompts for commands you already trust. Automatic-approval mode remains a broad opt-in; explicit deny and ask rules are the tools that constrain it.
