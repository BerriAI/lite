/** @jsxImportSource @opentui/react */
/** Themed transcript: user chassis with a heavy left rail, markdown assistant
 * text, reasoning rows, inline and block tool renderers, error boxes, and the
 * turn footer. All derivation lives in transcriptModel.ts; this file only maps
 * row models onto renderer elements. */
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { SyntaxStyle, MacOSScrollAccel, type ScrollBoxRenderable } from '@opentui/core';
import type { Message, PermissionRequest, SessionDetail, ToolCall, Usage } from '../shared/types.js';
import { selectedForeground, toHex, type Theme } from './theme.js';
import { subtleSyntaxRules, syntaxRules } from './syntax.js';
import {
  collapseToolOutput, filetypeOf, formatDuration,
  outputBudget, scannerFrame, TODO_MARKERS, parseTodos, type ToolRowModel,
  SCANNER_INTERVAL_MS, SPINNER_FRAMES, SPINNER_INTERVAL_MS,
} from './transcriptModel.js';
import { activityActors, activitySections, conversationGroups, usageLabel, type ActivityEntry } from './conversation.js';
import { Button } from './ui.js';
import { terminalText } from './protocol.js';
import { toolRow, reasoningSummary } from './transcriptModel.js';
import { useConfig, useTheme } from './context.js';
import type { TerminalController } from './controller.js';
import { Brand } from './brand.js';
import { WorkerCard } from './workerCard.js';
import { verificationSummary, withoutVerificationNotice } from '../shared/verification.js';

/** Heavy left rail used by user messages, block tools, and error boxes. */
export const RAIL_BORDER = {
  topLeft: '┃', topRight: '┃', bottomLeft: '┃', bottomRight: '┃',
  horizontal: ' ', vertical: '┃', topT: '┃', bottomT: '┃', leftT: '┃', rightT: '┃', cross: '┃',
};

export interface TranscriptSettings {
  showThinking: boolean;
  toolDetails: boolean;
  animations: boolean;
  timestamps: boolean;
  genericToolOutput: boolean;
}

export const DEFAULT_TRANSCRIPT_SETTINGS: TranscriptSettings = {
  showThinking: false,
  toolDetails: false,
  animations: true,
  timestamps: false,
  genericToolOutput: false,
};

const SettingsContext = createContext<TranscriptSettings>(DEFAULT_TRANSCRIPT_SETTINGS);
export const TranscriptSettingsProvider = SettingsContext.Provider;
export function useTranscriptSettings(): TranscriptSettings {
  return useContext(SettingsContext);
}

function useSyntax(theme: Theme): { normal: SyntaxStyle; subtle: SyntaxStyle } {
  const styles = useMemo(() => ({ normal: SyntaxStyle.fromTheme(syntaxRules(theme)), subtle: SyntaxStyle.fromTheme(subtleSyntaxRules(theme)) }), [theme]);
  useEffect(() => () => { styles.normal.destroy(); styles.subtle.destroy(); }, [styles]);
  return styles;
}

export function Spinner({ color, children }: { color: string; children: string }) {
  const { animations } = useTranscriptSettings();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!animations) return;
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animations]);
  const glyph = animations ? SPINNER_FRAMES[frame] : '⋯';
  return <text fg={color}>{`${glyph} ${children}`}</text>;
}

/** One quiet pulse travels along a short rail. */
export function WorkingScanner({ color }: { color: string }) {
  const { animations } = useTranscriptSettings();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!animations) return;
    const timer = setInterval(() => setTick(t => t + 1), SCANNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animations]);
  return <text fg={color}>{animations ? scannerFrame(tick) : '━─── '}</text>;
}

