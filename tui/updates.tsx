/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../shared/updates.js';
import type { TerminalController } from './controller.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';
import { Button } from './ui.js';
import { terminalText } from './protocol.js';

export function UpdateNotice({ controller, onRestart }: { controller: TerminalController; onRestart: () => void }) {
  const theme = useTheme(), [status, setStatus] = useState<UpdateStatus>(), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () => { void controller.client.api<UpdateStatus>('/updates').then(value => { if (live) setStatus(value); }).catch(() => {}); };
    check(); const timer = setInterval(check, 3600000);
    return () => { live = false; clearInterval(timer); };
  }, [controller]);
  async function update() {
    setBusy(true);
    try {
      if (status?.restartRequired) {
        await controller.client.api('/updates/restart', {});
        onRestart();
      } else setStatus(await controller.client.api<UpdateStatus>('/updates/install', {}, 'POST', AbortSignal.timeout(360000)));
    } catch (error) { controller.notice(error instanceof Error ? error.message : 'Update failed.'); }
    finally { setBusy(false); }
  }
  if (!status || (!status.available && !status.restartRequired)) return null;
  return <box flexDirection="row" flexShrink={0} height={1} paddingLeft={1}><text fg={toHex(theme.textMuted)}>{busy ? 'Downloading and checking the update… ' : `Speedrail ${terminalText(status.installedVersion && status.restartRequired ? status.installedVersion : status.latestVersion)} ${status.restartRequired ? 'installed' : 'available'} `}</text>{status.packaged ? <Button disabled={busy} onPress={() => void update()}>{status.restartRequired ? 'Restart when idle' : 'Install update'}</Button> : <text fg={toHex(theme.textMuted)}>Update your checkout or install the macOS package.</text>}</box>;
}
