import { spawn } from 'node:child_process';
import type { CliRenderer } from '@opentui/core';

let pending: Promise<unknown> = Promise.resolve();
export function copyTerminalText(renderer: Pick<CliRenderer, 'copyToClipboardOSC52'>, text: string): Promise<void> {
  const copy = pending.catch(() => {}).then(async () => {
    if (process.platform === 'darwin' && !process.env.SSH_CONNECTION && !process.env.SSH_TTY) {
      const copied = await new Promise<boolean>(resolve => {
        const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 });
        child.once('error', () => resolve(false));
        child.once('close', code => resolve(code === 0));
        child.stdin.on('error', () => {});
        child.stdin.end(text);
      });
      if (copied) return;
    }
    if (!renderer.copyToClipboardOSC52(text)) throw new Error('Clipboard unavailable. Hold Shift while selecting to use your terminal’s native copy.');
  });
  pending = copy;
  return copy;
}
