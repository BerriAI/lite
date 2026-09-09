/** @jsxImportSource @opentui/react */
/** Root component tree for the terminal client (Phase 1: renderer foundation).
 * Later phases replace the plain-text transcript rows and the minimal composer
 * with the full themed chassis; the structure here — loading gate, crash
 * screen, sticky-scroll transcript, prompt at the bottom — is the durable
 * skeleton they build on. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useKeyboard, useRenderer } from '@opentui/react';
import type { TextareaRenderable } from '@opentui/core';
import type { Message, SessionDetail } from '../shared/types.js';
import type { SessionSync } from './sync.js';

/** Loading indicator holds off for a grace period so fast local loads never
 * flash a spinner, then shows progress dots until the snapshot lands. */
export const LOADING_GRACE_MS = 500;
export const LOADING_DOT_MS = 3000;

function LoadingScreen() {
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
      <text fg="#8a8a8a">{`loading${'.'.repeat(dots)}`}</text>
    </box>
  );
}

function CrashScreen({ message, onQuit }: { message: string; onQuit: () => void }) {
  useKeyboard(() => onQuit());
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <text fg="#e06c75">The terminal client hit a fatal error.</text>
      <text>{message}</text>
      <text fg="#8a8a8a">press any key to exit</text>
    </box>
  );
}

function MessageRow({ message }: { message: Message }) {
  const label = message.role === 'user' ? '❯' : '≋';
  const color = message.role === 'user' ? '#61afef' : '#e5e5e5';
  const body = [
    message.reasoning ? `Thought: ${message.reasoning}` : '',
    message.content ?? '',
    ...(message.toolCalls ?? []).map(tool =>
      `${tool.status === 'completed' ? '✓' : tool.status === 'error' ? '✗' : tool.status === 'denied' ? '⊘' : '…'} ${tool.name}`),
    message.error ? `error: ${message.error}` : '',
  ].filter(Boolean).join('\n');
  return (
    <box flexDirection="row" marginBottom={1}>
      <text fg={message.role === 'user' ? '#61afef' : '#5c6370'}>{`${label} `}</text>
      <box flexGrow={1} flexShrink={1}>
        <text fg={color} wrapMode="word">{body || ' '}</text>
      </box>
    </box>
  );
}

function Transcript({ detail }: { detail: SessionDetail }) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      {detail.messages.map(message => <MessageRow key={message.id} message={message} />)}
    </scrollbox>
  );
}

function StatusLine({ detail }: { detail: SessionDetail }) {
  const session = detail.session;
  const busy = session.status === 'running' || session.status === 'waiting';
  return (
    <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg="#8a8a8a">{`${session.title || 'Session'} · ${session.providerId}/${session.model} · ${session.mode}`}</text>
      <box flexGrow={1} />
      <text fg={busy ? '#e5c07b' : '#5c6370'}>{busy ? 'working…' : 'idle'}</text>
    </box>
  );
}

function Composer({ onSubmit }: { onSubmit: (text: string) => void }) {
  const editor = useRef<TextareaRenderable>(null);
  return (
    <box border borderColor="#3e4451" height={3} paddingLeft={1} paddingRight={1}>
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

export function App({ sync, onQuit }: { sync: SessionSync; onQuit: () => void }) {
  const renderer = useRenderer();
  const state = useSyncExternalStore(listener => sync.subscribe(listener), () => sync.getState());
  const lastCtrlC = useRef(0);
  const [notice, setNotice] = useState('');

  useKeyboard(key => {
    if (key.name === 'd' && key.ctrl) return onQuit();
    if (key.name === 'c' && key.ctrl) {
      const now = Date.now();
      if (now - lastCtrlC.current < 2000) return onQuit();
      lastCtrlC.current = now;
      setNotice('press ctrl+c again to exit');
      return;
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

  if (state.phase === 'error') return <CrashScreen message={state.error ?? 'Unknown error.'} onQuit={onQuit} />;
  if (state.phase === 'loading' || !state.detail) return <LoadingScreen />;
  return (
    <box flexGrow={1} flexDirection="column">
      <StatusLine detail={state.detail} />
      <Transcript detail={state.detail} />
      {notice ? <box height={1} paddingLeft={1}><text fg="#e5c07b">{notice}</text></box> : null}
      <Composer onSubmit={submit} />
    </box>
  );
}
