'use client';

import { useEffect, useId, useRef } from 'react';
import type { Priority } from '@guardia/shared';
import { PRIORITY } from '@/lib/labels';

type ButtonVariant = 'primary' | 'quiet' | 'danger' | 'ghost';

export function Button({
  variant = 'quiet',
  className = '',
  busy,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  const base =
    'inline-flex items-center justify-center gap-2 h-9 px-3 rounded-ctl text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-accent-ink hover:brightness-110',
    quiet: 'bg-surface-2 border border-line hover:border-line-strong',
    danger: 'bg-transparent border border-high/60 text-high hover:bg-high/10',
    ghost: 'bg-transparent hover:bg-surface-2',
  };
  return (
    // `rest` va primero: un `disabled` del llamador no puede reactivar el botón mientras está ocupado.
    <button {...rest} className={`${base} ${styles[variant]} ${className}`} disabled={busy || rest.disabled}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-3.5 w-3.5 rounded-full border-2 border-current border-r-transparent animate-spin ${className}`}
    />
  );
}

export function PriorityDot({ priority, className = '' }: { priority: Priority | null; className?: string }) {
  const color = priority === 'HIGH' ? 'bg-high' : priority === 'MEDIUM' ? 'bg-medium' : priority === 'LOW' ? 'bg-low' : 'bg-ink-faint';
  return <span aria-label={priority ? PRIORITY[priority] : 'Sin prioridad'} className={`inline-block h-2.5 w-2.5 rounded-full ${color} ${className}`} />;
}

export function Tag({ tone = 'neutral', children }: { tone?: 'neutral' | 'high' | 'medium' | 'low' | 'ok' | 'accent'; children: React.ReactNode }) {
  const tones = {
    neutral: 'bg-surface-2 text-ink-muted border-line',
    high: 'bg-high/15 text-high border-high/40',
    medium: 'bg-medium/15 text-medium border-medium/40',
    low: 'bg-low/15 text-low border-low/40',
    ok: 'bg-ok/15 text-ok border-ok/40',
    accent: 'bg-accent/15 text-accent border-accent/40',
  };
  return <span className={`inline-flex items-center h-6 px-2 rounded-ctl border text-xs ${tones[tone]}`}>{children}</span>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-ink-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'w-full h-9 px-3 rounded-ctl bg-bg border border-line text-sm placeholder:text-ink-faint focus:border-accent';
export const textareaClass =
  'w-full min-h-20 px-3 py-2 rounded-ctl bg-bg border border-line text-sm placeholder:text-ink-faint focus:border-accent resize-y';

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Diálogo modal: foco al primer control, Tab atrapado dentro, Esc cierra y el foco vuelve a
 * donde estaba. Con `busy` (acción en curso) ni Esc ni el fondo lo cierran.
 */
export function Dialog({
  title,
  onClose,
  busy = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const latest = useRef({ onClose, busy });
  useEffect(() => {
    latest.current = { onClose, busy };
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    (root?.querySelector<HTMLElement>(FOCUSABLE) ?? root)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-[440px] max-w-[94vw] rounded-lg border border-line-strong bg-surface p-5 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-semibold mb-4">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
