/** ANSI rendering for the terminal client: a scrollback transcript plus a
 * volatile bottom region (streaming tail, status row, composer row) that is
 * erased and redrawn as state changes. The row math relies on every volatile
 * row being clipped to the terminal width so nothing wraps. */

const colorEnabled = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string, text: string) => colorEnabled() ? `[${code}m${text}[0m` : text;
export const paint = {
  dim: (text: string) => wrap('2', text),
  bold: (text: string) => wrap('1', text),
  cyan: (text: string) => wrap('36', text),
  green: (text: string) => wrap('32', text),
  yellow: (text: string) => wrap('33', text),
  red: (text: string) => wrap('31', text),
  magenta: (text: string) => wrap('35', text),
};

const COLOR_SEQUENCE = /\[[0-9;]*m/g;
export const visibleLength = (text: string) => text.replace(COLOR_SEQUENCE, '').length;

/** Clip to `max` visible characters, keeping color sequences intact and always
 * ending with a reset when any sequence was kept. */
export function clipVisible(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  let output = '', visible = 0, sawColor = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '') {
      const match = /^\[[0-9;]*m/.exec(text.slice(i));
      if (match) { output += match[0]; i += match[0].length - 1; sawColor = true; continue; }
    }
    if (visible >= max) break;
    output += text[i]; visible++;
  }
  return output + (sawColor ? '[0m' : '');
}

/** Keep the END of a long single-line input visible (a live composer tail). */
export function tailClip(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;
}

/** Single-row composer window: keeps the cursor visible inside `width` visible
 * characters. Newlines display as ␤ (same length, so cursor math is unchanged). */
export function composerView(text: string, cursor: number, width: number): { view: string; column: number } {
  const sanitized = text.replace(/\n/g, '␤');
  const w = Math.max(8, width);
  if (sanitized.length <= w) return { view: sanitized, column: Math.min(cursor, sanitized.length) };
  const start = Math.max(0, Math.min(cursor - Math.floor(w / 2), sanitized.length - w));
  return { view: sanitized.slice(start, start + w), column: Math.min(cursor, sanitized.length) - start };
}

export class Screen {
  private volatileRows = 0;
  constructor(private out: NodeJS.WriteStream = process.stdout) {}
  get columns() { return Math.max(20, this.out.columns ?? 80); }
  /** Permanent lines scroll into terminal history; volatile rows are redrawn in
   * place. `cursorColumn` positions the cursor on the LAST volatile row. */
  paint(permanent: string[], volatile: string[], cursorColumn = 0) {
    let output = '';
    if (this.volatileRows > 1) output += `[${this.volatileRows - 1}A`;
    output += '\r[0J';
    for (const line of permanent) output += `${line}\n`;
    const rows = volatile.map(row => clipVisible(row, this.columns - 1));
    output += rows.join('\n');
    const last = rows.at(-1) ?? '';
    const column = Math.min(Math.max(cursorColumn, 0), visibleLength(last));
    output += `\r${column > 0 ? `[${column}C` : ''}`;
    this.out.write(output);
    this.volatileRows = Math.max(rows.length, 1);
  }
  /** Leave whatever is on the volatile rows behind as permanent output. */
  release() { this.out.write('\n'); this.volatileRows = 0; }
}
