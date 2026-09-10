import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { useState } from 'react';

export function Logo({ small = false }: { small?: boolean }) {
  return <span className={`lite-logo ${small ? 'small' : ''}`} aria-hidden="true"><i /><i /><i /></span>;
}
export function SpeedRail({ active = false, compact = false }: { active?: boolean; compact?: boolean }) {
  return <div className={`speed-rail ${active ? 'active' : ''} ${compact ? 'compact' : ''}`} aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i}><i /></span>)}</div>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      const target = ref.current?.querySelector<HTMLElement>('[autofocus]') ?? ref.current?.querySelector<HTMLElement>('input, textarea, select') ?? ref.current?.querySelector<HTMLElement>('button');
      target?.focus();
    }, 40);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? []).filter(el => el.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey); document.body.style.overflow = bodyOverflow; previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}><div className="modal-header"><h2 id={id}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</div></div>;
}
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button className="copy-button" aria-label={state === 'copied' ? 'Copied' : label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setState('copied'); } catch { setState('error'); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 1800);
  }}>{state === 'copied' ? <Check size={13} /> : <Copy size={13} />}<span>{state === 'copied' ? 'Copied' : state === 'error' ? 'Copy unavailable' : label}</span></button>;
}
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state">{icon}<strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
