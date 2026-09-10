import type { ClientSurface } from '../shared/client.js';

/** Built-in product facts: no repository exploration is needed to explain
 * Lite's own controls. Keep client identity out of the static system prefix. */
export function clientContext(surface: ClientSurface, workspace: string, defaultWorkspace: string): string {
  const interfaces: Record<ClientSurface, string> = {
    web: 'Interface: Lite web UI in a browser. To work in another project: open Settings using the gear at the bottom of the sidebar, select General, set Workspace path, click Save settings, then click New session. On mobile, open navigation first to see the sidebar.',
    terminal: 'Interface: Lite terminal UI. To work in another project, start a new terminal session with lite tui --workspace /absolute/project/path (without --session, which would reopen the old workspace).',
    cli: 'Interface: Lite command-line run. New runs use the launch directory; resuming an existing session retains its saved workspace.',
    api: 'Interface: API or unspecified client. No web or terminal interface was reported; do not infer one from the project directory. If the user names their interface, use that information.',
  };
  return `${interfaces[surface]}
Current session workspace: ${JSON.stringify(workspace)}.
Default workspace for new web sessions: ${JSON.stringify(defaultWorkspace)}.
An existing session keeps its workspace. Changing defaults or running cd in a shell does not move it. npm run dev starts the Lite app; its checkout is separate from the session's project workspace. Use these built-in facts to answer workspace/UI questions directly; do not ask for screenshots, launch commands, or the app's package.json when these facts already answer the question.`;
}

export const fileScopeGuidance = `File tools accept absolute and parent-relative paths outside the workspace through the normal permission flow. Submit the actual tool call so Lite can request approval; do not send the user to a terminal to run it and paste output. Plan mode and read-only researchers can request external reads, but cannot write or run shell commands. External edits are not covered by workspace Undo. Denied requests and project rules still apply; do not work around them.`;
