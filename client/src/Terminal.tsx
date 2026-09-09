import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalSquare, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];
const MAX_PENDING = 2 * 1024 * 1024;
const colors = (): ITheme => {
  const root = document.documentElement;
  const dark = root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const css = getComputedStyle(root);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--code', dark ? '#121218' : '#f6f6f8'),
    foreground: token('--text', dark ? '#e8e8f0' : '#272b37'),
    cursor: token('--blue', dark ? '#b8a8ff' : '#5b3fd1'),
    selectionBackground: dark ? '#3b3b4d' : '#ddd6f7',
    black: dark ? '#21212c' : '#272b37', brightBlack: '#747d8c',
    red: dark ? '#f09592' : '#b13232', brightRed: '#e76b68',
    green: dark ? '#7ee2a8' : '#2f9e5e', brightGreen: '#66ba95',
    yellow: dark ? '#dfb46b' : '#916016', brightYellow: '#d4a85a',
    blue: dark ? '#b8a8ff' : '#5b3fd1', brightBlue: dark ? '#c9bdff' : '#7c6cf0',
    magenta: dark ? '#c5a0e5' : '#8857a8', brightMagenta: '#ccaceb',
    cyan: dark ? '#79c5cc' : '#287b86', brightCyan: '#85d4da',
    white: dark ? '#d1d6df' : '#7a8493', brightWhite: dark ? '#ffffff' : '#a3a8b1',
  };
};

