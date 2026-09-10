/** Pure transcript-presentation logic for the terminal client. Everything here
 * is framework-free — the React layer in transcript.tsx maps these row models
 * onto renderer elements. Keeping the derivation pure means the collapse
 * rules, icons, labels, and spacing algorithm are all unit-testable without a
 * terminal. */
import type { Message, SessionDetail, Todo, ToolCall } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Formatting primitives

/** Compact human duration: 850ms, 3.4s, 2m 5s, 1h 12m, 2d 3h. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
}

export function titlecase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** Collapse long tool output to a preview. Counts by code point, not UTF-16
 * unit, so astral characters do not double-count. maxChars is derived from the
 * terminal width by the caller: maxLines * max(20, width - 6). */
export function collapseToolOutput(output: string, maxLines: number, maxChars: number): { output: string; overflow: boolean } {
  const lines = output.split('\n');
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) return { output, overflow: false };
  const preview = lines.slice(0, maxLines).join('\n');
  const points = Array.from(preview);
  if (points.length > maxChars) return { output: points.slice(0, maxChars - 1).join('') + '…', overflow: true };
  return { output: preview + '\n…', overflow: true };
}

export function outputBudget(maxLines: number, width: number): number {
  return maxLines * Math.max(20, width - 6);
}

/** Reasoning summaries may begin with a bolded title on its own paragraph. */
export function reasoningSummary(content: string): { title: string | null; body: string } {
  const trimmed = content.trim();
  const match = trimmed.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/);
  if (!match) return { title: null, body: trimmed };
  return { title: match[1].trim(), body: trimmed.slice(match[0].length) };
}

/** Primitive args rendered as a compact [key=value, …] suffix; objects and
 * arrays are dropped, and listed keys are excluded. */
