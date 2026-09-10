/** @jsxImportSource @opentui/react */
/** Root component tree for the terminal client. Colors come from the resolved
 * theme and global keys route through the KeymapRouter, so behavior follows
 * lite-tui.json(c) overrides. Later phases replace the plain-text transcript
 * rows and the minimal composer with the full themed chassis; the structure
 * here — loading gate, crash screen, sticky-scroll transcript, prompt at the
 * bottom — is the durable skeleton they build on. */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import type { TextareaRenderable } from '@opentui/core';
import type { SessionDetail } from '../shared/types.js';
import type { SessionSync } from './sync.js';
import { toHex, type Theme } from './theme.js';
import type { KeymapRouter } from './keymap.js';
import {
  DEFAULT_TRANSCRIPT_SETTINGS, InterruptHint, Transcript, TranscriptSettingsProvider,
  WorkingScanner, type TranscriptSettings,
} from './transcript.js';

const ThemeContext = createContext<Theme | null>(null);

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme called outside the App theme provider');
  return theme;
}

/** Loading indicator holds off for a grace period so fast local loads never
 * flash a spinner, then shows progress dots until the snapshot lands. */
export const LOADING_GRACE_MS = 500;
export const LOADING_DOT_MS = 3000;

function LoadingScreen() {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const grace = setTimeout(() => setVisible(true), LOADING_GRACE_MS);
    const pulse = setInterval(() => setDots(count => (count % 3) + 1), LOADING_DOT_MS / 3);
    return () => { clearTimeout(grace); clearInterval(pulse); };
  }, []);
  if (!visible) return <box flexGrow={1} />;
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text fg={toHex(theme.textMuted)}>{`loading${'.'.repeat(dots)}`}</text>
    </box>
  );
}

function CrashScreen({ message, onQuit }: { message: string; onQuit: () => void }) {
  const theme = useTheme();
  useKeyboard(() => onQuit());
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <text fg={toHex(theme.error)}>The terminal client hit a fatal error.</text>
      <text fg={toHex(theme.text)}>{message}</text>
      <text fg={toHex(theme.textMuted)}>press any key to exit</text>
    </box>
  );
}

function StatusLine({ detail, escPressed }: { detail: SessionDetail; escPressed: boolean }) {
  const theme = useTheme();
  const session = detail.session;
  const busy = session.status === 'running' || session.status === 'waiting';
  return (
    <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg={toHex(theme.textMuted)}>{`${session.title || 'Session'} · ${session.providerId}/${session.model} · ${session.mode}`}</text>
      <box flexGrow={1} />
      {busy ? (
        <box flexDirection="row" gap={2}>
          <WorkingScanner color={toHex(theme.primary)} />
          <InterruptHint pressed={escPressed} />
        </box>
      ) : <text fg={toHex(theme.textMuted)}>idle</text>}
    </box>
  );
}

function Composer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const theme = useTheme();
  const editor = useRef<TextareaRenderable>(null);
  return (
    <box border borderColor={toHex(theme.border)} height={3} paddingLeft={1} paddingRight={1}>
      <textarea
        ref={editor}
        focused
        placeholder="Type a message… (/quit to exit)"
        keyBindings={[{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' }]}
        onSubmit={() => {
          const value = editor.current?.plainText ?? '';
          if (!value.trim()) return;
          editor.current?.clear();
          onSubmit(value);
        }}
      />
    </box>
  );
}

export interface AppProps {
  sync: SessionSync;
  theme: Theme;
  router: KeymapRouter;
  onQuit: () => void;
}

export function App({ sync, theme, router, onQuit }: AppProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const state = useSyncExternalStore(listener => sync.subscribe(listener), () => sync.getState());
  const lastCtrlC = useRef(0);
  const [notice, setNotice] = useState('');
  const [escPressed, setEscPressed] = useState(false);
  const [settings, setSettings] = useState<TranscriptSettings>(DEFAULT_TRANSCRIPT_SETTINGS);
  const toggle = (key: keyof TranscriptSettings, label: string) => {
    setSettings(current => {
      const next = { ...current, [key]: !current[key] };
      setNotice(`${label} ${next[key] ? 'shown' : 'hidden'}`);
      return next;
    });
  };
  const pendingLeader = useSyncExternalStore(
    listener => router.subscribe(listener),
    () => router.pending.length > 0,
  );

  useKeyboard(key => {
    const result = router.dispatch({
      name: key.name ?? '', ctrl: key.ctrl, shift: key.shift, meta: key.meta,
    });
    if (result.pending) return;
    if (result.command === 'app.exit') {
      // Bare ctrl+c asks for confirmation; every other exit chord is immediate.
      if (key.name === 'c' && key.ctrl) {
        const now = Date.now();
        if (now - lastCtrlC.current < 2000) return onQuit();
        lastCtrlC.current = now;
        setNotice('press ctrl+c again to exit');
        return;
      }
      return onQuit();
    }
    if (result.command === 'session.toggle.thinking') return toggle('showThinking', 'thinking');
    if (result.command === 'session.toggle.actions') return toggle('toolDetails', 'tool details');
    if (result.command === 'session.toggle.timestamps') return toggle('timestamps', 'timestamps');
    if (result.command === 'session.toggle.generic_tool_output') return toggle('genericToolOutput', 'tool output');
    if (result.command === 'app.toggle.animations') return toggle('animations', 'animations');
    if (result.command === 'session.interrupt') {
      const detail = sync.getState().detail;
      if (!detail) return;
      const busy = detail.session.status === 'running' || detail.session.status === 'waiting';
      if (!busy) return;
      if (!escPressed) {
        setEscPressed(true);
        setTimeout(() => setEscPressed(false), 2000);
        return;
      }
      setEscPressed(false);
      void sync.client.api(`/sessions/${encodeURIComponent(detail.session.id)}/interrupt`, {}).catch(() => {});
    }
  });

  const submit = (text: string) => {
    if (text.trim() === '/quit' || text.trim() === '/exit') return onQuit();
    setNotice('');
    const detail = sync.getState().detail;
    if (!detail) return;
    const busy = detail.session.status === 'running' || detail.session.status === 'waiting';
    const path = `/sessions/${encodeURIComponent(detail.session.id)}${busy ? '/queue' : '/messages'}`;
    void sync.client.api(path, { content: text }).catch(error => {
      setNotice(error instanceof Error ? error.message : 'Could not send the message.');
    });
    if (busy) setNotice('queued for after the current response');
  };

  useEffect(() => {
    // The scrollbox owns mouse scrolling; keep keyboard focus on the textarea.
    renderer.requestRender();
  }, [renderer, state.phase]);

  let body;
  if (state.phase === 'error') body = <CrashScreen message={state.error ?? 'Unknown error.'} onQuit={onQuit} />;
  else if (state.phase === 'loading' || !state.detail) body = <LoadingScreen />;
  else {
    body = (
      <box flexGrow={1} flexDirection="column">
        <StatusLine detail={state.detail} escPressed={escPressed} />
        <Transcript detail={state.detail} width={width} />
        {notice || pendingLeader ? (
          <box height={1} paddingLeft={1}>
            <text fg={toHex(theme.warning)}>{pendingLeader ? 'leader…' : notice}</text>
          </box>
        ) : null}
        <Composer onSubmit={submit} />
      </box>
    );
  }
  return (
    <ThemeContext.Provider value={theme}>
      <TranscriptSettingsProvider value={settings}>{body}</TranscriptSettingsProvider>
    </ThemeContext.Provider>
  );
}
