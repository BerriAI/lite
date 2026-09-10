/** Pure protocol helpers for the terminal client: SSE frame parsing, slash
 * command parsing, and terminal-safe text. No I/O — everything here is unit
 * testable without a server or a TTY. */

/** One parsed SSE data frame. Comments (heartbeats) never surface. */
export interface SseFrame { id?: number; data: string }

/** Incremental server-sent-events parser. Feed raw chunks in any split; frames
 * come out exactly once, in order. Only `id:` and `data:` fields matter to
 * Speedrail's journal; multiple data lines join with newlines per the SSE spec. */
export class SseParser {
  private buffer = '';
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let boundary;
    while ((boundary = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let id: number | undefined;
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('id:')) { const value = Number(line.slice(3).trim()); if (Number.isFinite(value)) id = value; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) frames.push({ ...(id !== undefined ? { id } : {}), data: data.join('\n') });
    }
    return frames;
  }
}

/** Model- and configuration-authored content is data, never terminal escape
 * sequences. The multiline variant keeps newlines and tabs for transcripts. */
export function terminalText(value: unknown, multiline = false): string {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, character => {
    if (multiline && (character === '\n' || character === '\t')) return character;
    const code = character.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

export interface SlashCommand { name: string; args: string }
/** A leading slash makes a command; everything after the first token is its
 * argument text verbatim. Non-slash input (including "/" alone) is a message. */
export function parseSlash(input: string): SlashCommand | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : null;
}

/** One-line summary of tool arguments for activity lines: well-known keys
 * render bare, anything else as compact JSON, capped and escape-safe. */
export function summarizeArgs(args: Record<string, unknown> | undefined, max = 120): string {
  if (!args || !Object.keys(args).length) return '';
  for (const key of ['command', 'path', 'file_path', 'filePath', 'url', 'query', 'pattern', 'name']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return clip(terminalText(value), max);
  }
  let json = ''; try { json = JSON.stringify(args) ?? ''; } catch { json = '[unserializable arguments]'; }
  return clip(terminalText(json), max);
}
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
