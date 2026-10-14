'use client';

import type { OperatorRole } from '@guardia/shared';
import { ArrowLeft, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiRequestError, logout } from '@/lib/api';
import { ROLE } from '@/lib/labels';
import { loadSession, onSessionChange, type Session } from '@/lib/session';
import { Button, Dialog } from '../ui';

const MANAGERS: OperatorRole[] = ['ADMIN', 'SUPERVISOR'];
/** Panel y bitácora: también el apoyo administrativo (0013), que consulta sin operar. */
export const VIEWERS: OperatorRole[] = ['ADMIN', 'SUPERVISOR', 'ASSISTANT'];

/** Secciones del módulo. `roles` vacío: cualquier operador. */
const SECTIONS: { href: string; label: string; roles: OperatorRole[] }[] = [
  { href: '/admin', label: 'Panel', roles: VIEWERS },
  { href: '/admin/usuarios', label: 'Usuarios', roles: MANAGERS },
  { href: '/admin/areas', label: 'Áreas', roles: ['ADMIN'] },
  { href: '/admin/turnos', label: 'Turnos', roles: [] },
  { href: '/directorio', label: 'Directorio', roles: [] },
  { href: '/admin/cuentas', label: 'Cuentas', roles: MANAGERS },
  { href: '/admin/bitacora', label: 'Bitácora', roles: VIEWERS },
];

/**
 * Sesión en cliente para las páginas del módulo: sin sesión va al ingreso; sin el rol pedido, a la
 * central. La API exige lo mismo (esto solo evita mostrar una página que no va a cargar).
 */
export function useOperatorSession(roles: OperatorRole[] = []): Session | null {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const rolesKey = roles.join(',');

  useEffect(() => {
    const allowed = rolesKey ? rolesKey.split(',') : [];
    const apply = (s: Session | null) => {
      if (!s) return router.replace('/login');
      if (s.operator.mustChangePassword) return router.replace('/cambiar-clave');
      if (allowed.length && !allowed.includes(s.operator.role)) return router.replace('/');
      setSession(s);
    };
    apply(loadSession());
    return onSessionChange(apply);
  }, [router, rolesKey]);

  return session;
}

export const isManager = (s: Session | null) => !!s && MANAGERS.includes(s.operator.role);

export function AdminShell({
  session,
  title,
  actions,
  children,
}: {
  session: Session;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const role = session.operator.role;
  const sections = SECTIONS.filter((s) => s.roles.length === 0 || s.roles.includes(role));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-12 shrink-0 flex items-center gap-4 px-4 border-b border-line bg-surface">
        <Link href="/" className="flex items-center gap-2 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft size={16} /> Central
        </Link>
        <span className="h-5 w-px bg-line" aria-hidden />
        <img src="/brand-mark.png" alt="" width={22} height={22} />
        <span className="font-bold tracking-wide whitespace-nowrap">
          GUARD<span className="text-accent">-IA</span>
        </span>
        <span className="text-ink-muted truncate hidden sm:inline">{session.operator.tenantName}</span>
        <nav aria-label="Administración" className="ml-4 flex items-center gap-1 overflow-x-auto">
          {sections.map((s) => {
            const active = s.href === '/admin' ? pathname === '/admin' : pathname.startsWith(s.href);
            return (
              <Link
                key={s.href}
                href={s.href}
                aria-current={active ? 'page' : undefined}
                className={`h-8 px-3 inline-flex items-center rounded-ctl text-sm whitespace-nowrap ${
                  active ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {s.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-ink-muted hidden md:inline">
            {session.operator.name} · {ROLE[role]}
          </span>
          <Button variant="ghost" aria-label="Cerrar sesión" onClick={() => void logout()} className="h-8 px-2">
            <LogOut size={16} />
          </Button>
        </div>
      </header>
      <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 py-6 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{title}</h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        </div>
        {children}
      </main>
    </div>
  );
}

/** Aviso en línea (éxito o error) para las páginas del módulo. */
export function Notice({ kind, children }: { kind: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`px-3 py-2 rounded-ctl border text-sm ${kind === 'ok' ? 'border-ok/40 bg-ok/10 text-ok' : 'border-high/40 bg-high/10 text-high'}`}
    >
      {children}
    </div>
  );
}

/** Tarjeta de sección del panel. */
export function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-4 min-w-0 ${className}`}>
      {title ? <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3">{title}</h2> : null}
      {children}
    </section>
  );
}

export const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : 'No se pudo conectar con la API.');

/** Confirmación de una acción que cambia algo (desactivar, restablecer, eliminar). */
export function ConfirmDialog({
  title,
  confirmLabel,
  danger = false,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <p className="text-sm text-ink-muted">{children}</p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-high">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              setError(errText(e));
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