export function inlineArgs(args: Record<string, unknown>, exclude: string[] = []): string {
  const parts = Object.entries(args)
    .filter(([key, value]) => !exclude.includes(key)
      && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
    .map(([key, value]) => `${key}=${value}`);
  return parts.length ? `[${parts.join(', ')}]` : '';
}

/** Extract the unified diff from a write_file/edit_file tool result. The
 * server returns a summary line followed by a createPatch() document. */
export function extractUnifiedDiff(output: string): string | null {
  const index = output.indexOf('\nIndex: ');
  const start = index >= 0 ? index + 1 : output.startsWith('Index: ') ? 0 : -1;
  if (start < 0) return null;
  const patch = output.slice(start);
  return patch.includes('@@') ? patch : null;
}

// ---------------------------------------------------------------------------
// Tool rows

export type ToolShape = 'inline' | 'block';

export interface ToolRowModel {
  call: ToolCall;
  shape: ToolShape;
  /** Inline: single glyph column. */
  icon: string;
  /** Inline body text (may contain \n for multi-line inline rows like task). */
  text: string;
  /** Pending form shown as `~ {pending}` before the tool starts producing. */
  pending: string;
  /** Block title, muted; a leading `# ` is stripped when a spinner replaces it. */
  title?: string;
  /** Block body kind. */
  body?:
    | { kind: 'bash'; command: string; output: string; running: boolean; workdir?: string }
    | { kind: 'file'; path: string; content: string }
    | { kind: 'diff'; path: string; diff: string }
    | { kind: 'todos'; todos: Todo[] }
    | { kind: 'question'; question: string; answer: string }
    | { kind: 'generic'; output: string };
  running: boolean;
  failed: boolean;
  denied: boolean;
  completed: boolean;
  /** Blank line above/below even when single-line (task rows). */
  separate: boolean;
  error?: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function baseName(toolPath: string): string { return toolPath; }

function countLines(output: string | undefined): number | null {
  const text = (output ?? '').trim();
  if (!text) return 0;
  return text.split('\n').length;
}

function matchLabel(count: number | null, word: string): string {
  if (count === null) return '';
  const plural = word.endsWith('ch') ? `${word}es` : `${word}s`;
  return ` (${count} ${count === 1 ? word : plural})`;
}

/** Map one Lite tool call onto its presentation row. */
export function toolRow(call: ToolCall): ToolRowModel {
  const running = call.status === 'running' || call.status === 'pending';
  const failed = call.status === 'error';
  const denied = call.status === 'denied';
  const completed = call.status === 'completed';
  const base: Omit<ToolRowModel, 'icon' | 'text' | 'pending'> = {
    call, shape: 'inline', running, failed, denied, completed, separate: false,
    error: failed ? (call.output || 'Tool failed.') : undefined,
  };
  const args = call.args ?? {};
  switch (call.name) {
    case 'bash': {
      const command = str(args.command);
      if (running && !completed && !failed && !denied) {
        return { ...base, icon: '$', text: command, pending: 'Writing command…' };
      }
      const workdirRaw = str(args.cwd);
      const workdir = workdirRaw && workdirRaw !== '.' ? workdirRaw : undefined;
      return {
        ...base, shape: 'block', icon: '$', text: command, pending: 'Writing command…',
        title: workdir ? `# Running in ${workdir}` : undefined,
        body: { kind: 'bash', command, output: stripAnsi((call.output ?? '').trim()), running: false, workdir },
      };
    }
    case 'write_file': {
      const filePath = baseName(str(args.path));
      if (!completed) return { ...base, icon: '←', text: `Write ${filePath}`, pending: 'Preparing write…' };
      return {
        ...base, shape: 'block', icon: '←', text: `Write ${filePath}`, pending: 'Preparing write…',
        title: `# Wrote ${filePath}`,
        body: { kind: 'file', path: filePath, content: str(args.content) },
      };
    }
    case 'edit_file': {
      const filePath = baseName(str(args.path));
      const label = `Edit ${filePath} ${inlineArgs(args, ['path', 'old_string', 'new_string'])}`.trimEnd();
      const diff = completed ? extractUnifiedDiff(call.output ?? '') : null;
      if (!diff) return { ...base, icon: '←', text: label, pending: 'Preparing edit…' };
      return {
        ...base, shape: 'block', icon: '←', text: label, pending: 'Preparing edit…',
        title: `← Edit ${filePath}`,
        body: { kind: 'diff', path: filePath, diff },
      };
    }
    case 'read_file': {
      const label = `Read ${baseName(str(args.path))} ${inlineArgs(args, ['path'])}`.trimEnd();
      return { ...base, icon: '→', text: label, pending: 'Reading file…' };
    }
    case 'glob': {
      const count = completed ? countLines(call.output) : null;
      const where = str(args.path) ? ` in ${str(args.path)}` : '';
      return { ...base, icon: '✱', text: `Glob "${str(args.pattern)}"${where}${matchLabel(count, 'match')}`, pending: 'Finding files…' };
    }
    case 'grep': {
      const count = completed ? countLines(call.output) : null;
      return { ...base, icon: '✱', text: `Grep "${str(args.pattern)}"${matchLabel(count, 'match')}`, pending: 'Searching content…' };
    }
    case 'web_fetch':
      return { ...base, icon: '%', text: `WebFetch ${str(args.url)}`, pending: 'Fetching from the web…' };
    case 'web_search':
      return { ...base, icon: '◈', text: `Web Search "${str(args.query)}"`, pending: 'Searching web…' };
    case 'task': {
      const description = str(args.description);
      if (!description) return { ...base, icon: '│', text: '', pending: 'Delegating…' };
      const lines = [`Research Task — ${description}`];
      if (running) lines.push('↳ working');
      return {
        ...base, icon: completed ? '✓' : '│', text: lines.join('\n'),
        pending: 'Delegating…', separate: true,
      };
    }
    case 'todo_write': {
      const todos = parseTodos(args.todos);
      if (!completed || !todos.length) {
        return { ...base, icon: '⚙', text: 'Updating todos…', pending: 'Updating todos…' };
      }
      return {
        ...base, shape: 'block', icon: '⚙', text: 'Todos', pending: 'Updating todos…',
        title: '# Todos', body: { kind: 'todos', todos },
      };
    }
    case 'ask_user': {
      const question = str(args.question);
      if (!completed) return { ...base, icon: '→', text: 'Asked 1 question', pending: 'Asking questions…' };
      return {
        ...base, shape: 'block', icon: '→', text: 'Questions', pending: 'Asking questions…',
        title: '# Questions',
        body: { kind: 'question', question, answer: questionAnswer(call.output ?? '') },
      };
    }
    default: {
      const label = `${call.name} ${inlineArgs(args)}`.trimEnd();
      return { ...base, icon: '⚙', text: label, pending: label || 'Working…' };
    }
  }
}

export function parseTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Todo =>
    typeof item === 'object' && item !== null
    && typeof (item as Todo).content === 'string' && typeof (item as Todo).status === 'string');
}

/** ask_user results are JSON like {"answer":"…"} or plain text. */
export function questionAnswer(output: string): string {
  const text = output.trim();
  if (!text) return '(no answer)';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed || '(no answer)';
    if (parsed && typeof parsed === 'object') {
      const answer = (parsed as Record<string, unknown>).answer ?? (parsed as Record<string, unknown>).answers;
      if (typeof answer === 'string') return answer || '(no answer)';
      if (Array.isArray(answer)) return answer.filter(entry => typeof entry === 'string').join(', ') || '(no answer)';
    }
  } catch { /* plain text */ }
  return text;
}

export const TODO_MARKERS: Record<Todo['status'], string> = {
  completed: '[✓]', in_progress: '[•]', pending: '[ ]',
};

