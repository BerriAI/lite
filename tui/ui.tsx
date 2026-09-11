/** @jsxImportSource @opentui/react */
import { useRef, useState, type ReactNode } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { TextareaRenderable } from '@opentui/core';
import { terminalText } from './protocol.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';

export function Button({ children, onPress, selected = false, disabled = false }: { children: ReactNode; onPress: () => void; selected?: boolean; disabled?: boolean }) {
  const theme = useTheme();
  return <box paddingLeft={1} paddingRight={1} height={1} backgroundColor={selected ? toHex(theme.primary) : undefined} onMouseDown={() => { if (!disabled) onPress(); }}><text fg={toHex(disabled ? theme.textMuted : selected ? theme.background : theme.primary)}>{children}</text></box>;
}

export function Dialog({ title, children, footer = 'Esc back', onClose, width: preferred = 76 }: { title: string; children: ReactNode; footer?: string; onClose: () => void; width?: number }) {
  const theme = useTheme(), { width, height } = useTerminalDimensions();
  useKeyboard(key => { if (key.name === 'escape' && !key.defaultPrevented) { key.preventDefault(); key.stopPropagation(); onClose(); } });
  return <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={20} backgroundColor="#00000099" alignItems="center" justifyContent="center">
    <box width={Math.max(24, Math.min(preferred, width - 2))} maxHeight={Math.max(8, height - 2)} border borderColor={toHex(theme.border)} backgroundColor={toHex(theme.backgroundPanel)} padding={1} flexDirection="column">
      <box flexDirection="row" marginBottom={1}><text fg={toHex(theme.text)}><strong>{title}</strong></text><box flexGrow={1} /><Button onPress={onClose}>×</Button></box>
      {children}
      <text marginTop={1} fg={toHex(theme.textMuted)}>{footer}</text>
    </box>
  </box>;
}

export interface MenuItem { id: string; label: string; description?: string; disabled?: boolean; separatorBefore?: boolean; action: () => void }
interface MenuProps { title: string; items: MenuItem[]; onClose: () => void; search?: boolean; footer?: string }
export function Menu(props: MenuProps) { return <MenuContent key={props.title} {...props} />; }
function MenuContent({ title, items, onClose, search = true, footer }: MenuProps) {
  const theme = useTheme(), { height, width } = useTerminalDimensions();
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const position = useRef(0), searchText = useRef('');
  const move = (value: number) => { position.current = value; setIndex(value); };
  const searchFor = (value: string) => { searchText.current = value; setQuery(value); move(0); };
  const filtered = items.filter(item => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const selected = Math.min(index, Math.max(0, filtered.length - 1));
  const size = (item: MenuItem) => 1 + Number(Boolean(item.description)) + Number(Boolean(item.separatorBefore));
  const footerRows = Math.ceil((footer?.length ?? 35) / Math.max(8, Math.min(width - 12, 66)));
  const budget = Math.max(1, height - (search ? 13 : 12) - Math.max(0, footerRows - 1));
  let start = selected, used = size(filtered[selected] ?? { id: '', label: '', action() {} });
  while (start > 0 && used + size(filtered[start - 1]) <= budget) used += size(filtered[--start]);
  let end = selected + 1;
  while (end < filtered.length && used + size(filtered[end]) <= budget) used += size(filtered[end++]);
  const visible = filtered.slice(start, end), lineWidth = Math.max(8, Math.min(width - 12, 66));
  const line = (source: string) => { const value = terminalText(source); return [...value.replace(/[\n\r\t]/g, ' ')].length > lineWidth ? [...value.replace(/[\n\r\t]/g, ' ')].slice(0, lineWidth - 1).join('') + '…' : value; };
  const choose = (item?: MenuItem) => { if (item && !item.disabled) item.action(); };
  useKeyboard(key => {
    if (key.defaultPrevented) return;
    if (['up', 'down', 'home', 'end', 'return'].includes(key.name)) {
      key.preventDefault(); key.stopPropagation();
      const choices = items.filter(item => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(searchText.current.toLowerCase()));
      const current = Math.min(position.current, Math.max(0, choices.length - 1));
      if (key.name === 'return') choose(choices[current]);
      else move(key.name === 'home' ? 0 : key.name === 'end' ? choices.length - 1 : (current + (key.name === 'down' ? 1 : -1) + choices.length) % Math.max(1, choices.length));
    }
  });
  return <Dialog title={title} onClose={onClose} footer={footer ?? '↑↓ choose · Enter select · Esc back'}>
    {search && <input focused placeholder="Search…" value={query} onInput={searchFor} backgroundColor={toHex(theme.backgroundElement)} textColor={toHex(theme.text)} />}
    <box marginTop={1} flexDirection="column">
      {!filtered.length && <text fg={toHex(theme.textMuted)}>No matches.</text>}
      {visible.map((item, offset) => <box key={item.id} border={false} height={size(item)} flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={start + offset === selected ? toHex(theme.backgroundElement) : undefined} onMouseDown={() => choose(item)}>
        {item.separatorBefore && <text height={1} fg={toHex(theme.border)}>{'─'.repeat(lineWidth)}</text>}
        <text height={1} fg={toHex(item.disabled ? theme.textMuted : theme.text)}>{line(`${start + offset === selected ? '›' : ' '} ${item.label}`)}</text>
        {item.description && <text height={1} fg={toHex(theme.textMuted)}>{line(`  ${item.description}`)}</text>}
      </box>)}
      {filtered.length > visible.length && <text fg={toHex(theme.textMuted)}>{`${selected + 1} / ${filtered.length}`}</text>}
    </box>
  </Dialog>;
}

export function TextPrompt({ title, value = '', placeholder, multiline = false, onSave, onClose, error }: { title: string; value?: string; placeholder?: string; multiline?: boolean; onSave: (value: string) => void; onClose: () => void; error?: string }) {
  const theme = useTheme(), { height } = useTerminalDimensions(), ref = useRef<TextareaRenderable>(null);
  const [text, setText] = useState(value);
  useKeyboard(key => { if (multiline && key.ctrl && key.name === 's') { key.preventDefault(); key.stopPropagation(); onSave(ref.current?.plainText ?? text); } });
  return <Dialog title={title} onClose={onClose} footer={multiline ? 'Ctrl+S save · Esc cancel' : 'Enter save · Esc cancel'}>
    {multiline ? <textarea ref={ref} focused initialValue={value} height={Math.max(1, Math.min(8, height - 10))} wrapMode="word" placeholder={placeholder} onContentChange={() => setText(ref.current?.plainText ?? '')} textColor={toHex(theme.text)} backgroundColor={toHex(theme.backgroundElement)} /> : <input focused value={text} placeholder={placeholder} onInput={setText} onSubmit={value => onSave(typeof value === 'string' ? value : text)} textColor={toHex(theme.text)} backgroundColor={toHex(theme.backgroundElement)} />}
    {error && <text fg={toHex(theme.error)}>{error}</text>}
    <box flexDirection="row" marginTop={1}><Button onPress={() => onSave(multiline ? ref.current?.plainText ?? text : text)}>Save</Button><Button onPress={onClose}>Cancel</Button></box>
  </Dialog>;
}

export function TextViewer({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const theme = useTheme(), { height } = useTerminalDimensions();
  return <Dialog title={title} onClose={onClose} footer="↑↓ / PgUp PgDn scroll · Esc back"><scrollbox height={Math.max(2, height - 10)} focused><text fg={toHex(theme.text)}>{terminalText(text, true)}</text></scrollbox></Dialog>;
}
