import { useEffect } from 'react';

export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Older browsers and HTTP connections use the copy event. */ }
  const copy = (event: ClipboardEvent) => { event.clipboardData?.setData('text/plain', text); event.preventDefault(); };
  document.addEventListener('copy', copy);
  try { if (!document.execCommand('copy')) throw new Error('Clipboard unavailable.'); }
  finally { document.removeEventListener('copy', copy); }
}

export function useCopyOnSelection() {
  useEffect(() => {
    const copy = (event: Event) => {
      if (event instanceof KeyboardEvent && !(event.shiftKey || event.key === 'Shift')) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"], .xterm')) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const text = selection.toString();
      if (text) void copyText(text).catch(() => {});
    };
    document.addEventListener('pointerup', copy);
    document.addEventListener('keyup', copy);
    return () => { document.removeEventListener('pointerup', copy); document.removeEventListener('keyup', copy); };
  }, []);
}
