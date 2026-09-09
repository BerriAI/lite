/** Interactive terminal client for Lite: streamed responses, tool activity,
 * permission and question prompts, slash commands, and session management —
 * all against the local HTTP API. Launched by `lite tui`; state comes from the
 * same event reducer the web client uses. */
import { emitKeypressEvents, type Key } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Message, Model, PermissionRequest, QuestionRequest, Session, SessionDetail } from '../shared/types.js';
import { applyEvent } from '../shared/events.js';
import { LiteClient, ApiError } from './client.js';
import { parseSlash, terminalText, summarizeArgs, clip } from './protocol.js';
import { Screen, paint, composerView } from './render.js';

interface Options { url: string; workspace: string; sessionId?: string; model?: string; providerId?: string; mode?: 'build' | 'plan'; permissionMode?: 'ask' | 'auto' }
function parseOptions(): Options {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  return { url: (value('--url') ?? process.env.LITE_URL ?? `http://localhost:${process.env.LITE_PORT || 3210}`).replace(/\/+$/, ''),
    workspace: value('--workspace') ?? process.cwd(),
    sessionId: value('--session'), model: value('--model'), providerId: value('--provider'),
    mode: args.includes('--plan') ? 'plan' : args.includes('--build') ? 'build' : undefined,
    permissionMode: args.includes('--auto') ? 'auto' : undefined };
}

const HELP = `Slash commands:
  /help                 This list
  /new [title]          Start a new session in this directory
  /sessions             Pick a session to resume (arrows + enter, type to filter)
  /resume <id>          Resume a session by ID
  /fork                 Fork the current session
  /model                Pick a model for this session (idle only)
  /provider <id> [model]  Switch provider (idle only)
  /plan  /build         Switch mode (idle only)
  /ask  /auto           Switch permission mode (idle only)
  /steer <text>         Steer the ACTIVE response between steps
  /queue <text>         Queue a follow-up for after the current response
  /pause  /resume-queue Pause or resume the follow-up queue
  /undo  /redo          Undo or redo the last completed turn
  /compact              Compact the conversation (idle only)
  /title <text>         Rename the session
  /goal <text> | clear  Set or clear a session goal
  /export               Write this session to a JSON file here
  /commands             List workspace commands (.lite/commands)
  /quit                 Exit (the server keeps running)
Keys: Enter send (queues while busy) · Esc cancel the run · Ctrl+C clear/cancel, twice to exit · Ctrl+D exit`;

type Mode =
  | { kind: 'composer' }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'question-text'; request: QuestionRequest }
  | { kind: 'picker'; title: string; items: { label: string; value: string }[]; filter: string; selected: number; onPick: (value: string) => void };

class Tui {
  private client: LiteClient;
  private screen = new Screen();
  private detail: SessionDetail | null = null;
  private mode: Mode = { kind: 'composer' };
  private composer = { text: '', cursor: 0 };
  private history: string[] = []; private historyIndex = -1; private stash = '';
  private pendingLines: string[] = [];
  private flushIndex = 0; private flushOffset = 0;
  private printedTools = new Set<string>();
  private notice = ''; private connection = '';
  private stream: AbortController | null = null;
  private repaintQueued = false;
  private spinner = 0; private spinnerTimer: NodeJS.Timeout | null = null;
  private lastInterrupt = 0;
  private commands: { name: string; description: string; content: string }[] = [];

  constructor(private options: Options) { this.client = new LiteClient(options.url); }

