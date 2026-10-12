'use client';

import { useEffect, useMemo, useState } from 'react';
import { Mic, Camera, ShieldAlert } from 'lucide-react';
import { AI_STATUS, categoryLabel, formatAge, STATUS } from '@/lib/labels';
import { selectVisibleAlerts, useStore, type AnyAlert } from '@/lib/store';
import { PriorityDot, Spinner } from './ui';

/** Reloj compartido: una sola actualización por segundo para todas las filas. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function AlertQueue() {
  // Selectores primitivos + useMemo: un selector que devuelve un array nuevo en cada render
  // haría que useSyncExternalStore vuelva a renderizar sin fin.
  const alerts = useStore((s) => s.alerts);
  const typeFilter = useStore((s) => s.typeFilter);
  const showClosedFilter = useStore((s) => s.showClosed);
  const visible = useMemo(() => selectVisibleAlerts({ alerts, typeFilter, showClosed: showClosedFilter }), [alerts, typeFilter, showClosedFilter]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const showClosed = useStore((s) => s.showClosed);
  const fresh = useStore((s) => s.fresh);
  const loaded = useStore((s) => s.loaded);
  const now = useNow();

  const counts = useMemo(() => {
    const high = visible.filter((a) => a.priority === 'HIGH' && a.status === 'PENDING').length;
    return { total: visible.length, high };
  }, [visible]);

  return (
    <section aria-label="Cola de alertas" className="flex flex-col h-full border-r border-line bg-surface">
      <div className="h-11 shrink-0 flex items-center px-4 border-b border-line text-sm">
        <span className="font-medium">{showClosed ? 'Cerradas' : 'Activas'}</span>
        <span className="ml-2 text-ink-muted tabular-nums">{counts.total}</span>
        {counts.high > 0 ? (
          <span className="ml-auto inline-flex items-center gap-1 text-high">
            <ShieldAlert size={14} />
            {counts.high} sin acusar
          </span>
        ) : null}
      </div>

      <ul className="flex-1 overflow-y-auto gi-scroll">
        {!loaded ? (
          <li className="p-4 text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando alertas
          </li>
        ) : visible.length === 0 ? (
          <li className="p-6 text-sm text-ink-muted">
            {showClosed ? 'No hay alertas cerradas con este filtro.' : 'Sin alertas activas. Las nuevas aparecen aquí al instante.'}
          </li>
        ) : (
          visible.map((a) => (
            <AlertRow key={a.id} alert={a} selected={a.id === selectedId} fresh={a.id in fresh} now={now} onSelect={() => select(a.id)} />
          ))
        )}
      </ul>
    </section>
  );
}

function AlertRow({
  alert,
  selected,
  fresh,
  now,
  onSelect,
}: {
  alert: AnyAlert;
  selected: boolean;
  fresh: boolean;
  now: number;
  onSelect: () => void;
}) {
  const urgent = alert.status === 'PENDING' && (alert.priority === 'HIGH' || (alert.priority === null && alert.type === 'EMERGENCY_SOS'));
  const ageS = (now - new Date(alert.createdAt).getTime()) / 1000;
  const ageTone = alert.status !== 'PENDING' ? 'text-ink-muted' : ageS > 120 && urgent ? 'text-high' : ageS > 60 && urgent ? 'text-medium' : 'text-ink-muted';
  const bar = alert.priority === 'HIGH' ? 'bg-high' : alert.priority === 'MEDIUM' ? 'bg-medium' : alert.priority === 'LOW' ? 'bg-low' : 'bg-line-strong';
  const lowTrust = alert.citizenTrustScore !== null && alert.citizenTrustScore < 50;

  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`relative w-full text-left pl-4 pr-3 py-2.5 border-b border-line/70 transition-colors
          ${selected ? 'bg-surface-2' : 'hover:bg-surface-2/60'}
          ${urgent && !selected ? 'gi-row-urgent' : ''}`}
      >
        <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${bar}`} />
        <div className="flex items-center gap-2">
          <PriorityDot priority={alert.priority} />
          <span className="text-sm font-medium truncate">{categoryLabel(alert.category, alert.type === 'EMERGENCY_SOS' ? 'SOS sin clasificar' : 'Reporte sin clasificar')}</span>
          <span className={`ml-auto text-sm tabular-nums ${ageTone}`}>{formatAge(alert.createdAt, now)}</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-muted">
          <span>{STATUS[alert.status]}</span>
          {alert.aiStatus === 'QUEUED' || alert.aiStatus === 'PROCESSING' ? (
            <span className="inline-flex items-center gap-1">
              <Spinner className="h-2.5 w-2.5" /> {AI_STATUS[alert.aiStatus]}
            </span>
          ) : null}
          {alert.hasAudio ? <Mic size={12} aria-label="Con audio" /> : null}
          {alert.hasPhoto ? <Camera size={12} aria-label="Con foto" /> : null}
          {lowTrust ? <span className="text-medium">Baja confianza</span> : null}
          {fresh ? <span className="ml-auto text-accent">Nueva</span> : null}
        </div>
        {alert.aiSummary ? <p className="mt-1 text-xs text-ink-muted truncate">{alert.aiSummary}</p> : null}
      </button>
    </li>
  );
}
