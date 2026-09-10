/** @jsxImportSource @opentui/react */
/** Themed transcript: user chassis with a heavy left rail, markdown assistant
 * text, reasoning rows, inline and block tool renderers, error boxes, and the
 * turn footer. All derivation lives in transcriptModel.ts; this file only maps
 * row models onto renderer elements. */
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import { SyntaxStyle } from '@opentui/core';
import type { Message, PermissionRequest, SessionDetail } from '../shared/types.js';
import { selectedForeground, toHex, type Theme } from './theme.js';
import { subtleSyntaxRules, syntaxRules } from './syntax.js';
import {
  collapseToolOutput, deriveRows, filetypeOf, formatDuration, marginAbove,
  outputBudget, scannerFrame, TODO_MARKERS, type ToolRowModel, type TranscriptRow,
  SCANNER_INTERVAL_MS, SPINNER_FRAMES, SPINNER_INTERVAL_MS,
} from './transcriptModel.js';
import { useTheme } from './app.js';

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
  toolDetails: true,
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
  return useMemo(() => ({
    normal: SyntaxStyle.fromTheme(syntaxRules(theme)),
    subtle: SyntaxStyle.fromTheme(subtleSyntaxRules(theme)),
  }), [theme]);
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

/** Knight-rider style working indicator for the prompt area. */
export function WorkingScanner({ color }: { color: string }) {
  const { animations } = useTranscriptSettings();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!animations) return;
    const timer = setInterval(() => setTick(t => t + 1), SCANNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animations]);
  return <text fg={color}>{animations ? scannerFrame(tick) : '[⋯]'}</text>;
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
        {message.content.trim() ? <text fg={toHex(theme.text)} wrapMode="word">{message.content.trim()}</text> : null}
        {chips.length ? <box flexDirection="row" gap={1} marginTop={message.content.trim() ? 1 : 0}>{chips}</box> : null}
        {timestamps ? <text fg={toHex(theme.textMuted)}>{new Date(message.createdAt).toLocaleTimeString()}</text> : null}
      </box>
    </box>
  );
}

function QueuedRow({ content }: { content: string }) {
  const theme = useTheme();
  return (
    <box marginTop={1} border={['left']} customBorderChars={RAIL_BORDER} borderColor={toHex(theme.primary)} flexShrink={0}>
      <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={toHex(theme.backgroundPanel)} flexDirection="column">
        <box flexDirection="row" height={1}>
          <text fg={toHex(selectedForeground(theme, theme.primary))} bg={toHex(theme.primary)}> QUEUED </text>
        </box>
        <box marginTop={1}>
          <text fg={toHex(theme.text)} wrapMode="word">{content}</text>
        </box>
      </box>
    </box>
  );
}

function ReasoningRow({ row, subtle }: {
  row: Extract<TranscriptRow, { kind: 'reasoning' }>;
  subtle: SyntaxStyle;
}) {
  const theme = useTheme();
  const { showThinking } = useTranscriptSettings();
  const fg = toHex({ ...theme.warning, a: Math.round(theme.thinkingOpacity * 255) });
  const label = row.title ? `Thinking: ${row.title}` : 'Thinking';
  const doneLabel = row.title ? `Thought: ${row.title}` : 'Thought';
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
      {row.running
        ? <Spinner color={fg}>{label}</Spinner>
        : <text fg={fg}>{`${showThinking && row.body ? '- ' : row.body ? '+ ' : ''}${doneLabel}`}</text>}
      {showThinking && row.body ? (
        <box marginTop={1}>
          <code
            filetype="markdown"
            drawUnstyledText={false}
            streaming
            syntaxStyle={subtle}
            content={row.body}
            fg={toHex(theme.textMuted)}
          />
        </box>
      ) : null}
    </box>
  );
}

function TextRow({ text, syntax }: { text: string; syntax: SyntaxStyle }) {
  const theme = useTheme();
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
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
}

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
              {`${TODO_MARKERS[todo.status] ?? '[ ]'} ${todo.content}`}
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
      return <text fg={toHex(theme.textMuted)} wrapMode="word">{collapsed.output}</text>;
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

function FooterRow({ row }: { row: Extract<TranscriptRow, { kind: 'footer' }> }) {
  const theme = useTheme();
  const marker = row.interrupted ? theme.textMuted : theme.primary;
  const parts = [row.mode];
  if (row.model) parts.push(row.model);
  if (row.duration) parts.push(row.duration);
  if (row.interrupted) parts.push('interrupted');
  return (
    <box paddingLeft={3} marginTop={1} flexDirection="row" flexShrink={0} height={1}>
      <text fg={toHex(marker)}>{'▣ '}</text>
      <text fg={toHex(theme.text)}>{parts[0]}</text>
      <text fg={toHex(theme.textMuted)}>{parts.slice(1).map(part => ` · ${part}`).join('')}</text>
    </box>
  );
}

function rowKey(row: TranscriptRow, index: number): string {
  switch (row.kind) {
    case 'tool': return `${row.message.id}:${row.row.call.id}`;
    case 'queued': return `queued:${index}`;
    default: return `${row.message.id}:${row.kind}:${index}`;
  }
}

export const Transcript = memo(function Transcript({ detail, width }: { detail: SessionDetail; width: number }) {
  const theme = useTheme();
  const { toolDetails } = useTranscriptSettings();
  const syntax = useSyntax(theme);
  const rows = deriveRows(detail);
  const visible = rows.filter(row =>
    row.kind !== 'tool' || toolDetails || !row.row.completed);
  const awaiting = new Set(detail.permissions.map((permission: PermissionRequest) => permission.toolCallId));
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box height={1} />
      {visible.map((row, index) => {
        const margin = marginAbove(visible, index);
        const key = rowKey(row, index);
        switch (row.kind) {
          case 'user':
            return <UserRow key={key} message={row.message} first={index === 0} />;
          case 'reasoning':
            return <ReasoningRow key={key} row={row} subtle={syntax.subtle} />;
          case 'text':
            return <TextRow key={key} text={row.text} syntax={syntax.normal} />;
          case 'tool':
            return row.row.shape === 'block'
              ? <BlockToolRow key={key} row={row.row} syntax={syntax.normal} width={width} />
              : <InlineToolRow key={key} row={row.row} awaitingPermission={awaiting.has(row.row.call.id)} margin={margin} />;
          case 'error':
            return <ErrorRow key={key} error={row.error} />;
          case 'footer':
            return <FooterRow key={key} row={row} />;
          case 'queued':
            return <QueuedRow key={key} content={row.content} />;
        }
      })}
    </scrollbox>
  );
});

/** Right-aligned interrupt affordance: `esc interrupt`, escalating after the
 * first press. */
export function InterruptHint({ pressed }: { pressed: boolean }) {
  const theme = useTheme();
  return (
    <text fg={toHex(theme.primary)}>{pressed ? 'esc again to interrupt' : 'esc interrupt'}</text>
  );
}
