# Project profiles and instruction skills

A profile is an explicitly selected set of project instructions and built-in tool restrictions. A skill is reusable instruction text you explicitly add. Neither is an executable plugin, a subagent, or a grant of permission.

## Define a profile

Open **Settings → Project profiles → New profile** to set a name, description, and instructions. **Tools and defaults** configures available tools, an optional model/mode default, and recommended skills. Save, then choose **Use profile** to apply it. **Edit profile** changes an existing definition without replacing active snapshots. Stale saves are rejected and retain your draft.

The editor saves `.speedrail/profiles.json` in the project workspace. You can also maintain that file directly:

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "reviewer",
      "name": "Careful reviewer",
      "description": "Inspect code and report verified findings without editing.",
      "instructions": "Read the relevant code before drawing conclusions. Cite affected files and distinguish confirmed defects from uncertainty.",
      "tools": ["read_file", "glob", "grep", "todo_read"],
      "defaultMode": "plan",
      "skills": ["verification"]
    }
  ],
  "skills": [
    {
      "id": "verification",
      "name": "Verification checklist",
      "description": "Keep conclusions tied to evidence."
    }
  ]
}
```

Create `.speedrail/skills/verification/SKILL.md`:

```markdown
Check the relevant edge cases before reporting a finding.
Separate tests you ran from tests you recommend.
Do not claim a change, command, or test succeeded without its result.
```

Skill paths are derived from their IDs, not arbitrary paths in the manifest. Markdown is instruction text; it does not execute code. There are no includes, hooks, environment substitutions, remote skill downloads, or automatic activation. A profile's `skills` list is a recommendation, never a selection.

The optional `defaultModel` is an inseparable provider/model pair:

```json
{ "providerId": "litellm", "model": "your-coding-model" }
```

Use a provider ID already configured in Speedrail. Model discovery can be incomplete, so an explicit model ID need not appear in its catalog. These defaults do not create a provider or store credentials.

## Select deliberately

Open **Settings → Project profiles**. Choose a profile and inspect its instructions, included/excluded tools, and defaults. Check each skill you want; recommendations start unchecked.

- **Use profile** keeps the displayed model and mode. It saves the selected profile and skills.
- **Apply defaults** explicitly adopts the profile's model/mode defaults as well. A Plan → Build change is shown before applying.
- **Reload profile** replaces the active snapshot with the currently reviewed source. It does not change model, mode, or permissions.
- **Use default** removes profile and skill instructions/restrictions, without changing your model, mode, permissions, or remembered approvals.
- **Refresh catalog** rereads available project configuration but does not activate it.

You can select skills with the default profile. Skills alone do not restrict tools. On the welcome screen, the choice applies when you send the first message; it is not a background session or model request.

Changes to an existing session hold queued work for explicit Resume. An active response, pending question, or history recovery must finish before reconfiguration. Conflicting changes from another client are rejected rather than silently overwriting their selection. Unsent composer drafts remain separate.

## CLI selection

Run from the project directory against a running Speedrail server:

```sh
node /path/to/speedrail/bin/speedrail.mjs profiles
node /path/to/speedrail/bin/speedrail.mjs run "Review the parser" --profile reviewer --skills verification
node /path/to/speedrail/bin/speedrail.mjs run "Review without extra skills" --profile reviewer --skills none
node /path/to/speedrail/bin/speedrail.mjs run "Inspect edge cases" --skills verification --plan
```

`speedrail profiles --workspace /path/to/project --json` lists the canonical workspace, catalog revision, metadata, and diagnostics. It does not activate anything. `run` uses the current working directory; inspect or change an existing session's project configuration in the app instead of passing profile overrides with `--session`.

Omitting `--skills` selects **no skills**, including recommendations. Select up to eight unique comma-separated IDs; `none` explicitly selects none. A selected profile can supply provider/model and mode defaults. Override its model with **both** `--provider` and `--model`. `--plan` or `--build` explicitly overrides its mode; these flags cannot be combined. A stale catalog fails rather than silently selecting changed instructions.

Profiles do not imply `--auto`. Without an explicit automatic-permission choice, ordinary approval behavior still applies. With `--json`, events remain NDJSON on stdout and diagnostics/questions go to stderr.

## Tool restrictions are not permissions

A named profile requires a `tools` array. Supported entries are:

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`, `web_fetch`, `todo_read`, `todo_write`.

An empty array means no operational tools. `ask_user` remains available as an interaction for asking a decision; it is not listed in the allowlist. Named profiles exclude MCP tools and delegation in this version.

Speedrail intersects the profile allowlist with the session's mode, both when advertising tools and before executing an emitted tool call. A profile cannot enable mutable tools in Plan mode. Auto approval and remembered grants cannot authorize an excluded tool. Existing permission mode and remembered approvals are not changed by switching profiles.

**This is not a sandbox.** Allowing `bash` grants access to a shell governed by the ordinary approval policy; shell commands retain the local user's capabilities. The terminal is direct user input and is independent of the model's profile. Profile text never overrides harness constraints.

## Pinned configuration

Speedrail reads and validates the selected files, then saves a private instruction/tool snapshot for the session. Future turns use that snapshot without rereading its skill files. Instructions and selected skill bodies are included in context estimates and sent to the chosen provider when a turn runs.

Editing or deleting a source file does not silently alter or weaken an active profile. The dialog shows changed, missing, or invalid source status. Review the current files and explicitly reload, select a replacement, or clear the profile.

- Restart retains the pinned configuration without source reload or model replay.
- Undo/redo restores recorded turn history, not profile/model/mode settings.
- Same-workspace forks copy the current pinned configuration, not historical configuration at the forked message. They do not inherit remembered tool grants or queued work.
- Compaction archives copy the pinned configuration atomically, without resolving source files again.
- Exports include public profile provenance, not the private instruction/skill snapshot. Conversation and tool output may independently contain sensitive project text; review exports before sharing.
- Imports never activate exported profiles or read their local paths. Select a local profile explicitly afterward.

## Bounds and validation

Configuration uses a strict version 1 JSON schema. Unknown properties, duplicate IDs, unsupported tool names, and invalid references are rejected. IDs are lowercase ASCII slugs using letters, digits, and hyphens, up to 64 characters.

| Limit | Maximum |
| --- | --- |
| Profiles per manifest | 32 |
| Declared skills | 64 |
| Selected skills per session | 8 |
| Manifest | 128 KiB |
| Serialized profile definition | 16 KiB |
| Individual skill body | 32 KiB |
| Selected instruction and skill bodies combined | 96 KiB |

Sources must be complete UTF-8 regular files within the canonical workspace. Symlink components, hard links, nonregular files, unsafe aliases, and oversized reads are rejected. Diagnostics describe the problem without echoing file contents. This special reader accepts only the exact manifest and derived skill paths; it does not relax ordinary file-tool restrictions.

In this repository `.speedrail/` is ignored because it also stores local state and credentials. To share project instructions through Git, review and explicitly stage only the intended manifest/skill files according to your project's ignore rules. Never broadly force-add `.speedrail/`, which can include databases and subscription tokens.
