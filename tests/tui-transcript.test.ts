import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../shared/types.js';
import {
  collapseToolOutput, extractUnifiedDiff, filetypeOf, formatDuration,
  inlineArgs, outputBudget,
  questionAnswer, reasoningSummary, scannerFrame, stripAnsi, titlecase, toolRow,
  SCANNER_WIDTH, SPINNER_FRAMES,
} from '../tui/transcriptModel.js';

function call(overrides: Partial<ToolCall> & { name: string }): ToolCall {
  return { id: 't1', args: {}, status: 'completed', ...overrides };
}

describe('formatDuration', () => {
  it('picks the unit by magnitude', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(3400)).toBe('3.4s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
    expect(formatDuration(183_600_000)).toBe('2d 3h');
  });
  it('handles edges', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(-5)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('titlecase', () => {
  it('uppercases the first character only', () => {
    expect(titlecase('build')).toBe('Build');
    expect(titlecase('')).toBe('');
    expect(titlecase('a')).toBe('A');
  });
});

describe('collapseToolOutput', () => {
  it('returns unchanged output within both budgets', () => {
    expect(collapseToolOutput('a\nb', 3, 100)).toEqual({ output: 'a\nb', overflow: false });
  });
  it('slices lines and appends an ellipsis line', () => {
    const { output, overflow } = collapseToolOutput('1\n2\n3\n4\n5', 3, 100);
    expect(overflow).toBe(true);
    expect(output).toBe('1\n2\n3\n…');
  });
  it('hard-cuts by code points when the preview still exceeds maxChars', () => {
    const { output, overflow } = collapseToolOutput('x'.repeat(50), 3, 10);
    expect(overflow).toBe(true);
    expect(output).toBe('x'.repeat(9) + '…');
    expect(Array.from(output).length).toBe(10);
  });
  it('counts code points, not UTF-16 units', () => {
    const emoji = '🙂'.repeat(10); // 10 code points, 20 UTF-16 units
    expect(collapseToolOutput(emoji, 3, 10).overflow).toBe(false);
    const cut = collapseToolOutput(emoji, 3, 5);
    expect(cut.overflow).toBe(true);
    expect(Array.from(cut.output).length).toBe(5);
  });
  it('derives the character budget from width with a floor of 20', () => {
    expect(outputBudget(10, 120)).toBe(10 * 114);
    expect(outputBudget(10, 20)).toBe(10 * 20);
  });
});

describe('reasoningSummary', () => {
  it('extracts a bold title followed by a blank line', () => {
    expect(reasoningSummary('**Weighing options**\n\nbody text'))
      .toEqual({ title: 'Weighing options', body: 'body text' });
  });
  it('extracts a title-only summary', () => {
    expect(reasoningSummary('**Just a title**')).toEqual({ title: 'Just a title', body: '' });
  });
  it('leaves untitled content alone', () => {
    expect(reasoningSummary('plain thought')).toEqual({ title: null, body: 'plain thought' });
    expect(reasoningSummary('**inline** not a title')).toEqual({ title: null, body: '**inline** not a title' });
  });
});

describe('inlineArgs', () => {
  it('keeps primitives, drops objects, honors excludes', () => {
    expect(inlineArgs({ path: 'a.ts', offset: 5, deep: { x: 1 }, flag: true }, ['path']))
      .toBe('· offset 5 · flag yes');
    expect(inlineArgs({})).toBe('');
  });
});

describe('extractUnifiedDiff', () => {
  const patch = 'Index: a.ts\n===\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  it('skips the summary line to the patch', () => {
    expect(extractUnifiedDiff(`Updated a.ts (1 replacement)\n${patch}`)).toBe(patch);
  });
  it('accepts a patch with no summary line', () => {
    expect(extractUnifiedDiff(patch)).toBe(patch);
  });
  it('rejects output without hunks', () => {
    expect(extractUnifiedDiff('No changes: the file already has the requested content.')).toBeNull();
    expect(extractUnifiedDiff('Updated a.ts (1 replacement)\n[Diff omitted: change is too large to render quickly.]')).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('[31mred[0m plain')).toBe('red plain');
    expect(stripAnsi('no escapes')).toBe('no escapes');
  });
});