function UserRow({ message, first }: { message: Message; first: boolean }) {
  const theme = useTheme();
  const { timestamps } = useTranscriptSettings();
  const chips = (message.attachments ?? []).map((attachment, index) => {
    const isDir = attachment.mimeType === 'inode/directory';
    return (
      <box key={`${attachment.name}-${index}`} flexDirection="row" height={1}>
        <text fg={toHex(theme.background)} bg={toHex(theme.secondary)}>{isDir ? ' Directory ' : ' File '}</text>
        <text fg={toHex(theme.textMuted)} bg={toHex(theme.backgroundElement)}>{` ${attachment.name} `}</text>
      </box>
    );
  });
  return (
    <box
      marginTop={first ? 0 : 1}
      border={['left']}
      customBorderChars={RAIL_BORDER}
      borderColor={toHex(theme.primary)}
      flexShrink={0}
    >
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={toHex(theme.backgroundPanel)} flexDirection="column">
        {message.content.trim() ? <text fg={toHex(theme.text)} wrapMode="word">{terminalText(message.content.trim(), true)}</text> : null}
        {chips.length ? <box flexDirection="row" gap={1} marginTop={message.content.trim() ? 1 : 0}>{chips}</box> : null}
        {timestamps ? <text fg={toHex(theme.textMuted)}>{new Date(message.createdAt).toLocaleTimeString()}</text> : null}
      </box>
    </box>
  );
}

function ReasoningRow({ row }: { row: { running: boolean; title: string | null; body: string }; subtle: SyntaxStyle }) {
  const theme = useTheme(), settings = useTranscriptSettings(), [expanded, setExpanded] = useState(false);
  const text = terminalText([row.title, row.body].filter(Boolean).join('\n'), true);
  const preview = collapseToolOutput(text, 3, 240);
  if (row.running) return <box paddingLeft={3} flexShrink={0}><text fg={toHex(theme.textMuted)}><em>Thinking…</em></text></box>;
  return <box paddingLeft={3} flexShrink={0} flexDirection="column">
    <text fg={toHex(theme.textMuted)} wrapMode="word"><em>{expanded || settings.showThinking ? text : preview.output}</em></text>
    {preview.overflow && <Button onPress={() => setExpanded(value => !value)}>{expanded ? 'Less reasoning' : 'Full reasoning'}</Button>}
  </box>;
}

const TextRow = memo(function TextRow({ text, syntax, compact = false }: { text: string; syntax: SyntaxStyle; compact?: boolean }) {
  const theme = useTheme();
  return (
    <box paddingLeft={3} marginTop={compact ? 0 : 1} flexShrink={0}>
      <markdown
        syntaxStyle={syntax}
        streaming
        conceal
        content={text}
        fg={toHex(theme.markdownText)}
        bg={toHex(theme.background)}
      />
    </box>
  );
});

const DENIED_MARK = '⊘ ';

function InlineToolRow({ row, awaitingPermission, margin }: {
  row: ToolRowModel;
  awaitingPermission: boolean;
  margin: 0 | 1;
}) {
  const theme = useTheme();
  const [showError, setShowError] = useState(false);
  const color = awaitingPermission ? theme.warning
    : row.failed ? theme.error
      : row.denied || row.completed ? theme.textMuted
        : theme.text;
  if (row.running && !row.text) {
    return (
      <box paddingLeft={3} marginTop={margin} flexShrink={0}>
        <text fg={toHex(theme.textMuted)}>{`~ ${row.pending}`}</text>
      </box>
    );
  }
  const prefix = row.denied ? DENIED_MARK : `${row.icon} `;
  return (
    <box paddingLeft={3} marginTop={margin} flexShrink={0} flexDirection="column">
      {row.running
        ? <Spinner color={toHex(theme.text)}>{row.text}</Spinner>
        : (
          <text
            fg={toHex(color)}
            wrapMode="word"
            onMouseDown={row.failed ? () => setShowError(open => !open) : undefined}
          >
            {`${prefix}${row.denied ? `${row.text} (denied)` : row.text}`}
          </text>
        )}
      {row.failed && showError && row.error ? (
        <box paddingLeft={2}>
          <text fg={toHex(theme.error)} wrapMode="word">{row.error}</text>
        </box>
      ) : null}
    </box>
  );
}

