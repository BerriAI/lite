/** @jsxImportSource @opentui/react */
import { useEffect, useRef, useState } from 'react';
import { useKeyboard, useRenderer } from '@opentui/react';
import type { PasteEvent } from '@opentui/core';
import { Dialog, Button } from './ui.js';
import { useTheme } from './context.js';
import { toHex } from './theme.js';

/** Secret bytes never enter a renderable, transcript, input history, or draft. */
export function SecretPrompt({ title, onSave, onClose, description, submitLabel = 'Save key' }: { title: string; description?: string; submitLabel?: string; onSave: (value: string) => void; onClose: () => void }) {
  const value = useRef(''), [length, setLength] = useState(0), renderer = useRenderer(), theme = useTheme();
  const update = (text: string) => { value.current = text.slice(0, 8192); setLength(value.current.length); };
  useEffect(() => {
    const paste = (event: PasteEvent) => { event.preventDefault(); event.stopPropagation(); update(value.current + new TextDecoder().decode(event.bytes).replace(/[\p{Cc}\p{Cf}]/gu, '')); };
    renderer.keyInput.on('paste', paste);
    return () => { renderer.keyInput.off('paste', paste); value.current = ''; };
  }, [renderer]);
  useKeyboard(key => {
    if (key.defaultPrevented || key.name === 'escape' || (key.ctrl && key.name === 'c')) return;
    key.preventDefault(); key.stopPropagation();
    if (key.name === 'return') onSave(value.current);
    else if (key.name === 'backspace') update([...value.current].slice(0, -1).join(''));
    else if (key.ctrl && key.name === 'u') update('');
    else if (!key.ctrl && !key.meta && key.sequence && !/[\p{Cc}\p{Cf}]/u.test(key.sequence)) update(value.current + key.sequence);
  });
  return <Dialog title={title} onClose={onClose} footer={`Type or paste · Enter ${submitLabel.toLowerCase()} · Ctrl+U clear · Esc cancel`}>
    {description && <text marginBottom={1} fg={toHex(theme.textMuted)}>{description}</text>}
    <text fg={toHex(theme.text)}>{length ? '•'.repeat(Math.min(length, 48)) : 'API key…'}</text>
    <Button onPress={() => onSave(value.current)}>{submitLabel}</Button>
  </Dialog>;
}