/** Mount only when opened by the user. Unmounting detaches; End shell explicitly destroys the PTY. */
export function Terminal({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const controls = useRef<{ connect: () => void; end: () => void } | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const host = container.current;
    const terminal = new XTerm({
      theme: colors(), fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12, lineHeight: 1.2, cursorBlink: true, scrollback: 5000,
      convertEol: false, disableStdin: true, allowProposedApi: false,
    });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
    let socket: WebSocket | undefined;
    let disposed = false, accepting = false, ended = false, attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let healthyTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const send = (message: object) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > 256 * 1024) {
        setError('Terminal input is congested. Wait for the connection to recover; input was not sent.');
        socket.close(1000, 'Input congested'); return false;
      }
      socket.send(JSON.stringify(message)); return true;
    };
    const fitNow = () => {
      if (disposed || host.clientWidth < 20 || host.clientHeight < 20) return;
      const dimensions = fit.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
      const cols = Math.max(2, Math.min(500, dimensions.cols)), rows = Math.max(1, Math.min(200, dimensions.rows));
      const changed = terminal.cols !== cols || terminal.rows !== rows;
      if (changed) terminal.resize(cols, rows);
      if (accepting && changed) send({ type: 'resize', cols, rows });
    };
    const scheduleFit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitNow); };
    const observer = new ResizeObserver(scheduleFit); observer.observe(host);
    const updateTheme = () => { terminal.options.theme = colors(); scheduleFit(); };
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const media = matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', updateTheme);
    document.fonts?.ready.then(() => { if (!disposed) scheduleFit(); });
    scheduleFit();

    const input = terminal.onData(data => {
      if (!accepting || disposed) return;
      // Keep JSON safely below the server payload cap even for control-heavy pastes.
      if (new TextEncoder().encode(data).byteLength > 64 * 1024) { setError('Paste is too large. Paste at most 64 KiB at a time.'); return; }
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 1024, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
        if (!send({ type: 'input', data: data.slice(offset, end) })) break;
        offset = end;
      }
    });
    // Do not register OSC clipboard, hyperlink, or file integrations: output is untrusted text.
    const connect = () => {
      if (disposed) return;
      clearTimeout(retryTimer); clearTimeout(healthyTimer); clearTimeout(connectTimer);
      socket?.close(); accepting = false; terminal.options.disableStdin = true;
      setConnected(false); setStopped(false); setStatus(attempt ? 'Reconnecting…' : 'Connecting…');
      const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/terminal`, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = new WebSocket(url); socket = current;
      let receivedReady = false, replaying = true, pendingBytes = 0;
      let fatalError = false;
      const currentConnection = () => !disposed && socket === current;
      connectTimer = setTimeout(() => { if (currentConnection() && !accepting) current.close(); }, 10_000);
      current.onmessage = event => {
        if (!currentConnection()) return;
        if (typeof event.data !== 'string' || event.data.length > 128 * 1024) { current.close(1008, 'Invalid terminal response'); return; }
        let message: { type?: string; data?: string; seq?: number; cols?: number; rows?: number; message?: string; reason?: string; exitCode?: number };
        try { message = JSON.parse(event.data); if (!message || typeof message !== 'object') throw new Error(); }
        catch { current.close(1008, 'Invalid terminal response'); return; }
        if (message.type === 'ready') {
          if (receivedReady) return;
          receivedReady = true;
          if (Number.isInteger(message.cols) && Number.isInteger(message.rows)) terminal.resize(Math.max(2, Math.min(500, message.cols!)), Math.max(1, Math.min(200, message.rows!)));
          // Queue reset after old writes, so reconnect replay cannot duplicate earlier scrollback.
          terminal.write('\x1bc');
          setError(''); setStatus('Restoring terminal…');
        } else if (message.type === 'output' && receivedReady && typeof message.data === 'string' && Number.isSafeInteger(message.seq)) {
          const bytes = new TextEncoder().encode(message.data).byteLength;
          pendingBytes += bytes;
          if (pendingBytes > MAX_PENDING) { setError('Terminal output was too fast. Reconnecting to bounded scrollback.'); current.close(1000, 'Output congested'); return; }
          terminal.write(message.data, () => {
            pendingBytes -= bytes;
            if (currentConnection() && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ack', seq: message.seq }));
          });
        } else if (message.type === 'replay-end' && receivedReady && replaying) {
          replaying = false;
          terminal.write('', () => {
            if (!currentConnection() || current.readyState !== WebSocket.OPEN || ended) return;
            accepting = true; terminal.options.disableStdin = false;
            clearTimeout(connectTimer); setStatus('Connected'); setConnected(true);
            fitNow(); send({ type: 'resize', cols: terminal.cols, rows: terminal.rows }); terminal.focus();
            healthyTimer = setTimeout(() => { attempt = 0; }, 10_000);
          });
        } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          terminal.resize(Math.max(2, Math.min(500, message.cols!)), Math.max(1, Math.min(200, message.rows!)));
        } else if (message.type === 'error') {
          fatalError = true; accepting = false; terminal.options.disableStdin = true;
          setError(typeof message.message === 'string' ? message.message : 'Terminal unavailable.');
        } else if (message.type === 'exit') {
          ended = true; accepting = false; terminal.options.disableStdin = true;
          setConnected(false); setStopped(true);
          const reason = typeof message.reason === 'string' ? message.reason : `Shell exited${typeof message.exitCode === 'number' ? ` (${message.exitCode})` : ''}.`;
          setStatus(reason); terminal.write(`\r\n[${reason}]\r\n`);
        }
      };
      current.onerror = () => { if (currentConnection()) setError('Cannot connect to the terminal. Check that Lite is running and this session still exists.'); };
      current.onclose = event => {
        if (!currentConnection()) return;
        clearTimeout(healthyTimer); clearTimeout(connectTimer);
        accepting = false; terminal.options.disableStdin = true; setConnected(false);
        if (ended) { setStopped(true); return; }
        if (fatalError || event.code === 1008 || event.code === 1009 || attempt >= RETRY_DELAYS.length) {
          setStopped(true); setStatus('Disconnected');
          setError(previous => previous || 'Terminal disconnected. Reconnect when ready.'); return;
        }
        setStatus('Reconnecting…'); retryTimer = setTimeout(connect, RETRY_DELAYS[attempt++]);
      };
    };
    controls.current = {
      connect: () => { ended = false; attempt = 0; setError(''); connect(); },
      end: () => {
        if (!accepting) return;
        if (send({ type: 'close' })) { accepting = false; terminal.options.disableStdin = true; setStatus('Ending shell…'); setConnected(false); }
      },
    };
    connect();
    return () => {
      disposed = true; accepting = false; controls.current = null;
      clearTimeout(retryTimer); clearTimeout(healthyTimer); clearTimeout(connectTimer); cancelAnimationFrame(frame);
      observer.disconnect(); themeObserver.disconnect(); media.removeEventListener('change', updateTheme);
      input.dispose(); socket?.close(); terminal.dispose();
    };
  }, [sessionId]);

  return <section aria-label="Session terminal" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 180, height: '100%', background: 'var(--code, #181b20)', color: 'var(--text, #e8eaf0)', overflow: 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', flexWrap: 'wrap', borderBottom: '1px solid var(--border, #3c4350)', flexShrink: 0 }}>
      <TerminalSquare size={15} /><strong style={{ fontSize: 12 }}>Terminal</strong>
      <span role="status" style={{ color: 'var(--secondary, #a8afbc)', fontSize: 11, flex: 1 }}>{status}</span>
      {stopped && <button type="button" className="text-button" onClick={() => controls.current?.connect()}>Reconnect / new shell</button>}
      <button type="button" className="text-button" disabled={!connected} title="Terminate this session’s shell and its attached viewers" onClick={() => controls.current?.end()}>End shell</button>
      {onClose && <button type="button" className="icon-button" aria-label="Hide terminal" title="Hide terminal (shell keeps running)" onClick={onClose}><X size={16} /></button>}
    </div>
    {error && <div role="alert" style={{ padding: '8px 12px', fontSize: 12, color: 'var(--red, #f09592)', flexShrink: 0 }}>{error}</div>}
    <div ref={container} style={{ flex: 1, minWidth: 0, minHeight: 100, margin: '8px 10px 0', overflow: 'hidden' }} />
    <p style={{ margin: 0, padding: '8px 12px', fontSize: 10, lineHeight: 1.5, color: 'var(--secondary, #a8afbc)', flexShrink: 0 }}>Shell commands run as your local user; not sandboxed</p>
  </section>;
}