function BlockBody({ row, syntax, width }: { row: ToolRowModel; syntax: SyntaxStyle; width: number }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { genericToolOutput } = useTranscriptSettings();
  const config = useConfig();
  const body = row.body;
  if (!body) return null;
  switch (body.kind) {
    case 'bash': {
      const budget = outputBudget(10, width);
      const collapsed = collapseToolOutput(body.output, 10, budget);
      const shown = expanded ? body.output : collapsed.output;
      return (
        <box flexDirection="column" gap={1}>
          <text fg={toHex(theme.text)} wrapMode="word">{`$ ${body.command}`}</text>
          {shown ? (
            <text
              fg={toHex(theme.textMuted)}
              wrapMode="word"
              onMouseDown={collapsed.overflow ? () => setExpanded(open => !open) : undefined}
            >
              {shown}
            </text>
          ) : null}
          {collapsed.overflow ? (
            <text fg={toHex(theme.textMuted)} onMouseDown={() => setExpanded(open => !open)}>
              {expanded ? 'Click to collapse' : 'Click to expand'}
            </text>
          ) : null}
        </box>
      );
    }
    case 'file':
      return (
        <line-number fg={toHex(theme.diffLineNumber)} paddingRight={1}>
          <code
            content={body.content}
            filetype={filetypeOf(body.path)}
            syntaxStyle={syntax}
            drawUnstyledText
          />
        </line-number>
      );
    case 'diff':
      return (
        <diff
          diff={body.diff}
          view={width > 120 ? 'split' : 'unified'}
          filetype={filetypeOf(body.path)}
          syntaxStyle={syntax}
          showLineNumbers
          addedBg={toHex(theme.diffAddedBg)}
          removedBg={toHex(theme.diffRemovedBg)}
          contextBg={toHex(theme.diffContextBg)}
          addedSignColor={toHex(theme.diffAdded)}
          removedSignColor={toHex(theme.diffRemoved)}
          lineNumberFg={toHex(theme.diffLineNumber)}
          addedLineNumberBg={toHex(theme.diffAddedLineNumberBg)}
          removedLineNumberBg={toHex(theme.diffRemovedLineNumberBg)}
          wrapMode="word"
        />
      );
    case 'todos':
      return (
        <box flexDirection="column">
          {body.todos.map((todo, index) => (
            <text key={todo.id ?? index} fg={toHex(todo.status === 'in_progress' ? theme.warning : theme.textMuted)}>
              {`${TODO_MARKERS[todo.status] ?? '○'} ${todo.content}`}
            </text>
          ))}
        </box>
      );
    case 'question':
      return (
        <box flexDirection="column" gap={1}>
          <text fg={toHex(theme.textMuted)} wrapMode="word">{body.question}</text>
          <text fg={toHex(theme.text)} wrapMode="word">{body.answer}</text>
        </box>
      );
    case 'generic': {
      const budget = outputBudget(3, width);
      const collapsed = collapseToolOutput(body.output, 3, budget);
      return <text fg={toHex(theme.textMuted)} wrapMode="word">{genericToolOutput ? body.output : collapsed.output}</text>;
    }
  }
}

