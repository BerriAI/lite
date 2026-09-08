import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, RunEvent, Session, SessionDetail } from '../shared/types';
import type { QuestionAnswer, QuestionRequest } from '../shared/questions';

const cli = fileURLToPath(new URL('../bin/lite.mjs', import.meta.url));
const fixtureEntry = fileURLToPath(new URL('./fixtures/cli-server.ts', import.meta.url));
const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
const fixtureSecret = 'CLI_FIXTURE_KEY_DO_NOT_PRINT';
interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface Process { child: ChildProcessWithoutNullStreams; result: Promise<Result>; stdout: () => string; stderr: () => string }

async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for the spawned CLI.');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

// Never inherit NODE_OPTIONS, .env contents, provider keys, HOME, or an existing LITE_URL.
function environment(workspace: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(workspace, 'home'),
    TMPDIR: workspace, TMP: workspace, TEMP: workspace, LANG: 'en_US.UTF-8',
    NO_COLOR: '1', NODE_NO_WARNINGS: '1', ...extra,
  };
}

function start(args: string[], cwd: string, env: NodeJS.ProcessEnv): Process {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = new Promise<Result>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result, stdout: () => stdout, stderr: () => stderr };
}

function sessionId(result: Result) {
  const match = result.stderr.match(/Session: ([\w-]+)/);
  expect(match, result.stderr).not.toBeNull();
  return match![1];
}
function events(result: Result): RunEvent[] {
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('spawned lite executable against a real local provider', () => {
  let workspace: string, base: string, fixture: Process;
  const children = new Set<Process>();
  const terminals = new Set<{ pty: IPty; exited: () => boolean; result: Promise<Result> }>();
  beforeEach(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-cli-')));
    await mkdir(join(workspace, 'home'));
    // A real user .env must never influence this boundary harness or spawned commands.
    await writeFile(join(workspace, '.env'), 'LITE_URL=http://invalid.invalid\nOPENAI_API_KEY=DOTENV_SENTINEL_DO_NOT_LOAD\n');
    fixture = start(['--import', loader, fixtureEntry], workspace, environment(workspace, { CLI_TEST_WORKSPACE: workspace }));
    await until(() => {
      if (fixture.child.exitCode !== null) throw new Error(`CLI fixture exited: ${fixture.stderr()}`);
      return fixture.stdout().includes('\n');
    });
    base = JSON.parse(fixture.stdout().split('\n')[0]).base;
  });
  afterEach(async () => {
    for (const proc of children) {
      if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
      await proc.result.catch(() => {});
    }
    children.clear();
    for (const terminal of terminals) {
      if (!terminal.exited()) terminal.pty.kill('SIGKILL');
      await terminal.result.catch(() => {});
    }
    terminals.clear();
    if (fixture) {
      fixture.child.kill('SIGTERM');
      const timer = setTimeout(() => fixture.child.kill('SIGKILL'), 4000);
      await fixture.result.catch(() => {}); clearTimeout(timer);
    }
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  function launch(args: string[], extraEnv: Record<string, string> = {}, explicitUrl = true) {
    const proc = start([cli, ...args, ...(explicitUrl ? ['--url', base] : [])], workspace, environment(workspace, extraEnv));
    children.add(proc); proc.child.stdin.end(); return proc;
  }
  function launchTerminal(args: string[]) {
    const output = join(workspace, `pty-output-${terminals.size}.jsonl`);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    // stdin/stderr remain a real PTY; only stdout is redirected to prove JSONL purity.
    const command = `exec ${[process.execPath, cli, ...args, '--url', base].map(quote).join(' ')} > ${quote(output)}`;
    const pty = spawnPty('/bin/sh', ['-c', command], { cwd: workspace, env: environment(workspace), cols: 160, rows: 40, name: 'xterm' });
    let stderr = '', exited = false;
    pty.onData(data => { stderr += data; });
    const result = new Promise<Result>((resolve, reject) => {
      pty.onExit(({ exitCode }) => {
        exited = true;
        void readFile(output, 'utf8').then(stdout => resolve({ code: exitCode, signal: null, stdout, stderr }), reject);
      });
    });
    const terminal = { pty, exited: () => exited, result, stderr: () => stderr };
    terminals.add(terminal); return terminal;
  }
  async function pendingQuestion(): Promise<QuestionRequest> {
    let question: QuestionRequest | undefined;
    await until(async () => {
      const list = await api<{ sessions: Session[] }>('/sessions');
      if (!list.sessions.length) return false;
      const state = await api<SessionDetail & { questions?: QuestionRequest[] }>(`/sessions/${list.sessions[0].id}`);
      question = state.questions?.[0]; return Boolean(question);
    });
    return question!;
  }
  async function submittedAnswers(): Promise<{ path: string; body: QuestionAnswer }[]> {
    return (await (await fetch(`${base}/fixture/requests`)).json()).answers;
  }
  async function run(args: string[], extraEnv: Record<string, string> = {}, explicitUrl = true) {
    const result = await launch(args, extraEnv, explicitUrl).result;
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(fixtureSecret);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('DOTENV_SENTINEL_DO_NOT_LOAD');
    return result;
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true); return response.json();
  }
  async function requests(): Promise<{ model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[]> {
    return (await (await fetch(`${base}/fixture/requests`)).json()).requests;
  }

  it.each(['help', '--help', '-h'])('prints %s without connecting or creating a session', async command => {
    const result = await run([command], { LITE_URL: 'http://127.0.0.1:1' }, false);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    for (const usage of ['lite run', 'lite sessions', 'lite models', 'lite export', '--auto', 'not a sandbox']) expect(result.stdout).toContain(usage);
    expect((await api<{ sessions: Session[] }>('/sessions')).sessions).toEqual([]);
    expect(await requests()).toEqual([]);
  });

  it('lists discovered models with explicit provider and LITE_URL configuration', async () => {
    const models = await run(['models']);
    expect(models.code).toBe(0); expect(models.stderr).toBe('');
    expect(models.stdout.trim().split('\n').sort()).toEqual(['cli-alternate  (fixture)', 'cli-default  (fixture)']);
    const alternate = await run(['models', '--provider', 'alternate'], { LITE_URL: base }, false);
    expect(alternate.code).toBe(0);
    expect(alternate.stdout.trim().split('\n').sort()).toEqual(['cli-alternate  (alternate)', 'cli-default  (alternate)']);
    const override = await run(['models'], { LITE_URL: 'http://127.0.0.1:1' });
    expect(override.code).toBe(0); expect(override.stdout).toContain('(fixture)');
  });

  it('lists only recent sessions and uses the API-saved title and status', async () => {
    expect((await run(['sessions'])).stdout).toBe('');
    const session = await api<Session>('/sessions', { title: 'CLI-visible session' });
    const archived = await api<Session>('/sessions', { title: 'Hidden archive' });
    const response = await fetch(`${base}/api/sessions/${archived.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    expect(response.ok).toBe(true);
    const result = await run(['sessions']);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${session.id}  idle      CLI-visible session\n`);
    expect(result.stdout).not.toContain(archived.id);
  });

  it('streams Unicode text once, reports the session on stderr, and persists cwd/model options', async () => {
    const result = await run(['run', 'CLI hello', '--provider', 'alternate', '--model', 'cli-alternate']);
    expect(result.code).toBe(0); expect(result.signal).toBeNull();
    expect(result.stdout).toBe('Reply: CLI hello — café ready.\n\n');
    expect(result.stderr).toMatch(/^\nSession: [\w-]+\n$/);
    const detail = await api<SessionDetail>(`/sessions/${sessionId(result)}`);
    expect(detail.session).toMatchObject({ status: 'idle', workspace, model: 'cli-alternate', providerId: 'alternate', permissionMode: 'ask', mode: 'build' });
    expect(detail.messages.map(m => [m.role, m.content])).toEqual([['user', 'CLI hello'], ['assistant', 'Reply: CLI hello — café ready.\n']]);
    expect((await requests())[0].model).toBe('cli-alternate');
  });

  it('prints parseable JSONL events with ordered cursors and no mixed human text', async () => {
    const result = await run(['run', 'JSON hello', '--json']);
    expect(result.code).toBe(0);
    const output = events(result), id = sessionId(result);
    expect(output.length).toBeGreaterThan(5);
    expect(output.every(event => event.sessionId === id)).toBe(true);
    expect(output.map(event => event.id)).toEqual([...output.map(event => event.id)].sort((a, b) => a! - b!));
    expect(new Set(output.map(event => event.id)).size).toBe(output.length);
    expect(output.filter(event => event.type === 'delta').map(event => event.data.delta).join('')).toBe('Reply: JSON hello — café ready.\n');
    expect(output.filter(event => event.type === 'reasoning').map(event => event.data.delta).join('')).toBe('Checking the CLI request.');
    expect(output.at(-1)).toMatchObject({ type: 'done', data: { status: 'idle' } });
    expect(result.stderr).toMatch(/^\nSession: [\w-]+\n$/);
  });

  it('continues the selected session rather than creating a second conversation', async () => {
    const first = await run(['run', 'First CLI turn']);
    const id = sessionId(first);
    const second = await run(['run', 'Second CLI turn', '--session', id, '--json']);
    expect(second.code).toBe(0); expect(sessionId(second)).toBe(id);
    expect((await api<{ sessions: Session[] }>('/sessions')).sessions).toHaveLength(1);
    const detail = await api<SessionDetail>(`/sessions/${id}`);
    expect(detail.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['First CLI turn', 'Second CLI turn']);
    const calls = await requests();
    expect(calls).toHaveLength(2);
    expect(calls[1].messages.some(m => m.role === 'assistant' && m.content === 'Reply: First CLI turn — café ready.\n')).toBe(true);
  });

  it.each([
    { prior: 'success', json: false }, { prior: 'success', json: true },
    { prior: 'error', json: false }, { prior: 'error', json: true },
  ])('ignores prior $prior events emitted between subscribing and accepting the new turn (JSON=$json)', async ({ prior, json }) => {
    const session = await api<Session>('/sessions', { title: 'CLI race boundary' });
    const arm = await fetch(`${base}/fixture/race/${session.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: `race-prior-${prior}` }),
    });
    expect(arm.ok).toBe(true);
    await api(`/sessions/${session.id}/messages`, { content: `race-prior-${prior}` });
    await until(async () => (await (await fetch(`${base}/fixture/race/${session.id}`)).json()).ready);
    const result = await run(['run', 'Only this CLI response', '--session', session.id, ...(json ? ['--json'] : [])]);
    const state = await (await fetch(`${base}/fixture/race/${session.id}`)).json();
    expect(state.phases).toEqual(['subscribed', 'post-received', 'prior-done', 'post-dispatched']);
    expect(result.code).toBe(0); expect(sessionId(result)).toBe(session.id);
    expect(result.stderr).not.toContain('401');
    const detail = await api<SessionDetail>(`/sessions/${session.id}`);
    const accepted = detail.messages.find(message => message.role === 'user' && message.content === 'Only this CLI response');
    expect(accepted).toBeDefined();
    if (json) {
      const output = events(result);
      expect(output[0]).toMatchObject({ type: 'message', data: { id: accepted!.id, role: 'user', content: 'Only this CLI response' } });
      expect(output.filter(event => event.type === 'delta').map(event => event.data.delta).join('')).toBe('Reply: Only this CLI response — café ready.\n');
      expect(output.filter(event => event.type === 'error')).toEqual([]);
      expect(output.filter(event => event.type === 'done')).toHaveLength(1);
      expect(output.at(-1)).toMatchObject({ type: 'done', data: { status: 'idle' } });
    } else expect(result.stdout).toBe('Reply: Only this CLI response — café ready.\n\n');
    expect(detail.session.status).toBe('idle');
    expect(detail.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Reply: Only this CLI response — café ready.\n' });
  });

  it('fails clearly when an older server accepts the prompt without a correlation ID', async () => {
    const session = await api<Session>('/sessions', { title: 'Missing accepted-message ID' });
    const arm = await fetch(`${base}/fixture/missing-message-id/${session.id}`, { method: 'POST' });
    expect(arm.ok).toBe(true);
    const result = await run(['run', 'Accepted by an older server', '--session', session.id, '--json']);
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(sessionId(result)).toBe(session.id);
    expect(result.stderr).toContain('did not return an accepted message ID');
    expect(result.stderr).toContain('Update the server and check the session in Lite before retrying');
    await until(async () => (await api<SessionDetail>(`/sessions/${session.id}`)).session.status === 'idle');
    const detail = await api<SessionDetail>(`/sessions/${session.id}`);
    expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(detail.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Reply: Accepted by an older server — café ready.\n' });
  });

  it('exports valid JSON history without keys or hidden server configuration', async () => {
    const result = await run(['run', 'Export CLI turn']);
    const id = sessionId(result);
    const exported = await run(['export', id]);
    expect(exported.code).toBe(0); expect(exported.stderr).toBe('');
    const data = JSON.parse(exported.stdout);
    expect(data.session.id).toBe(id);
    expect(data.messages.map((message: Message) => message.content)).toEqual(['Export CLI turn', 'Reply: Export CLI turn — café ready.\n']);
    expect(data.todos).toEqual([]);
    expect(Object.keys(data).sort()).toEqual(['messages', 'session', 'todos']);
  });

  it.each([false, true])('denies mutable tools in non-TTY mode without hanging or writing files (JSON=%s)', async json => {
    const result = await run(['run', 'write-fixture ask', ...(json ? ['--json'] : [])]);
    expect(result.code).toBe(0);
    if (json) {
      const output = events(result);
      expect(output.filter(event => event.type === 'permission')).toHaveLength(1);
      expect(output.some(event => event.type === 'permission_resolved' && event.data.decision === 'deny')).toBe(true);
      expect(output.at(-1)).toMatchObject({ type: 'done', data: { status: 'idle' } });
    } else expect(result.stdout).toBe('Tool request finished.\n');
    expect(result.stderr).toContain('Denied write_file: interactive approval required (or explicitly use --auto).');
    const detail = await api<SessionDetail>(`/sessions/${sessionId(result)}`);
    expect(detail.session.status).toBe('idle'); expect(detail.permissions).toEqual([]);
    expect(detail.messages.flatMap(m => m.toolCalls ?? []).map(tool => tool.status)).toEqual(['denied']);
    await expect(readFile(join(workspace, 'cli-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('executes a real file write only after explicit --auto opt-in', async () => {
    const result = await run(['run', 'write-fixture auto', '--auto']);
    expect(result.code).toBe(0); expect(result.stdout).toBe('Tool request finished.\n');
    expect(result.stderr).toContain('write_file'); expect(result.stderr).not.toContain('Denied');
    expect(await readFile(join(workspace, 'cli-output.txt'), 'utf8')).toBe('Written by the CLI fixture.\n');
    const detail = await api<SessionDetail>(`/sessions/${sessionId(result)}`);
    expect(detail.session.permissionMode).toBe('auto');
    expect(detail.messages.flatMap(m => m.toolCalls ?? []).map(tool => tool.status)).toEqual(['completed']);
  });

  it('keeps --plan read-only even with --auto and a provider requesting a write', async () => {
    const result = await run(['run', 'write-fixture plan', '--plan', '--auto', '--json']);
    expect(result.code).toBe(0);
    const detail = await api<SessionDetail>(`/sessions/${sessionId(result)}`);
    expect(detail.session).toMatchObject({ mode: 'plan', permissionMode: 'auto', status: 'idle' });
    const tools = detail.messages.flatMap(m => m.toolCalls ?? []);
    expect(tools).toHaveLength(1);
    expect(['denied', 'error']).toContain(tools[0].status);
    expect(events(result).filter(event => event.type === 'permission')).toEqual([]);
    expect((await requests())[0].tools?.some(tool => tool.function.name === 'write_file')).toBe(false);
    await expect(readFile(join(workspace, 'cli-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { args: ['unknown-command'], message: 'Unknown command' },
    { args: ['run'], message: 'Usage: lite run' },
    { args: ['run', '--json'], message: 'Usage: lite run' },
    { args: ['run', ''], message: 'Usage: lite run' },
    { args: ['export'], message: 'Usage: lite export' },
    { args: ['export', 'missing-session'], message: 'Session not found' },
    { args: ['models', '--provider', 'missing-provider'], message: 'Provider not found' },
    { args: ['run', 'Hello', '--provider', 'missing-provider'], message: 'Provider not found' },
    { args: ['run', 'Hello', '--session', 'missing-session'], message: 'Could not connect to session stream' },
    { args: ['run', 'Hello', '--model'], message: 'requires a value' },
    { args: ['run', 'Hello', '--provider', '--auto'], message: 'requires a value' },
    { args: ['run', 'Hello', '--session'], message: 'requires a value' },
    { args: ['run', 'Hello', '--unknown'], message: 'Unknown option' },
    { args: ['run', 'Hello', 'extra argument'], message: 'Usage: lite run' },
    { args: ['models', '--auto'], message: 'not supported' },
    { args: ['models', '--provider', 'fixture', '--provider', 'alternate'], message: 'Duplicate option' },
    { args: ['models', '--url', 'not-a-url'], message: 'valid HTTP or HTTPS URL' },
    { args: ['models', '--url', 'file:///tmp/test'], message: 'HTTP or HTTPS URL' },
    { args: ['models', '--url', 'https://user:password@localhost'], message: 'without credentials' },
    { args: ['models', '--url', 'http://localhost?key=value'], message: 'without credentials' },
  ])('rejects invalid arguments or unavailable resources: $args', async ({ args, message }) => {
    const result = await run(args, {}, !args.includes('--url'));
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain(message);
    expect(await requests()).toEqual([]);
  });

  it.each([['--plan'], ['--auto'], ['--model', 'cli-alternate'], ['--provider', 'alternate']])('rejects silently ignored session overrides: %s', async (...flags) => {
    const session = await api<Session>('/sessions', { title: 'Existing settings', mode: 'build', permissionMode: 'ask' });
    const result = await run(['run', 'Do not silently ignore my options', '--session', session.id, ...flags]);
    expect(result.code).toBe(1); expect(result.stderr).toContain('cannot be combined with --session');
    expect(await requests()).toEqual([]);
    expect((await api<SessionDetail>(`/sessions/${session.id}`)).messages).toEqual([]);
  });

  it('supports options before a prompt, a trailing URL slash, and -- for literal flag-like prompts', async () => {
    const ordered = await run(['run', '--model', 'cli-alternate', 'Options precede this prompt']);
    expect(ordered.code).toBe(0);
    expect((await api<SessionDetail>(`/sessions/${sessionId(ordered)}`)).session.model).toBe('cli-alternate');
    const literal = await run(['run', '--url', `${base}/`, '--', '--this-is-a-prompt'], {}, false);
    expect(literal.code).toBe(0); expect(literal.stdout).toBe('Reply: --this-is-a-prompt — café ready.\n\n');
  });

  it.each(['0', '-1', '65536', 'abc'])('rejects invalid serve port %s before spawning the server', async port => {
    const result = await run(['serve', '--port', port], {}, false);
    expect(result.code).toBe(1); expect(result.stderr).toContain('--port must be an integer between 1 and 65535.');
    expect(result.stdout).toBe('');
  });

  it('rejects an overlapping CLI run without cancelling the existing stream or leaving an SSE handle open', async () => {
    const active = launch(['run', 'slow-stream existing operation']);
    await until(() => active.stdout().includes('Stream started'));
    const session = (await api<{ sessions: Session[] }>('/sessions')).sessions[0];
    const conflict = await run(['run', 'Must not overlap', '--session', session.id]);
    expect(conflict.code).toBe(1); expect(conflict.stderr).toMatch(/Wait for the current operation|already running|stop the response/i);
    const detail = await api<SessionDetail>(`/sessions/${session.id}`);
    expect(detail.session.status).toBe('running');
    expect(detail.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['slow-stream existing operation']);
    active.child.kill('SIGINT'); await active.result;
    await until(async () => (await api<SessionDetail>(`/sessions/${session.id}`)).session.status === 'idle');
  });

  it('returns an actionable diagnostic when no local server is listening', async () => {
    const port = await new Promise<number>(resolve => {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1', () => {
        const value = (reservation.address() as { port: number }).port;
        reservation.close(() => resolve(value));
      });
    });
    const result = await run(['sessions'], { LITE_URL: `http://127.0.0.1:${port}` }, false);
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Start the local server with lite serve first.');
  });

  it.each([{ json: false, auto: false }, { json: true, auto: false }, { json: false, auto: true }, { json: true, auto: true }])('cancels unanswered non-TTY questions without guessing (JSON=$json, auto=$auto)', async ({ json, auto }) => {
    const result = await run(['run', 'question-fixture noninteractive', ...(json ? ['--json'] : []), ...(auto ? ['--auto'] : [])]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Non-interactive input cannot answer questions, even with --auto');
    expect(result.stderr).toContain('use the Lite app or rerun in an interactive terminal');
    const id = sessionId(result);
    await until(async () => (await api<SessionDetail>(`/sessions/${id}`)).session.status === 'idle');
    const state = await api<SessionDetail & { questions?: QuestionRequest[] }>(`/sessions/${id}`);
    expect(state.questions ?? []).toEqual([]);
    expect(await submittedAnswers()).toEqual([]);
    expect(await requests()).toHaveLength(1);
    if (json) {
      const output = events(result), question = output.find(event => event.type === 'question');
      expect(question?.data.turnId).toBe(output.find(event => event.type === 'message' && event.data.role === 'user')?.data.id);
    } else expect(result.stdout).not.toContain('continued exactly once');
  });

  it.each([
    { input: '2', answer: { kind: 'option', optionId: 'broad' }, suffix: 'numbered' },
    { input: 'Prefer a staged rollout', answer: { kind: 'text', text: 'Prefer a staged rollout' }, suffix: 'custom' },
    { input: 'text: 2', answer: { kind: 'text', text: '2' }, suffix: 'numeric-custom' },
    { input: 'Explain the tradeoffs first', answer: { kind: 'text', text: 'Explain the tradeoffs first' }, suffix: 'freeform' },
  ])('answers a question through an actual PTY with $suffix input and pristine JSON stdout', async ({ input, answer, suffix }) => {
    const terminal = launchTerminal(['run', `question-fixture ${suffix}`, '--json']);
    const question = await pendingQuestion();
    await until(() => terminal.stderr().includes(suffix === 'freeform' ? 'Your answer:' : 'Choose a number,'));
    if (suffix !== 'freeform') {
      expect(terminal.stderr()).toContain('1. Small change'); expect(terminal.stderr()).toContain('2. Broader revision');
      expect(await submittedAnswers()).toEqual([]); // Printing options never preselects an answer.
    }
    terminal.pty.write(`${input}\r`);
    const result = await terminal.result;
    expect(result.code).toBe(0); expect(sessionId(result)).toBe(question.sessionId);
    const output = events(result);
    expect(output.filter(event => event.type === 'delta').map(event => event.data.delta).join('')).toBe('Question answered; continued exactly once.');
    expect(output.at(-1)).toMatchObject({ type: 'done', data: { status: 'idle' } });
    expect(await submittedAnswers()).toEqual([{ path: `/api/sessions/${question.sessionId}/questions/${question.id}/answer`, body: answer }]);
    expect(await requests()).toHaveLength(2);
    expect(result.stdout).not.toContain('Choose a number,');
  });

  it('reprompts invalid or blank PTY input, deduplicates question IDs, ignores stale turns, and escapes model terminal controls', async () => {
    const terminal = launchTerminal(['run', 'question-fixture controls', '--json']);
    const question = await pendingQuestion();
    await until(() => terminal.stderr().includes('Choose a number,'));
    expect(terminal.stderr()).toContain('\\u001b]52;c;SECRETS\\u0007\\u000dspoof\\u202e');
    expect(terminal.stderr()).toContain('Small\\u001b[2J change');
    expect(terminal.stderr()).toContain('Keep\\u009b2J it focused');
    expect(terminal.stderr()).not.toContain('\u001b]52;');
    for (const stale of [false, true]) {
      const response = await fetch(`${base}/fixture/question-event/${question.sessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stale }) });
      expect(response.ok).toBe(true);
    }
    terminal.pty.write('99\r');
    await until(() => terminal.stderr().includes('Choose a listed number'));
    terminal.pty.write('\r');
    await until(() => terminal.stderr().includes('Enter a nonblank answer'));
    expect(await submittedAnswers()).toEqual([]);
    terminal.pty.write('1\r');
    const result = await terminal.result;
    expect(result.code).toBe(0);
    expect(result.stderr.split('Choose a path').length - 1).toBe(1);
    expect(events(result).filter(event => event.type === 'question' && event.data.id === 'stale-question')).toEqual([]);
    expect((await submittedAnswers()).map(answer => answer.body)).toEqual([{ kind: 'option', optionId: 'small' }]);
  });

  it('dismisses pending PTY input on done even when a question resolution event is missing', async () => {
    const session = await api<Session>('/sessions', { title: 'Terminal done dismissal' });
    expect((await fetch(`${base}/fixture/omit-question-resolution/${session.id}`, { method: 'POST' })).ok).toBe(true);
    const terminal = launchTerminal(['run', 'question-fixture missing resolution', '--session', session.id, '--json']);
    const question = await pendingQuestion();
    await until(() => terminal.stderr().includes('Choose a number,'));
    await api(`/sessions/${session.id}/questions/${question.id}/answer`, { kind: 'option', optionId: 'small' });
    const result = await terminal.result;
    expect(result.code).toBe(0);
    expect(events(result).filter(event => event.type === 'question_resolved')).toEqual([]);
    expect(events(result).at(-1)).toMatchObject({ type: 'done' });
    expect(await submittedAnswers()).toHaveLength(1);
    expect(await requests()).toHaveLength(2);
  });

  it('keeps reading SSE while an actual PTY tool approval is resolved by another client', async () => {
    const terminal = launchTerminal(['run', 'write-fixture external approval', '--json']);
    let session: Session, permissionId: string;
    await until(async () => {
      session = (await api<{ sessions: Session[] }>('/sessions')).sessions[0];
      if (!session) return false;
      permissionId = (await api<SessionDetail>(`/sessions/${session.id}`)).permissions[0]?.id;
      return Boolean(permissionId);
    });
    await until(() => terminal.stderr().includes('[y/N]'));
    await api(`/sessions/${session!.id}/permissions/${permissionId!}`, { decision: 'deny' });
    const result = await terminal.result;
    expect(result.code).toBe(0);
    expect(events(result).at(-1)).toMatchObject({ type: 'done' });
    await expect(readFile(join(workspace, 'cli-output.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['answer', 'cancel'])('keeps reading SSE and dismisses PTY input when another client performs %s', async action => {
    const terminal = launchTerminal(['run', 'question-fixture external resolution', '--json']);
    const question = await pendingQuestion();
    await until(() => terminal.stderr().includes('Choose a number,'));
    if (action === 'answer') await api(`/sessions/${question.sessionId}/questions/${question.id}/answer`, { kind: 'text', text: 'Answered in the other tab' });
    else await api(`/sessions/${question.sessionId}/cancel`, {});
    const result = await terminal.result;
    expect(result.code).toBe(action === 'answer' ? 0 : 1);
    expect(events(result).at(-1)).toMatchObject({ type: 'done' });
    expect(events(result).some(event => event.type === 'question_resolved' && event.data.status === (action === 'answer' ? 'answered' : 'cancelled'))).toBe(true);
    expect(await requests()).toHaveLength(action === 'answer' ? 2 : 1);
    expect(await submittedAnswers()).toHaveLength(action === 'answer' ? 1 : 0);
  });

  it.each([{ input: '\u0004', code: 1, label: 'EOF' }, { input: '\u0003', code: 130, label: 'Ctrl-C' }, { input: '', code: 143, label: 'SIGTERM' }])('$label during an actual PTY question cancels remotely without a guessed answer', async ({ input, code, label }) => {
    const terminal = launchTerminal(['run', 'question-fixture interrupted', '--json']);
    const question = await pendingQuestion();
    await until(() => terminal.stderr().includes('Choose a number,'));
    if (label === 'SIGTERM') terminal.pty.kill('SIGTERM'); else terminal.pty.write(input);
    const result = await terminal.result;
    expect(result.code).toBe(code); expect(sessionId(result)).toBe(question.sessionId);
    await until(async () => (await api<SessionDetail>(`/sessions/${question.sessionId}`)).session.status === 'idle');
    expect(await submittedAnswers()).toEqual([]); expect(await requests()).toHaveLength(1);
    if (label === 'EOF') expect(result.stderr).toContain('Input closed before an answer was submitted');
  });

  it.each([false, true])('fails provider errors with nonzero exit status (JSON=%s)', async json => {
    const result = await run(['run', 'provider-error', ...(json ? ['--json'] : [])]);
    expect(result.code).toBe(1);
    const id = sessionId(result);
    const detail = await api<SessionDetail>(`/sessions/${id}`);
    expect(detail.session.status).toBe('error');
    if (json) {
      const output = events(result);
      expect(output.some(event => event.type === 'error' && /401/.test(event.data.message))).toBe(true);
      expect(output.at(-1)).toMatchObject({ type: 'done', data: { status: 'error' } });
    } else { expect(result.stderr).toContain('401'); expect(result.stdout.trim()).toBe(''); }
  });

  it('fails model discovery errors instead of reporting a successful empty model list', async () => {
    const result = await run(['models', '--provider', 'broken']);
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('401');
  });

  it.each([{ signal: 'SIGINT' as const, code: 130 }, { signal: 'SIGTERM' as const, code: 143 }])('$signal cancels the actual remote stream, leaves an idle session, and allows continuation', async ({ signal, code }) => {
    const proc = launch(['run', 'slow-stream cancellation']);
    await until(() => proc.stdout().includes('Stream started'));
    const sessions = (await api<{ sessions: Session[] }>('/sessions')).sessions;
    expect(sessions).toHaveLength(1);
    const id = sessions[0].id;
    expect(sessions[0].status).toBe('running');
    expect(proc.child.kill(signal)).toBe(true);
    const result = await proc.result;
    expect(result.signal).toBeNull();
    expect(result.code).toBe(code);
    expect(sessionId(result)).toBe(id);
    expect(result.stdout).toBe('Stream started'); expect(result.stdout).not.toContain('finished');
    await until(async () => (await api<SessionDetail>(`/sessions/${id}`)).session.status === 'idle');
    const detail = await api<SessionDetail>(`/sessions/${id}`);
    expect(detail.messages.find(m => m.role === 'assistant')?.content).toBe('Stream started');
    expect(detail.permissions).toEqual([]);
    const continuation = await run(['run', 'After cancellation', '--session', id]);
    expect(continuation.code).toBe(0); expect(sessionId(continuation)).toBe(id);
    expect(continuation.stdout).toBe('Reply: After cancellation — café ready.\n\n');
  });
});
