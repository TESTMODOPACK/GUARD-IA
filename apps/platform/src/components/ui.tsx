'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { COMUNA_SERVICE_STATUSES, type ComunaServiceStatus } from '@guardia/shared';
import { SERVICE_COLOR, SERVICE_STATUS, SERVICE_TONE } from '@/lib/labels';

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
    danger: 'bg-transparent border border-medium/60 text-medium hover:bg-medium/10',
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

export type Tone = 'neutral' | 'medium' | 'ok' | 'accent' | 'faint';

export function Tag({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  const tones: Record<Tone, string> = {
    neutral: 'bg-surface-2 text-ink-muted border-line',
    medium: 'bg-medium/15 text-medium border-medium/40',
    ok: 'bg-ok/15 text-ok border-ok/40',
    accent: 'bg-accent/15 text-accent border-accent/40',
    faint: 'bg-transparent text-ink-faint border-line',
  };
  return <span className={`inline-flex items-center h-6 px-2 rounded-ctl border text-xs whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

export function StatusTag({ status }: { status: ComunaServiceStatus }) {
  return <Tag tone={SERVICE_TONE[status]}>{SERVICE_STATUS[status]}</Tag>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-ink-muted mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-ink-faint mt-1">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full h-9 px-3 rounded-ctl bg-bg border border-line text-sm placeholder:text-ink-faint focus:border-accent';
export const textareaClass =
  'w-full min-h-20 px-3 py-2 rounded-ctl bg-bg border border-line text-sm placeholder:text-ink-faint focus:border-accent resize-y';

export function ErrorNote({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-medium">
      {children}
    </p>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {title || actions ? (
        <header className="flex items-center gap-3 px-4 h-11 border-b border-line">
          {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
          {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Contraseña temporal o clave TOTP: se muestra una vez, con botón para copiarla. */
export function SecretValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code aria-label={label} className="flex-1 min-w-0 break-all rounded-ctl border border-line-strong bg-bg px-3 py-2 font-mono text-sm tracking-wider">
        {value}
      </code>
      <Button
        variant="quiet"
        aria-label={`Copiar ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value.replace(/\s/g, '')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Diálogo modal (igual que la central): foco al primer control, Tab atrapado dentro, Esc cierra y el foco
 * vuelve a donde estaba. Con `busy` ni Esc ni el fondo lo cierran.
 */
export function Dialog({
  title,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
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
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4"
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
        className={`${wide ? 'w-[640px]' : 'w-[460px]'} max-w-full max-h-[92vh] overflow-y-auto gi-scroll rounded-lg border border-line-strong bg-surface p-5 shadow-2xl outline-none`}
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

export function Loading() {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-muted p-6">
      <Spinner /> Cargando…
    </div>
  );
}

/** Leyenda de colores del mapa de comunas. */
export function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-ink-muted">
      {COMUNA_SERVICE_STATUSES.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SERVICE_COLOR[s] }} />
          {SERVICE_STATUS[s]}
        </li>
      ))}
    </ul>
  );
}
