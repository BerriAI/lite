import { execFile } from 'node:child_process';

/** Injectable spawner so tests never touch the real OS notification surface.
 * Matches the execFile(command, args, options, callback) arity we use. */
export type Spawner = (command: string, args: string[], options: { timeout: number }, callback: (error: Error | null) => void) => unknown;

/** AppleScript string literal: the ONLY escapes AppleScript honors inside
 * double quotes are \\ and \" — so escape exactly those. The user-influenced
 * text (session titles) is embedded as data inside the script argument, and
 * execFile passes the script as one argv entry with no shell, so no shell
 * interpolation of user text can occur. JSON.stringify is NOT used because
 * its \n / \uXXXX escapes are not AppleScript escapes and would render
 * literally; control characters are stripped instead. */
const appleScriptString = (text: string) => `"${text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Best-effort desktop notification (5.3). Fire-and-forget by design:
 * - macOS: osascript 'display notification' (no dependency, no permission prompt);
 * - linux: notify-send when installed (its absence surfaces as a spawn error we swallow);
 * - windows / anything else: no-op (no portable zero-dependency channel in v1).
 * Never throws and never rejects — a notification failure must never touch the
 * turn that triggered it. 2s timeout kills a hung binary. Text is bounded so a
 * runaway title cannot become a huge argv. */
export function notify(title: string, body: string, spawner: Spawner = execFile as unknown as Spawner): void {
  try {
    const boundedTitle = String(title).slice(0, 100), boundedBody = String(body).slice(0, 300);
    const swallow = () => { /* best-effort: absence of notify-send, dead osascript, etc. */ };
    if (process.platform === 'darwin') {
      const script = `display notification ${appleScriptString(boundedBody)} with title ${appleScriptString(boundedTitle)}`;
      spawner('osascript', ['-e', script], { timeout: 2000 }, swallow);
    } else if (process.platform === 'linux') {
      spawner('notify-send', [boundedTitle, boundedBody], { timeout: 2000 }, swallow);
    }
  } catch { /* never throws: notifications are advisory */ }
}