function BlockToolRow({ row, syntax, width }: { row: ToolRowModel; syntax: SyntaxStyle; width: number }) {
  const theme = useTheme();
  return (
    <box
      marginTop={1}
      border={['left']}
      customBorderChars={RAIL_BORDER}
      borderColor={toHex(theme.background)}
      flexShrink={0}
    >
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={toHex(theme.backgroundPanel)} flexDirection="column" gap={1}>
        {row.title ? (
          row.running
            ? <Spinner color={toHex(theme.textMuted)}>{row.title.replace(/^# /, '')}</Spinner>
            : <text fg={toHex(theme.textMuted)} wrapMode="word">{row.title}</text>
        ) : null}
        <BlockBody row={row} syntax={syntax} width={width} />
        {row.failed && row.error ? <text fg={toHex(theme.error)} wrapMode="word">{row.error}</text> : null}
      </box>
    </box>
  );
}

function ErrorRow({ error }: { error: string }) {
  const theme = useTheme();
  return (
    <box marginTop={1} border={['left']} customBorderChars={RAIL_BORDER} borderColor={toHex(theme.error)} flexShrink={0}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={toHex(theme.backgroundPanel)}>
        <text fg={toHex(theme.textMuted)} wrapMode="word">{error}</text>
      </box>
    </box>
  );
}

function ToolActivity({ call, showDetails, awaitingPermission, syntax, width, embedded }: { call: ToolCall; showDetails: boolean; awaitingPermission: boolean; syntax: SyntaxStyle; width: number; embedded: boolean }) {
  const theme = useTheme(), [expanded, setExpanded] = useState(false), [fullOutput, setFullOutput] = useState(false);
  const open = expanded || showDetails, row = toolRow(call);
  const output = terminalText(call.output ?? (call.status === 'pending' ? 'Waiting to start…' : call.status === 'running' ? 'Running…' : 'No output.'), true);
  const preview = collapseToolOutput(output, 10, outputBudget(10, width - 8));
  const result = <box flexDirection="column" flexShrink={0}><text fg={toHex(row.failed || row.denied ? theme.error : theme.textMuted)} wrapMode="word"><em>{fullOutput ? output : preview.output}</em></text>{preview.overflow && <Button onPress={() => setFullOutput(value => !value)}>{fullOutput ? 'Less output' : 'Full output'}</Button>}</box>;
  if (call.name === 'todo_write') {
    const todos = parseTodos(call.args.todos);
    return <box paddingLeft={3} flexDirection="column" flexShrink={0}>
      <text fg={toHex(theme.textMuted)}>{row.failed ? 'Task update failed' : row.denied ? 'Task update declined' : row.completed ? 'Tasks updated' : 'Update tasks'}</text>
      {todos.map(todo => <text key={todo.id ?? todo.content} fg={toHex(todo.status === 'in_progress' ? theme.primary : theme.textMuted)} wrapMode="word">{`${TODO_MARKERS[todo.status] ?? '○'} ${terminalText(todo.content)}`}</text>)}
      {row.error && <text fg={toHex(theme.error)} wrapMode="word">{terminalText(row.error, true)}</text>}
    </box>;
  }
  if(call.shunt||call.routing||call.name==='bulk_read'||call.name==='code_write')return <box flexDirection="column" flexShrink={0}>
    <InlineToolRow row={row} awaitingPermission={awaitingPermission} margin={0}/>
    {call.output && <box paddingLeft={4} flexShrink={0}>{result}</box>}
  </box>;
  return <box flexDirection="column" flexShrink={0}>
    <box onMouseDown={() => setExpanded(!expanded)} flexDirection="row"><text fg={toHex(theme.textMuted)}>{open ? '▾' : '▸'}</text><InlineToolRow row={row} awaitingPermission={awaitingPermission} margin={0} /></box>
    {call.waitingForWorkspace && <text fg={toHex(theme.textMuted)} wrapMode="word"><em>{terminalText(call.waitingForWorkspace)}</em></text>}
    {open && <box paddingLeft={4} flexDirection="column" flexShrink={0}>
      {call.intercepted && <text fg={toHex(theme.warning)}>{`Modified by ${terminalText(call.intercepted.by)}: ${terminalText(call.intercepted.reason)}`}</text>}
      {row.shape === 'block' ? <BlockToolRow row={row} syntax={syntax} width={width - 8} /> : result}
    </box>}
  </box>;
}

function DriverActivity({ entries, detail, live, heading, syntax, width, embedded }: { entries: ActivityEntry[]; detail: SessionDetail; live: boolean; heading: boolean; syntax: ReturnType<typeof useSyntax>; width: number; embedded: boolean }) {
  const theme = useTheme(), settings = useTranscriptSettings(), [expanded, setExpanded] = useState(false);
  const calls = entries.flatMap(entry => entry.call ? [entry.call] : []);
  const issues = calls.filter(call => call.status === 'error' || call.status === 'denied').length;
  const open = live || expanded || settings.toolDetails || settings.showThinking;
  return <box marginTop={1} flexDirection="column" flexShrink={0}>
    {heading && <text paddingLeft={3} fg={toHex(theme.textMuted)}>Driver</text>}
    {!live && <Button onPress={() => setExpanded(!expanded)}>{`${open ? '▾' : '▸'} ${calls.length ? `${calls.length} ${calls.length === 1 ? 'step' : 'steps'}` : 'Thought process'}${issues ? ` · ${issues} issues` : ''}`}</Button>}
    {open && entries.map(({ message, call }) => call
      ? <ToolActivity key={call.id} syntax={syntax.normal} width={width} call={call} showDetails={settings.toolDetails} awaitingPermission={detail.permissions.some(item => item.toolCallId === call.id && !item.invocationId)} embedded={embedded} />
      : <ReasoningRow key={message.id} subtle={syntax.subtle} row={{ running: live && !message.content && !message.toolCalls?.length, ...reasoningSummary(message.reasoning!) }} />)}
  </box>;
}

function WorkLog({ steps, detail, actors, live, syntax, width, controller, embedded }: { controller?: TerminalController; steps: Message[]; detail: SessionDetail; actors: ReturnType<typeof activityActors>; live: boolean; syntax: ReturnType<typeof useSyntax>; width: number; embedded: boolean }) {
  const settings = useTranscriptSettings();
  const sections = activitySections(steps, actors);
  const firstHasHeading = Boolean(steps[0]?.content.trim() || steps[0]?.reasoning);
  return <>{sections.map((section, index) => section.kind === 'worker' && controller
    ? <WorkerCard key={section.id} task={section.task} call={section.call} label={section.label} controller={controller} width={width - 6} defaultOpen={live || settings.toolDetails || settings.showThinking} needsApproval={detail.permissions.some(item => item.toolCallId === section.call.id)} renderTranscript={(child, childWidth) => <Transcript detail={child} width={childWidth} active={false} embedded />} />
    : <DriverActivity key={section.id} entries={section.kind === 'driver' ? section.entries : [{ message: section.message, call: section.call }]} detail={detail} live={live && index === sections.length - 1} heading={!embedded && Boolean(detail.session.architecture) && (index > 0 || !firstHasHeading)} syntax={syntax} width={width} embedded={embedded} />)}</>;
}

function VerificationRow({ receipts }: { receipts: NonNullable<Message['receipts']> }) {
  const theme = useTheme(), [open, setOpen] = useState(false);
  const summary = verificationSummary(receipts);
  if (!summary) return null;
  const unresolved = receipts.unresolvedChecks ?? receipts.checksFailed;
  const commands = unresolved.length ? unresolved : receipts.checksRun;
  return <box paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
    <Button onPress={() => setOpen(!open)}><span fg={toHex(summary.attention ? theme.warning : theme.textMuted)}>{`${open ? '▾' : '▸'} ${summary.title}`}</span></Button>
    {open && <box paddingLeft={2} flexDirection="column" flexShrink={0}>
      <text fg={toHex(theme.textMuted)} wrapMode="word">{summary.description}</text>
      {receipts.filesChangedAfterLastCheck.length > 0 && <text fg={toHex(theme.textMuted)} wrapMode="word">{terminalText(`Edited after checks: ${receipts.filesChangedAfterLastCheck.join(', ')}`)}</text>}
      {commands.map((command, index) => <text key={index} marginTop={1} fg={toHex(theme.textMuted)} wrapMode="word">{terminalText(command, true)}</text>)}
      {receipts.filesChanged.length > 0 && <text marginTop={1} fg={toHex(theme.textMuted)} wrapMode="word">{terminalText(`Files changed: ${receipts.filesChanged.join(', ')}`)}</text>}
    </box>}
  </box>;
}

export const Transcript = memo(function Transcript({ detail, width, active = true, embedded = false, onInspect, onUsage, controller }: { detail: SessionDetail; width: number; controller?: TerminalController; active?: boolean; embedded?: boolean; onInspect?: (steps: Message[]) => void; onUsage?: (message: Message, usage?: Usage) => void }) {
  const theme = useTheme(), config = useConfig(), syntax = useSyntax(theme), scroll = useRef<ScrollBoxRenderable>(null);
  const acceleration = useMemo(() => { const native = new MacOSScrollAccel(); return { tick: () => (config.scroll_acceleration.enabled ? native.tick() : 1) * config.scroll_speed, reset: () => native.reset() }; }, [config.scroll_speed, config.scroll_acceleration.enabled]);
  const [limit, setLimit] = useState(120), [following, setFollowing] = useState(true);
  const follow = (value: boolean) => { if (scroll.current) scroll.current.stickyScroll = value; setFollowing(value); };
  const latest = () => { follow(true); scroll.current?.scrollTo(Infinity); };
  const resumeAtBottom = () => { const view = scroll.current; if (view && view.scrollTop + view.viewport.height >= view.scrollHeight - 1) follow(true); };
  const groups = useMemo(() => conversationGroups(detail), [detail.messages, detail.session.status]);
  const actors = useMemo(() => activityActors(detail), [detail.messages, detail.delegations, detail.session.id, detail.session.architecture]);
  const visible = groups.slice(-limit);
  useEffect(() => { setLimit(120); latest(); }, [detail.session.id]);
  useKeyboard(key => {
    if (!active || key.defaultPrevented) return;
    const amount = key.name === 'pageup' ? -1 : key.name === 'pagedown' ? 1 : 0;
    if (amount) { key.preventDefault(); key.stopPropagation(); if (amount < 0) follow(false); scroll.current?.scrollBy(amount, 'viewport'); if (amount > 0) resumeAtBottom(); }
    if (key.ctrl && key.name === 'home') { key.preventDefault(); key.stopPropagation(); follow(false); setLimit(count => count + 120); scroll.current?.scrollTo(0); }
    if ((key.ctrl && key.name === 'end') || (key.ctrl && key.name === 'g')) { key.preventDefault(); key.stopPropagation(); latest(); }
  });
  const contents = <>
    {groups.length > limit && <Button onPress={() => setLimit(count => count + 120)}>Load earlier messages</Button>}
    {!groups.length && <box flexGrow={1} marginTop={2} paddingLeft={2} flexDirection="column"><Brand /><text marginTop={1} fg={toHex(theme.text)}><strong>A fresh start.</strong></text><text fg={toHex(theme.textMuted)}>Give Litespeed a task in this workspace.</text><text fg={toHex(theme.textMuted)}>{terminalText(detail.session.workspace)}</text></box>}
    {visible.map(({ message, startsRun, steps, live, footer, runUsage }, index) => {
      if (message.role === 'user') return embedded ? null : <UserRow key={message.id} message={message} first={index === 0} />;
      if (message.role === 'system') return <box key={message.id} marginTop={1} paddingLeft={2} flexShrink={0}><text fg={toHex(theme.textMuted)}>{terminalText(message.content, true)}</text></box>;
      const usageMessage = steps.findLast(step => step.turnUsage) ?? steps.at(-1) ?? message;
      const content = withoutVerificationNotice(message.content, message.receipts);
      return <box key={message.id} flexDirection="column" flexShrink={0}>
        {(message.content.trim() || message.reasoning) && detail.session.architecture && controller && <text paddingLeft={3} marginTop={1} fg={toHex(theme.textMuted)}>Driver</text>}
        {message.reasoning && <ReasoningRow subtle={syntax.subtle} row={{ running: live && !message.content && !message.toolCalls?.length, ...reasoningSummary(message.reasoning) }} />}
        {content.trim() && <TextRow compact={Boolean(detail.session.architecture)} text={terminalText(content, true)} syntax={syntax.normal} />}
        <WorkLog steps={steps} detail={detail} actors={actors} live={live} syntax={syntax} width={width} controller={controller} embedded={embedded} />
        {message.error && <ErrorRow error={terminalText(message.error, true)} />}
        {message.receipts && <VerificationRow receipts={message.receipts} />}
        {footer && (runUsage || message.context) && <box marginTop={1} paddingLeft={2} flexShrink={0}><Button onPress={() => onUsage?.(usageMessage, runUsage)}>{usageLabel(usageMessage, runUsage)}</Button></box>}
      </box>;
    })}
  </>;
  if (embedded) return <box flexDirection="column" flexShrink={0}>{contents}</box>;
  return <box width={width} flexGrow={1} minHeight={1} flexDirection="column"><scrollbox ref={scroll} onMouseScroll={event => { if (event.scroll?.direction === 'up') follow(false); else if (event.scroll?.direction === 'down') queueMicrotask(resumeAtBottom); }} scrollAcceleration={acceleration} flexGrow={1} minHeight={1} stickyScroll={following} stickyStart="bottom" viewportCulling paddingLeft={width < 90 ? 1 : 2} paddingRight={width < 90 ? 1 : 2} paddingBottom={1}>{contents}</scrollbox>{!following && <Button onPress={latest}>↓ Latest · Ctrl+G</Button>}</box>;
});

/** Right-aligned interrupt affordance: `esc interrupt`, escalating after the
 * first press. */
export function InterruptHint({ pressed }: { pressed: boolean }) {
  const theme = useTheme();
  return (
    <text fg={toHex(theme.primary)}>{pressed ? 'esc again to interrupt' : 'esc interrupt'}</text>
  );
}
