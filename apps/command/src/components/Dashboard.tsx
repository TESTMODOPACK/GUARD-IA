'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, logout } from '@/lib/api';
import { TENANT_STATUS_NOTICE } from '@/lib/labels';
import { connectRealtime, disconnectRealtime } from '@/lib/realtime';
import { loadSession, onSessionChange, type Session } from '@/lib/session';
import { unlockAudio } from '@/lib/sound';
import { CLOSED_STATUSES, useStore } from '@/lib/store';
import { AlertDetailPanel } from './AlertDetail';
import { AlertQueue } from './AlertQueue';
import { TopBar } from './TopBar';
import { UnitsBar } from './UnitsBar';
import { Spinner } from './ui';

const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center text-ink-muted text-sm">
      <Spinner className="mr-2" /> Cargando mapa
    </div>
  ),
});

export function Dashboard() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const upsertMany = useStore((s) => s.upsertMany);
  const notify = useStore((s) => s.notify);
  const showClosed = useStore((s) => s.showClosed);
  const toast = useStore((s) => s.toast);
  const clearToast = useStore((s) => s.clearToast);
  const selectedId = useStore((s) => s.selectedId);

  // Guardia de sesión en cliente.
  useEffect(() => {
    const apply = (s: Session | null) => {
      setSession(s);
      if (!s) router.replace('/login');
      else if (s.operator.mustChangePassword) router.replace('/cambiar-clave');
    };
    apply(loadSession());
    return onSessionChange(apply);
  }, [router]);

  // WebSocket. Al conectar (y en cada reconexión) carga activas y unidades por REST, con reintento.
  const operatorId = session?.operator.id;
  useEffect(() => {
    if (!operatorId) return;
    connectRealtime();
    return () => disconnectRealtime();
  }, [operatorId]);

  // Cerradas se cargan bajo demanda (últimas 50).
  useEffect(() => {
    if (!showClosed) return;
    api
      .alerts({ statuses: CLOSED_STATUSES, limit: 50 })
      .then((r) => upsertMany(r.items))
      .catch((e: Error) => notify('error', e.message));
  }, [showClosed, upsertMany, notify]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, toast.kind === 'error' ? 6000 : 2500);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  if (session === undefined) return null;
  if (!session) return null;

  return (
    <div className="h-screen flex flex-col" onPointerDown={unlockAudio}>
      <TopBar
        tenantName={session.operator.tenantName}
        operatorName={session.operator.name}
        role={session.operator.role}
        onLogout={() => {
          disconnectRealtime();
          void logout();
        }}
      />
      {session.operator.tenantStatus && TENANT_STATUS_NOTICE[session.operator.tenantStatus] ? (
        <div role="status" className="shrink-0 px-4 py-1.5 text-sm border-b border-line bg-surface-2 text-medium">
          {TENANT_STATUS_NOTICE[session.operator.tenantStatus]}
        </div>
      ) : null}
      <main className="flex-1 min-h-0 grid grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_440px]">
        <AlertQueue />
        <div className="relative min-h-0 xl:block">
          <MapView />
          <UnitsBar />
        </div>
        <div className={`min-h-0 xl:static xl:w-auto xl:block absolute right-0 top-12 bottom-0 w-[440px] max-w-full ${selectedId ? '' : 'hidden'}`}>
          <AlertDetailPanel />
        </div>
      </main>
      {toast ? (
        <div
          role="status"
          className={`fixed top-14 left-1/2 -translate-x-1/2 z-[1200] px-4 py-2 rounded-ctl border text-sm shadow-xl ${
            toast.kind === 'ok' ? 'bg-surface-2 border-ok/50 text-ok' : 'bg-surface-2 border-high/50 text-high'
          }`}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
