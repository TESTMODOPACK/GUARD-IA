'use client';

import type { AreaRef, OperatorRole } from '@guardia/shared';
import { BookUser, CalendarClock, LayoutDashboard, LogOut, Volume2, VolumeX } from 'lucide-react';
import Link from 'next/link';
import type { TypeFilter } from '@/lib/store';
import { useStore } from '@/lib/store';
import { ShiftControl } from './ShiftControl';
import { Button } from './ui';

const FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'ALL', label: 'Todo' },
  { value: 'EMERGENCY_SOS', label: 'SOS' },
  { value: 'CIVIC_REPORT', label: 'Urbano' },
];

/** Qué áreas ve la cuenta (0013). Sin áreas en el municipio no se muestra nada: todos ven todo. */
function AreaScope({ areas, seesAll }: { areas: AreaRef[]; seesAll: boolean }) {
  if (seesAll && areas.length === 0) return null;
  const text = seesAll ? 'Todas las áreas' : areas.length ? areas.map((a) => a.name).join(', ') : 'Sin áreas asignadas';
  const title = seesAll
    ? 'Ves las alertas de todas las áreas del municipio'
    : areas.length
      ? `Ves las alertas de ${areas.length === 1 ? 'tu área' : 'tus áreas'}${areas.some((a) => a.receivesSos) ? ', los SOS y los reportes con carácter de seguridad' : ''}`
      : 'Solo ves alertas sin área. Pide al administrador que te asigne una.';
  return (
    <span
      title={title}
      data-testid="area-scope"
      className={`shrink min-w-0 max-w-[260px] truncate h-6 px-2 inline-flex items-center rounded-ctl border text-xs ${
        !seesAll && areas.length === 0 ? 'border-medium/50 text-medium' : 'border-line text-ink-muted'
      }`}
    >
      {text}
    </span>
  );
}

export function TopBar({
  tenantName,
  operatorName,
  role,
  areas,
  seesAll,
  onLogout,
}: {
  tenantName: string;
  operatorName: string;
  role: OperatorRole;
  areas: AreaRef[];
  seesAll: boolean;
  onLogout: () => void;
}) {
  const connection = useStore((s) => s.connection);
  const typeFilter = useStore((s) => s.typeFilter);
  const setTypeFilter = useStore((s) => s.setTypeFilter);
  const showClosed = useStore((s) => s.showClosed);
  const setShowClosed = useStore((s) => s.setShowClosed);
  const sound = useStore((s) => s.prefs.sound);
  const setSound = useStore((s) => s.setSound);

  const dot = connection === 'online' ? 'bg-ok' : connection === 'connecting' ? 'bg-medium' : 'bg-high';
  const connLabel = connection === 'online' ? 'En línea' : connection === 'connecting' ? 'Conectando' : 'Sin conexión';

  return (
    <header className="h-12 shrink-0 flex items-center gap-4 px-4 border-b border-line bg-surface">
      <div className="flex items-center gap-2 min-w-0">
        <img src="/brand-mark.png" alt="" width={26} height={26} className="shrink-0" />
        <span className="font-bold tracking-wide whitespace-nowrap">
          GUARD<span className="text-accent">-IA</span>
        </span>
        <span className="text-ink-muted truncate">{tenantName}</span>
        <AreaScope areas={areas} seesAll={seesAll} />
      </div>

      <div className="flex items-center gap-2 text-sm" aria-live="polite">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-ink-muted">{connLabel}</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div role="radiogroup" aria-label="Tipo de alerta" className="flex rounded-ctl border border-line overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="radio"
              aria-checked={typeFilter === f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`h-8 px-3 text-sm ${typeFilter === f.value ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-[var(--color-accent)]" />
          Cerradas
        </label>
        <Button variant="ghost" aria-label={sound ? 'Silenciar avisos' : 'Activar avisos'} onClick={() => setSound(!sound)} className="h-8 px-2">
          {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </Button>
        <ShiftControl />
        <Link href="/directorio" aria-label="Directorio de contactos" title="Directorio de contactos" className="h-8 px-2 inline-flex items-center rounded-ctl hover:bg-surface-2">
          <BookUser size={16} />
        </Link>
        {role === 'ADMIN' || role === 'SUPERVISOR' || role === 'ASSISTANT' ? (
          <Link href="/admin" aria-label="Administración" title={role === 'ASSISTANT' ? 'Panel, turnos y bitácora' : 'Administración: panel, usuarios, turnos y bitácora'} className="h-8 px-2 inline-flex items-center rounded-ctl hover:bg-surface-2">
            <LayoutDashboard size={16} />
          </Link>
        ) : (
          <Link href="/admin/turnos" aria-label="Turnos" title="Turnos" className="h-8 px-2 inline-flex items-center rounded-ctl hover:bg-surface-2">
            <CalendarClock size={16} />
          </Link>
        )}
        <Link href="/cambiar-clave" className="text-sm text-ink-muted hidden md:inline hover:text-ink" title="Cambiar contraseña">
          {operatorName}
        </Link>
        <Button variant="ghost" aria-label="Cerrar sesión" onClick={onLogout} className="h-8 px-2">
          <LogOut size={16} />
        </Button>
      </div>
    </header>
  );
}