describe('toolRow', () => {
  it('renders bash inline while running and as a block once done', () => {
    const runningRow = toolRow(call({ name: 'bash', status: 'running', args: { command: 'ls -la' } }));
    expect(runningRow.shape).toBe('inline');
    expect(runningRow.icon).toBe('$');
    expect(runningRow.text).toBe('ls -la');

    const doneRow = toolRow(call({ name: 'bash', args: { command: 'ls', cwd: 'src' }, output: '[32mok[0m' }));
    expect(doneRow.shape).toBe('block');
    expect(doneRow.title).toBe('# Running in src');
    expect(doneRow.body).toMatchObject({ kind: 'bash', command: 'ls', output: 'ok' });
  });

  it('omits the bash workdir title for "." and empty cwd', () => {
    expect(toolRow(call({ name: 'bash', args: { command: 'ls', cwd: '.' }, output: '' })).title).toBeUndefined();
    expect(toolRow(call({ name: 'bash', args: { command: 'ls' }, output: '' })).title).toBeUndefined();
  });

  it('renders write_file as a full-content block when complete', () => {
    const row = toolRow(call({ name: 'write_file', args: { path: 'a.ts', content: 'const x = 1;' } }));
    expect(row.shape).toBe('block');
    expect(row.title).toBe('# Wrote a.ts');
    expect(row.body).toEqual({ kind: 'file', path: 'a.ts', content: 'const x = 1;' });
    const pendingRow = toolRow(call({ name: 'write_file', status: 'running', args: { path: 'a.ts' } }));
    expect(pendingRow.shape).toBe('inline');
    expect(pendingRow.pending).toBe('Preparing write…');
  });

  it('renders edit_file as a diff block when the output holds a patch', () => {
    const output = 'Updated a.ts (1 replacement)\nIndex: a.ts\n===\n--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const row = toolRow(call({ name: 'edit_file', args: { path: 'a.ts', replace_all: true }, output }));
    expect(row.shape).toBe('block');
    expect(row.title).toBe('← Edit a.ts');
    expect(row.body?.kind).toBe('diff');
    const noDiff = toolRow(call({ name: 'edit_file', args: { path: 'a.ts' }, output: 'No changes: the file already has the requested content.' }));
    expect(noDiff.shape).toBe('inline');
    expect(noDiff.text).toBe('Edit a.ts');
  });

  it('shows edit_file replace_all in the inline label', () => {
    const row = toolRow(call({ name: 'edit_file', status: 'running', args: { path: 'a.ts', replace_all: true, old_string: 'x', new_string: 'y' } }));
    expect(row.text).toBe('Edit a.ts · replace all yes');
  });

  it('labels search tools with match counts once complete', () => {
    expect(toolRow(call({ name: 'glob', args: { pattern: '*.ts', path: 'src' }, output: 'a.ts\nb.ts' })).text)
      .toBe('Glob "*.ts" in src (2 matches)');
    expect(toolRow(call({ name: 'glob', args: { pattern: '*.ts' }, output: 'a.ts' })).text)
      .toBe('Glob "*.ts" (1 match)');
    expect(toolRow(call({ name: 'grep', args: { pattern: 'todo' }, output: '' })).text)
      .toBe('Grep "todo" (0 matches)');
    expect(toolRow(call({ name: 'grep', status: 'running', args: { pattern: 'todo' } })).text)
      .toBe('Grep "todo"');
  });

  it('labels read/web tools', () => {
    expect(toolRow(call({ name: 'read_file', args: { path: 'a.ts', offset: 10, limit: 50 } })).text)
      .toBe('Read a.ts · offset 10 · limit 50');
    expect(toolRow(call({ name: 'web_fetch', args: { url: 'https://x.dev' } })).text).toBe('WebFetch https://x.dev');
    expect(toolRow(call({ name: 'web_search', args: { query: 'docs' } })).text).toBe('Web Search "docs"');
  });

  it('renders task rows as separated two-liners', () => {
    const running = toolRow(call({ name: 'task', status: 'running', args: { description: 'Scan configs' } }));
    expect(running.icon).toBe('│');
    expect(running.text).toBe('Research Task — Scan configs\n↳ working');
    expect(running.separate).toBe(true);
    const done = toolRow(call({ name: 'task', args: { description: 'Scan configs' }, output: 'found 3' }));
    expect(done.icon).toBe('✓');
    expect(done.text).toBe('Research Task — Scan configs');
  });

  it('renders todo_write as a checklist block', () => {
    const todos = [
      { id: '1', content: 'first', status: 'completed' },
      { id: '2', content: 'second', status: 'in_progress' },
      { id: '3', content: 'third', status: 'pending' },
    ];
    const row = toolRow(call({ name: 'todo_write', args: { todos } }));
    expect(row.shape).toBe('block');
    expect(row.title).toBe('# Todos');
    expect(row.body).toMatchObject({ kind: 'todos' });
    expect((row.body as { todos: unknown[] }).todos).toHaveLength(3);
  });

  it('renders ask_user as a Q/A block once answered', () => {
    const row = toolRow(call({ name: 'ask_user', args: { question: 'Which db?' }, output: '{"answer":"sqlite"}' }));
    expect(row.shape).toBe('block');
    expect(row.title).toBe('# Questions');
    expect(row.body).toEqual({ kind: 'question', question: 'Which db?', answer: 'sqlite' });
    const waiting = toolRow(call({ name: 'ask_user', status: 'running', args: { question: 'Which db?' } }));
    expect(waiting.shape).toBe('inline');
    expect(waiting.text).toBe('Asked 1 question');
  });

  it('falls back to a generic inline row for unknown tools', () => {
    const row = toolRow(call({ name: 'view_image', args: { path: 'x.png', zoom: 2, meta: { a: 1 } } }));
    expect(row.icon).toBe('⚙');
    expect(row.text).toBe('view_image · path x.png · zoom 2');
  });

  it('flags denied and failed statuses', () => {
    const deniedRow = toolRow(call({ name: 'bash', status: 'denied', args: { command: 'rm -rf /' } }));
    expect(deniedRow.denied).toBe(true);
    expect(deniedRow.failed).toBe(false);
    const failedRow = toolRow(call({ name: 'bash', status: 'error', args: { command: 'boom' }, output: 'exit 1' }));
    expect(failedRow.failed).toBe(true);
    expect(failedRow.error).toBe('exit 1');
  });
});