  async start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('lite tui needs an interactive terminal. Use lite run "prompt" for scripted use.\n');
      process.exitCode = 1; return;
    }
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('keypress', (text: string | undefined, key: Key) => { try { this.onKey(text, key); } catch (error) { this.note(this.describe(error)); this.repaint(); } });
    process.stdout.on('resize', () => this.repaint());
    process.on('SIGTERM', () => this.exit(143));
    const target = this.options.sessionId ?? await this.createSession();
    if (target) await this.open(target);
    else this.exit(1);
  }

  private describe(error: unknown) { return error instanceof Error ? terminalText(error.message) : 'Something went wrong.'; }
  private note(text: string) { this.notice = text; }
  private print(text: string) { for (const line of terminalText(text, true).split('\n')) this.pendingLines.push(line); }

  private async createSession(): Promise<string | null> {
    try {
      const body: Record<string, unknown> = { workspace: this.options.workspace, permissionMode: this.options.permissionMode ?? 'ask', mode: this.options.mode ?? 'build' };
      if (this.options.model) body.model = this.options.model;
      if (this.options.providerId) body.providerId = this.options.providerId;
      const session = await this.client.api<Session>('/sessions', body);
      return session.id;
    } catch (error) {
      const hint = error instanceof Error && /fetch failed|ECONNREFUSED/i.test(String((error as { cause?: { code?: string } }).cause?.code ?? error.message))
        ? 'Could not reach the Lite server. Start it with lite serve first.' : this.describe(error);
      process.stderr.write(`${hint}\n`); return null;
    }
  }

  private async open(sessionId: string) {
    this.stream?.abort();
    try {
      const snapshot = await this.client.api<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
      this.detail = snapshot;
      this.flushIndex = Math.max(0, snapshot.messages.length - 12); this.flushOffset = 0;
      this.printedTools = new Set(snapshot.messages.flatMap(message => (message.toolCalls ?? []).map(tool => tool.id)));
      const session = snapshot.session;
      this.print('');
      this.print(`── ${session.title || 'Session'} · ${session.id} ──`);
      this.print(`   ${session.providerId}/${session.model} · ${session.mode} · permissions ${session.permissionMode} · ${session.workspace}`);
      if (this.flushIndex > 0) this.print(`   (${this.flushIndex} earlier ${this.flushIndex === 1 ? 'message' : 'messages'} not shown)`);
      this.mode = { kind: 'composer' };
      this.syncPrompts();
      void this.loadCommands(session.workspace);
      void this.eventLoop(sessionId);
      this.repaint();
    } catch (error) {
      this.note(this.describe(error)); this.repaint();
    }
  }

  private async loadCommands(workspace: string) {
    try { this.commands = (await this.client.api<{ commands: { name: string; description: string; content: string }[] }>(`/commands?workspace=${encodeURIComponent(workspace)}`)).commands ?? []; }
    catch { this.commands = []; }
  }

  private async eventLoop(sessionId: string) {
    const controller = new AbortController();
    this.stream = controller;
    let delay = 1000;
    while (!controller.signal.aborted && this.detail?.session.id === sessionId) {
      try {
        this.connection = '';
        for await (const event of this.client.events(sessionId, this.detail?.lastEventId, controller.signal)) {
          if (controller.signal.aborted || this.detail?.session.id !== sessionId) return;
          if (event.sessionId !== sessionId) continue;
          this.detail = applyEvent(this.detail!, event);
          if (event.type === 'error' && typeof event.data?.message === 'string') this.note(paint.red(terminalText(event.data.message)));
          this.syncPrompts();
          this.repaint();
          delay = 1000;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted || this.detail?.session.id !== sessionId) return;
      this.connection = `reconnecting (${Math.round(delay / 1000)}s)…`;
      this.repaint();
      await new Promise(done => setTimeout(done, delay));
      delay = Math.min(delay * 2, 15000);
      try {
        const snapshot = await this.client.api<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
        if ((snapshot.lastEventId ?? 0) > (this.detail?.lastEventId ?? 0)) { this.detail = snapshot; this.syncPrompts(); }
      } catch { /* Stay on the last known state and retry the stream. */ }
    }
  }

  /** Enter/exit modal prompts based on server state, without stealing a picker. */
  private syncPrompts() {
    if (!this.detail || this.mode.kind === 'picker') return;
    const permission = this.detail.permissions[0];
    const question = (this.detail.questions ?? [])[0];
    if (permission) { if (this.mode.kind !== 'permission' || this.mode.request.id !== permission.id) this.mode = { kind: 'permission', request: permission }; return; }
    if (question) {
      if (this.mode.kind === 'question-text' && this.mode.request.id === question.id) return;
      if (this.mode.kind !== 'question' || this.mode.request.id !== question.id) this.mode = { kind: 'question', request: question };
      return;
    }
    if (this.mode.kind === 'permission' || this.mode.kind === 'question' || this.mode.kind === 'question-text') this.mode = { kind: 'composer' };
  }

  // ── transcript flushing ──────────────────────────────────────────────────
  private running() { const status = this.detail?.session.status; return status === 'running' || status === 'waiting'; }

  private flushTranscript() {
    const detail = this.detail; if (!detail) return;
    const messages = detail.messages;
    for (const message of messages) for (const tool of message.toolCalls ?? []) {
      if (this.printedTools.has(tool.id) || tool.status === 'pending' || tool.status === 'running') continue;
      this.printedTools.add(tool.id);
      const glyph = tool.status === 'completed' ? paint.green('✓') : tool.status === 'denied' ? paint.yellow('⊘') : paint.red('✗');
      this.pendingLines.push(`${glyph} ${paint.bold(terminalText(tool.name))} ${paint.dim(summarizeArgs(tool.args))}`);
      if (tool.status === 'error' && tool.output) this.pendingLines.push(`  ${paint.red(clip(terminalText(tool.output.split('\n')[0]), 200))}`);
    }
    while (this.flushIndex < messages.length) {
      const message = messages[this.flushIndex];
      const last = this.flushIndex === messages.length - 1;
      if (message.role === 'assistant' && last && this.running()) {
        // Stream: print complete lines into the scrollback, keep the last
        // (possibly growing) line on the volatile tail.
        const content = message.content ?? '';
        const end = content.lastIndexOf('\n');
        if (end + 1 > this.flushOffset) { this.print(content.slice(this.flushOffset, end)); this.flushOffset = end + 1; }
        return;
      }
      if (this.flushOffset > 0 && message.role === 'assistant') {
        // The turn ended mid-stream: only the unflushed remainder is new.
        const remainder = (message.content ?? '').slice(this.flushOffset);
        if (remainder) this.print(remainder);
        if (message.error) this.print(paint.red(`Error: ${message.error}`));
      } else {
        const body = this.formatMessage(message);
        if (body !== null) this.print(body);
        else { this.flushIndex++; this.flushOffset = 0; continue; }
      }
      this.print('');
      this.flushIndex++; this.flushOffset = 0;
    }
  }
  private formatMessage(message: Message): string | null {
    if (message.role === 'user') return `${paint.cyan('❯')} ${message.content}`;
    if (message.role === 'assistant') {
      const parts = [message.content?.trim() ? message.content : '', message.error ? paint.red(`Error: ${message.error}`) : ''].filter(Boolean);
      return parts.length ? parts.join('\n') : null;
    }
    if (message.role === 'system') return paint.dim(message.content);
    return null; // Tool outputs surface through their tool-call lines.
  }

  // ── rendering ────────────────────────────────────────────────────────────
  private repaint() {
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    setImmediate(() => { this.repaintQueued = false; this.draw(); });
  }

  private draw() {
    this.flushTranscript();
    const volatile: string[] = [];
    let cursorColumn = 0;
    const detail = this.detail;
    if (detail) {
      const lastMessage = detail.messages.at(-1);
      if (this.running() && lastMessage?.role === 'assistant') {
        for (const tool of lastMessage.toolCalls ?? []) {
          if (tool.status === 'running' || tool.status === 'pending') volatile.push(`${paint.magenta('⚙')} ${terminalText(tool.name)} ${paint.dim(summarizeArgs(tool.args))}`);
        }
        const tail = (lastMessage.content ?? '').slice(this.flushOffset);
        if (tail) volatile.push(terminalText(tail.split('\n').at(-1) ?? ''));
        else if (lastMessage.reasoning && !lastMessage.content) volatile.push(paint.dim(`✳ thinking… (${lastMessage.reasoning.length} chars)`));
      }
      volatile.push(...this.modalRows());
      volatile.push(this.statusRow());
    }
    if (this.notice) volatile.push(paint.yellow(this.notice));
    const composerActive = this.mode.kind === 'composer' || this.mode.kind === 'question-text';
    if (composerActive) {
      const prompt = this.mode.kind === 'question-text' ? paint.magenta('answer❯ ') : paint.cyan('❯ ');
      const promptWidth = this.mode.kind === 'question-text' ? 8 : 2;
      const { view, column } = composerView(this.composer.text, this.composer.cursor, this.screen.columns - promptWidth - 1);
      volatile.push(prompt + terminalText(view));
      cursorColumn = promptWidth + column;
      this.screen.paint(this.pendingLines, volatile, cursorColumn);
    } else this.screen.paint(this.pendingLines, volatile.length ? volatile : [''], 0);
    this.pendingLines = [];
    this.spin();
  }

  private modalRows(): string[] {
    if (this.mode.kind === 'permission') {
      const request = this.mode.request;
      return [
        `${paint.yellow('⚠ permission')} ${paint.bold(terminalText(request.tool))} ${paint.dim(summarizeArgs(request.args, 160))}`,
        `  ${terminalText(clip(request.description, 200))}`,
        `  ${paint.green('[1] allow once')}  ${paint.cyan('[2] always allow')}  ${paint.red('[3] deny')}`,
      ];
    }
    if (this.mode.kind === 'question' || this.mode.kind === 'question-text') {
      const request = this.mode.request;
      const rows = [`${paint.magenta('? ')}${terminalText(clip(request.question, 300))}`];
      request.options.forEach((option, index) => rows.push(`  ${paint.cyan(`[${index + 1}]`)} ${terminalText(option.label)}${option.description ? paint.dim(` — ${terminalText(clip(option.description, 120))}`) : ''}`));
      rows.push(this.mode.kind === 'question-text' ? paint.dim('  type your answer below, Enter to send, Esc for options') : paint.dim('  press a number, or [0] to type a custom answer'));
      return rows;
    }
    if (this.mode.kind === 'picker') {
      const items = this.pickerItems();
      const rows = [`${paint.cyan('◆')} ${this.mode.title}${this.mode.filter ? paint.dim(`  filter: ${terminalText(this.mode.filter)}`) : ''}`];
      const selected = this.mode.selected;
      items.slice(0, 10).forEach((item, index) => rows.push(`${index === selected ? paint.cyan('▸ ') : '  '}${terminalText(item.label)}`));
      if (!items.length) rows.push(paint.dim('  no matches'));
      rows.push(paint.dim('  ↑↓ move · Enter select · Esc cancel · type to filter'));
      return rows;
    }
    return [];
  }

  private pickerItems() {
    if (this.mode.kind !== 'picker') return [];
    const filter = this.mode.filter.toLowerCase();
    return this.mode.items.filter(item => item.label.toLowerCase().includes(filter));
  }

  private statusRow(): string {
    const detail = this.detail; if (!detail) return '';
    const session = detail.session;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const state = session.status === 'running' ? paint.green(`${frames[this.spinner % frames.length]} running · esc to cancel`)
      : session.status === 'waiting' ? paint.yellow('… waiting for you')
      : session.status === 'error' ? paint.red('● error') : paint.dim('● idle');
    const todos = detail.todos.length ? ` · todos ${detail.todos.filter(todo => todo.status === 'completed').length}/${detail.todos.length}` : '';
    const queue = detail.queue?.items.length ? ` · queued ${detail.queue.items.length}${detail.queue.paused ? ' (paused)' : ''}` : '';
    const connection = this.connection ? ` · ${paint.yellow(this.connection)}` : '';
    return paint.dim(`${terminalText(clip(session.title || 'Session', 30))} · ${terminalText(session.providerId)}/${terminalText(session.model)} · ${session.mode} · ${session.permissionMode} · `) + state + paint.dim(`${todos}${queue}${connection}`);
  }

  private spin() {
    const active = this.detail?.session.status === 'running';
    if (active && !this.spinnerTimer) this.spinnerTimer = setInterval(() => { this.spinner++; this.repaint(); }, 120);
    if (!active && this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = null; }
  }

  // ── input ────────────────────────────────────────────────────────────────
  private onKey(text: string | undefined, key: Key) {
    this.notice = '';
    if (key.ctrl && key.name === 'c') return this.onInterrupt();
    if (key.ctrl && key.name === 'd' && !this.composer.text) return this.exit(0);
    switch (this.mode.kind) {
      case 'permission': return this.onPermissionKey(key);
      case 'question': return this.onQuestionKey(key);
      case 'picker': return this.onPickerKey(text, key);
      default: return this.onComposerKey(text, key);
    }
  }

  private onInterrupt() {
    const now = Date.now();
    if (now - this.lastInterrupt < 1500) return this.exit(130);
    this.lastInterrupt = now;
    if (this.mode.kind === 'picker' || this.mode.kind === 'question-text') { this.mode = { kind: 'composer' }; this.syncPrompts(); }
    else if (this.composer.text) { this.composer = { text: '', cursor: 0 }; this.historyIndex = -1; }
    else if (this.running()) void this.cancelRun();
    this.note(paint.dim('press ctrl+c again to exit'));
    this.repaint();
  }

  private onPermissionKey(key: Key) {
    if (this.mode.kind !== 'permission') return;
    const pressed = key.sequence ?? key.name ?? '';
    const decision = pressed === '1' || pressed === 'y' ? 'allow' : pressed === '2' || pressed === 'a' ? 'always' : pressed === '3' || pressed === 'n' || pressed === 'd' ? 'deny' : null;
    if (!decision) { if (key.name === 'escape') this.note('a decision is required — 1 allow · 2 always · 3 deny'); this.repaint(); return; }
    const request = this.mode.request;
    void this.call(async () => {
      await this.client.api(`/sessions/${encodeURIComponent(request.sessionId)}/permissions/${encodeURIComponent(request.id)}`, { decision });
      this.print(paint.dim(`permission ${decision}: ${terminalText(request.tool)}`));
    });
  }

  private onQuestionKey(key: Key) {
    if (this.mode.kind !== 'question') return;
    const request = this.mode.request;
    const digit = key.sequence && /^[0-9]$/.test(key.sequence) ? Number(key.sequence) : null;
    if (digit === 0) { this.mode = { kind: 'question-text', request }; this.composer = { text: '', cursor: 0 }; this.repaint(); return; }
    if (digit && digit <= request.options.length) {
      const option = request.options[digit - 1];
      void this.call(async () => {
        await this.client.api(`/sessions/${encodeURIComponent(request.sessionId)}/questions/${encodeURIComponent(request.id)}/answer`, { kind: 'option', optionId: option.id });
        this.print(paint.dim(`answered: ${terminalText(option.label)}`));
      });
      return;
    }
    this.repaint();
  }

  private onPickerKey(text: string | undefined, key: Key) {
    if (this.mode.kind !== 'picker') return;
    const items = this.pickerItems();
    if (key.name === 'escape') { this.mode = { kind: 'composer' }; this.syncPrompts(); }
    else if (key.name === 'up') this.mode.selected = Math.max(0, this.mode.selected - 1);
    else if (key.name === 'down') this.mode.selected = Math.min(Math.max(0, Math.min(items.length, 10) - 1), this.mode.selected + 1);
    else if (key.name === 'return') {
      const pick = items[this.mode.selected];
      const onPick = this.mode.onPick;
      this.mode = { kind: 'composer' };
      if (pick) onPick(pick.value);
    }
    else if (key.name === 'backspace') { this.mode.filter = this.mode.filter.slice(0, -1); this.mode.selected = 0; }
    else if (text && !key.ctrl && !key.meta && text >= ' ') { this.mode.filter += text; this.mode.selected = 0; }
    this.repaint();
  }

  private onComposerKey(text: string | undefined, key: Key) {
    const c = this.composer;
    if (key.name === 'return') return this.submit();
    if (key.name === 'escape') {
      if (this.mode.kind === 'question-text') { this.mode = { kind: 'composer' }; this.syncPrompts(); this.composer = { text: '', cursor: 0 }; }
      else if (this.running()) void this.cancelRun();
      return this.repaint();
    }
    if (key.name === 'backspace') { if (c.cursor > 0) { c.text = c.text.slice(0, c.cursor - 1) + c.text.slice(c.cursor); c.cursor--; } }
    else if (key.name === 'delete') { c.text = c.text.slice(0, c.cursor) + c.text.slice(c.cursor + 1); }
    else if (key.name === 'left') c.cursor = Math.max(0, c.cursor - 1);
    else if (key.name === 'right') c.cursor = Math.min(c.text.length, c.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) c.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) c.cursor = c.text.length;
    else if (key.ctrl && key.name === 'u') { c.text = c.text.slice(c.cursor); c.cursor = 0; }
    else if (key.ctrl && key.name === 'k') { c.text = c.text.slice(0, c.cursor); }
    else if (key.ctrl && key.name === 'w') {
      const head = c.text.slice(0, c.cursor).replace(/\S+\s*$/, '');
      c.text = head + c.text.slice(c.cursor); c.cursor = head.length;
    }
    else if (key.name === 'up' && this.mode.kind === 'composer') this.recall(-1);
    else if (key.name === 'down' && this.mode.kind === 'composer') this.recall(1);
    else if (text && !key.ctrl && !key.meta) {
      const clean = text.replace(/\r\n?/g, '\n');
      c.text = c.text.slice(0, c.cursor) + clean + c.text.slice(c.cursor);
      c.cursor += clean.length;
    }
    this.repaint();
  }

  private recall(step: number) {
    if (!this.history.length) return;
    if (this.historyIndex === -1) { if (step > 0) return; this.stash = this.composer.text; this.historyIndex = this.history.length; }
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + step));
    const text = this.historyIndex === this.history.length ? this.stash : this.history[this.historyIndex];
    if (this.historyIndex === this.history.length) this.historyIndex = -1;
    this.composer = { text, cursor: text.length };
  }

  // ── submission and commands ──────────────────────────────────────────────
  private submit() {
    const input = this.composer.text.trim();
    if (!input) return this.repaint();
    this.composer = { text: '', cursor: 0 }; this.historyIndex = -1;
    if (this.history.at(-1) !== input) this.history.push(input);
    if (this.mode.kind === 'question-text') {
      const request = this.mode.request;
      void this.call(async () => {
        await this.client.api(`/sessions/${encodeURIComponent(request.sessionId)}/questions/${encodeURIComponent(request.id)}/answer`, { kind: 'text', text: input });
        this.print(paint.dim(`answered: ${terminalText(clip(input, 120))}`));
        this.mode = { kind: 'composer' }; this.syncPrompts();
      });
      return;
    }
    const slash = parseSlash(input);
    if (slash) return void this.runSlash(slash.name, slash.args);
    void this.send(input);
  }

  private path(rest = '') { return `/sessions/${encodeURIComponent(this.detail!.session.id)}${rest}`; }

  private async send(content: string) {
    await this.call(async () => {
      try { await this.client.api(this.path('/messages'), { content }); }
      catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await this.client.api(this.path('/queue'), { content });
          this.note(paint.dim('queued — runs after the current response (use /steer to redirect it now)'));
        } else throw error;
      }
    });
  }

  private async cancelRun() {
    await this.call(async () => { await this.client.api(this.path('/cancel'), {}); this.note(paint.dim('cancelling…')); });
  }

  private async call(work: () => Promise<void>) {
    try { await work(); } catch (error) { this.note(this.describe(error)); }
    this.repaint();
  }

  private async runSlash(name: string, args: string) {
    const detail = this.detail; if (!detail) return;
    const patch = (body: Record<string, unknown>) => this.call(async () => {
      const session = await this.client.api<Session>(this.path(), body, 'PATCH');
      this.detail = { ...this.detail!, session: { ...this.detail!.session, ...session } };
    });
    switch (name) {
      case 'help': this.print(paint.dim(HELP)); break;
      case 'quit': case 'exit': return this.exit(0);
      case 'plan': return void patch({ mode: 'plan' });
      case 'build': return void patch({ mode: 'build' });
      case 'ask': return void patch({ permissionMode: 'ask' });
      case 'auto': return void patch({ permissionMode: 'auto' });
      case 'title': if (!args) this.note('usage: /title <text>'); else return void patch({ title: clip(args, 200) }); break;
      case 'provider': {
        const [providerId, model] = args.split(/\s+/).filter(Boolean);
        if (!providerId) this.note('usage: /provider <id> [model]');
        else return void patch({ providerId, ...(model ? { model } : {}) });
        break;
      }
      case 'model': return void this.pickModel(args);
      case 'new': return void this.call(async () => {
        const session = await this.client.api<Session>('/sessions', { workspace: this.options.workspace, mode: 'build', permissionMode: detail.session.permissionMode, providerId: detail.session.providerId, model: detail.session.model, ...(args ? { title: clip(args, 200) } : {}) });
        await this.open(session.id);
      });
      case 'sessions': return void this.pickSession();
      case 'resume': if (!args) this.note('usage: /resume <session-id>'); else return void this.open(args); break;
      case 'fork': return void this.call(async () => {
        const forked = await this.client.api<Session>(this.path('/fork'), {});
        this.print(paint.dim(`forked → ${forked.id}`));
        await this.open(forked.id);
      });
      case 'steer': if (!args) this.note('usage: /steer <text>'); else return void this.call(async () => { await this.client.api(this.path('/steer'), { content: args }); this.note(paint.dim('steering note delivered to the active response')); }); break;
      case 'queue': if (!args) this.note('usage: /queue <text>'); else return void this.call(async () => { await this.client.api(this.path('/queue'), { content: args }); }); break;
      case 'pause': return void this.call(async () => { await this.client.api(this.path('/queue/pause'), {}); });
      case 'resume-queue': return void this.call(async () => { await this.client.api(this.path('/queue/resume'), {}); });
      case 'undo': case 'redo': {
        const history = detail.history;
        const id = name === 'undo' ? history?.undoId : history?.redoId;
        if (!id) { this.note(history?.unavailableReason ? terminalText(history.unavailableReason) : `nothing to ${name}`); break; }
        return void this.call(async () => { await this.client.api(this.path(`/history/${name}`), { checkpointId: id }); this.print(paint.dim(`${name} applied`)); });
      }
      case 'compact': return void this.call(async () => { await this.client.api(this.path('/compact'), {}); this.print(paint.dim('conversation compacted')); });
      case 'cancel': return void this.cancelRun();
      case 'goal':
        if (args === 'clear') return void this.call(async () => { await this.client.api(this.path('/goal'), undefined, 'DELETE'); this.print(paint.dim('goal cleared')); });
        if (!args) this.note('usage: /goal <text> | /goal clear');
        else return void this.call(async () => { await this.client.api(this.path('/goal'), { text: args }); this.print(paint.dim('goal set')); });
        break;
      case 'export': return void this.call(async () => {
        const data = await this.client.api<unknown>(this.path('/export'));
        const file = resolve(this.options.workspace, `lite-session-${detail.session.id}.json`);
        await writeFile(file, JSON.stringify(data, null, 2));
        this.print(paint.dim(`exported → ${file}`));
      });
      case 'commands':
        if (!this.commands.length) this.print(paint.dim('No workspace commands. Add markdown files under .lite/commands/.'));
        else for (const command of this.commands) this.print(paint.dim(`/${command.name} — ${clip(command.description || '', 100)}`));
        break;
      default: {
        const command = this.commands.find(entry => entry.name === name);
        if (command) return void this.send(args ? `${command.content}\n\n${args}` : command.content);
        this.note(`unknown command: /${name} — try /help`);
      }
    }
    this.repaint();
  }

  private async pickModel(inline: string) {
    const detail = this.detail!;
    if (inline) return void this.call(async () => {
      const session = await this.client.api<Session>(this.path(), { model: inline }, 'PATCH');
      this.detail = { ...this.detail!, session: { ...this.detail!.session, ...session } };
    });
    await this.call(async () => {
      const { models, error } = await this.client.api<{ models: Model[]; error?: string }>(`/models?providerId=${encodeURIComponent(detail.session.providerId)}`);
      if (error) this.note(terminalText(error));
      if (!models.length) { this.note(this.notice || 'no models reported — set one with /model <id>'); return; }
      this.mode = { kind: 'picker', title: `model (${detail.session.providerId})`, filter: '', selected: 0,
        items: models.map(model => ({ label: `${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ''}`, value: model.id })),
        onPick: value => void this.call(async () => {
          const session = await this.client.api<Session>(this.path(), { model: value }, 'PATCH');
          this.detail = { ...this.detail!, session: { ...this.detail!.session, ...session } };
        }) };
    });
  }

  private async pickSession() {
    await this.call(async () => {
      const { sessions } = await this.client.api<{ sessions: Session[] }>('/sessions');
      if (!sessions.length) { this.note('no sessions yet'); return; }
      const age = (updated: number) => {
        const minutes = Math.max(0, Math.round((Date.now() - updated) / 60000));
        return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
      };
      this.mode = { kind: 'picker', title: 'sessions', filter: '', selected: 0,
        items: sessions.slice(0, 100).map(session => ({ label: `${clip(terminalText(session.title || 'Untitled'), 48)} · ${session.providerId}/${clip(terminalText(session.model), 24)} · ${age(session.updatedAt)} · ${session.id.slice(0, 8)}`, value: session.id })),
        onPick: id => void this.open(id) };
    });
  }

  private exit(code: number): never {
    this.stream?.abort();
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.screen.release();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\n');
    process.exit(code);
  }
}

new Tui(parseOptions()).start().catch(error => {
  process.stderr.write(`${error instanceof Error ? terminalText(error.message) : 'Lite TUI failed to start.'}\n`);
  process.exit(1);
});
