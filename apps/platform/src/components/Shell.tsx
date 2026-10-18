'use client';

import type { PlatformRole } from '@guardia/shared';
import { KeyRound, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { logout } from '@/lib/api';
import { ROLE } from '@/lib/labels';
import { loadSession, onSessionChange, type Session } from '@/lib/session';

/** Quiénes cambian municipios (igual que la API: TENANT_MANAGERS). */
export const MANAGERS: PlatformRole[] = ['SUPERADMIN', 'IMPLEMENTATION'];
export const canManage = (s: Session | null) => !!s && MANAGERS.includes(s.user.role);

const SECTIONS: { href: string; label: string; roles: PlatformRole[] }[] = [
  { href: '/', label: 'Chile', roles: [] },
  { href: '/municipios', label: 'Municipios', roles: [] },
  { href: '/subencargados', label: 'Subencargados', roles: [] },
  { href: '/incidentes', label: 'Incidentes', roles: [] },
  { href: '/bitacora', label: 'Bitácora', roles: [] },
  { href: '/usuarios', label: 'Equipo', roles: ['SUPERADMIN'] },
];

/**
 * Sesión en cliente: sin sesión va al ingreso; con contraseña temporal, a cambiarla; sin el rol pedido,
 * al inicio. La API exige lo mismo; esto solo evita mostrar una página que no va a cargar.
 */
export function usePlatformSession(roles: PlatformRole[] = []): Session | null {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const rolesKey = roles.join(',');

  useEffect(() => {
    const allowed = rolesKey ? rolesKey.split(',') : [];
    const apply = (s: Session | null) => {
      if (!s) return router.replace('/login');
      if (s.user.mustChangePassword) return router.replace('/cambiar-clave');
      if (allowed.length && !allowed.includes(s.user.role)) return router.replace('/');
      setSession(s);
    };
    apply(loadSession());
    return onSessionChange(apply);
  }, [router, rolesKey]);

  return session;
}

export function Shell({ session, children }: { session: Session; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const sections = SECTIONS.filter((s) => s.roles.length === 0 || s.roles.includes(session.user.role));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-12 shrink-0 flex items-center gap-4 px-4 border-b border-line bg-surface sticky top-0 z-[1000]">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <img src="/brand-mark.png" alt="" width={24} height={24} />
          <span className="font-bold tracking-wide whitespace-nowrap">
            GUARD<span className="text-accent">-IA</span>
          </span>
          <span className="text-ink-muted text-sm hidden sm:inline">Plataforma</span>
        </Link>
        <nav aria-label="Secciones" className="flex items-center gap-1 overflow-x-auto">
          {sections.map((s) => {
            const active = s.href === '/' ? pathname === '/' || pathname.startsWith('/region') : pathname.startsWith(s.href);
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
        <div className="ml-auto flex items-center gap-3 min-w-0">
          <div className="text-right min-w-0 hidden md:block">
            <div className="text-sm truncate">{session.user.name}</div>
            <div className="text-xs text-ink-faint truncate">{ROLE[session.user.role]}</div>
          </div>
          <Link
            href="/cambiar-clave"
            aria-label="Cambiar contraseña"
            title="Cambiar contraseña"
            className="h-8 px-2 inline-flex items-center rounded-ctl hover:bg-surface-2"
          >
            <KeyRound size={16} />
          </Link>
          <button
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            className="h-8 px-2 inline-flex items-center rounded-ctl hover:bg-surface-2"
            onClick={() => {
              void logout().then(() => router.replace('/login'));
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="flex-1 w-full max-w-[1400px] mx-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}