describe('questionAnswer', () => {
  it('unpacks JSON answers and falls back to plain text', () => {
    expect(questionAnswer('{"answer":"sqlite"}')).toBe('sqlite');
    expect(questionAnswer('{"answers":["a","b"]}')).toBe('a, b');
    expect(questionAnswer('plain reply')).toBe('plain reply');
    expect(questionAnswer('')).toBe('(no answer)');
  });
});

describe('filetypeOf', () => {
  it('maps extensions and ignores unknown ones', () => {
    expect(filetypeOf('src/app.tsx')).toBe('tsx');
    expect(filetypeOf('main.py')).toBe('python');
    expect(filetypeOf('README')).toBeUndefined();
    expect(filetypeOf('weird.xyz')).toBeUndefined();
  });
});

describe('scannerFrame', () => {
  it('keeps a stable width and one visible segment through every frame', () => {
    for (let tick = 0; tick < SCANNER_WIDTH * 2; tick++) {
      const frame = scannerFrame(tick);
      expect(frame.length).toBe(SCANNER_WIDTH);
      expect(Array.from(frame).filter(glyph => glyph === '━')).toHaveLength(1);
    }
  });
  it('exposes ten braille spinner frames', () => {
    expect(SPINNER_FRAMES).toHaveLength(10);
    expect(new Set(SPINNER_FRAMES).size).toBe(10);
  });
});