/** Minimal ANSI escape stripper for command output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\][^]*(?:|\\)?/g, '');
}

// ---------------------------------------------------------------------------
// Message → row derivation

export type TranscriptRow =
  | { kind: 'user'; message: Message; queued: boolean; separate: true; multiline: true }
  | { kind: 'reasoning'; message: Message; running: boolean; title: string | null; body: string; separate: true; multiline: boolean }
  | { kind: 'text'; message: Message; text: string; separate: true; multiline: true }
  | { kind: 'tool'; message: Message; row: ToolRowModel; separate: boolean; multiline: boolean }
  | { kind: 'error'; message: Message; error: string; separate: true; multiline: true }
  | { kind: 'footer'; message: Message; mode: string; model: string; duration: string; interrupted: boolean; separate: true; multiline: false }
  | { kind: 'queued'; content: string; separate: true; multiline: true };

export const INTERRUPTED_CONTENT = 'Response stopped.';

export function isInterrupted(message: Message): boolean {
  return message.role === 'assistant' && message.content === INTERRUPTED_CONTENT && !message.error;
}

/** A turn's final assistant message carries usage (set from the provider's
 * usage frame at end of stream) — that is the footer anchor. */
export function isFinalAssistant(message: Message): boolean {
  return message.role === 'assistant' && (Boolean(message.usage) || isInterrupted(message) || Boolean(message.error));
}

export function deriveRows(detail: SessionDetail): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const messages = detail.messages;
  const busy = detail.session.status === 'running' || detail.session.status === 'waiting';
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user') {
      if (!message.content.trim() && !(message.attachments?.length)) continue;
      rows.push({ kind: 'user', message, queued: false, separate: true, multiline: true });
      continue;
    }
    if (message.role !== 'assistant') continue; // tool/system messages carry no chrome of their own
    const isLast = index === messages.length - 1;
    if (message.reasoning?.trim()) {
      const { title, body } = reasoningSummary(message.reasoning);
      const running = isLast && busy && !message.content.trim() && !(message.toolCalls?.length);
      rows.push({ kind: 'reasoning', message, running, title, body, separate: true, multiline: false });
    }
    const interrupted = isInterrupted(message);
    if (message.content.trim() && !interrupted) {
      rows.push({ kind: 'text', message, text: message.content.trim(), separate: true, multiline: true });
    }
    for (const call of message.toolCalls ?? []) {
      const row = toolRow(call);
      rows.push({
        kind: 'tool', message, row,
        separate: row.shape === 'block' || row.separate,
        multiline: row.shape === 'block' || row.text.includes('\n'),
      });
    }
    if (message.error) {
      rows.push({ kind: 'error', message, error: message.error, separate: true, multiline: true });
    }
    // The last message earns its footer only once the turn is fully settled —
    // a completed provider stream can still be mid-turn while tools run.
    const footerReady = isLast ? !busy : isFinalAssistant(message);
    if (footerReady && (message.content.trim() || message.toolCalls?.length || message.error)) {
      rows.push({
        kind: 'footer', message,
        mode: titlecase(detail.session.mode),
        model: detail.session.model,
        duration: message.usage?.durationMs ? formatDuration(message.usage.durationMs) : '',
        interrupted, separate: true, multiline: false,
      });
    }
  }
  for (const item of detail.queue?.items ?? []) {
    rows.push({ kind: 'queued', content: item.content, separate: true, multiline: true });
  }
  return rows;
}

/** Sibling spacing: a row gets a blank line above when the previous sibling is
 * multi-line or either side is marked always-separate; adjacent single-line
 * rows pack together. The first row never gets a margin. */
export function marginAbove(rows: TranscriptRow[], index: number): 0 | 1 {
  if (index === 0) return 0;
  const previous = rows[index - 1];
  const current = rows[index];
  if (previous.multiline || previous.separate || current.separate) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// File type detection for syntax highlighting

const FILETYPES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'c_sharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', html: 'html',
  css: 'css', scss: 'scss', sql: 'sql', swift: 'swift', php: 'php',
  lua: 'lua', vim: 'vim', zig: 'zig', ex: 'elixir', exs: 'elixir',
};

export function filetypeOf(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return FILETYPES[filePath.slice(dot + 1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Spinner / scanner frames

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 80;
export const SCANNER_WIDTH = 8;
export const SCANNER_INTERVAL_MS = 40;
export const SCANNER_HOLD_START = 30;
export const SCANNER_HOLD_END = 9;

/** One frame of the block scanner: position sweeps 0..width-1 and back, with
 * hold frames at each end. Returns the glyph row (■ active, ⬝ inactive). */
export function scannerFrame(tick: number, width = SCANNER_WIDTH): string {
  const sweep = width - 1;
  const cycle = SCANNER_HOLD_START + sweep + SCANNER_HOLD_END + sweep;
  let t = tick % cycle;
  let position: number;
  if (t < SCANNER_HOLD_START) position = 0;
  else if ((t -= SCANNER_HOLD_START) < sweep) position = t + 1;
  else if ((t -= sweep) < SCANNER_HOLD_END) position = sweep;
  else position = sweep - (t - SCANNER_HOLD_END) - 1;
  return Array.from({ length: width }, (_, i) => (i === position ? '■' : '⬝')).join('');
}
