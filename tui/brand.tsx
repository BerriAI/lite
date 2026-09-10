/** @jsxImportSource @opentui/react */
import { useTheme } from './context.js';
import { toHex } from './theme.js';

/** A terminal-native companion to the web's forward-moving rail mark. */
export function Brand() {
  const theme = useTheme();
  return <box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
    <text fg={toHex(theme.primary)}>{'    ╭──────╮\n ───┤  ▰▰   ╲\n  ──┴────────╯'}</text>
    <text fg={toHex(theme.text)}><strong>lite.</strong></text>
  </box>;
}
