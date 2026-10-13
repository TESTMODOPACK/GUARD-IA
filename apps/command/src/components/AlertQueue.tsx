'use client';

import { useEffect, useMemo, useState } from 'react';
import { Camera, Mic, Repeat, ShieldAlert, Users } from 'lucide-react';
import type { ImportanceLevel } from '@guardia/shared';
import { AI_STATUS, categoryLabel, formatSince, formatTime, formatWait, IMPORTANCE, STATUS } from '@/lib/labels';
import { lastReportAt, selectQueue, useStore, type AnyAlert, type SortMode } from '@/lib/store';
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

const SORT_LABEL: Record<SortMode, string> = {
  newest: 'Más nuevas primero',
  importance: 'Importancia',
  oldest: 'Más antiguas primero',
};

/** Color de la franja lateral y de la etiqueta según la importancia de la situación. */
export const LEVEL_STYLE: Record<ImportanceLevel, { bar: string; chip: string }> = {
  CRITICA: { bar: 'bg-high', chip: 'bg-high/15 text-high border-high/40' },
  ALTA: { bar: 'bg-medium', chip: 'bg-medium/15 text-medium border-medium/40' },
  MEDIA: { bar: 'bg-accent', chip: 'bg-accent/15 text-accent border-accent/40' },
  BAJA: { bar: 'bg-line-strong', chip: 'bg-surface-2 text-ink-muted border-line' },
};

export function AlertQueue() {
  // Selectores primitivos + useMemo: un selector que devuelve un array nuevo en cada render
  // haría que useSyncExternalStore vuelva a renderizar sin fin.
  const alerts = useStore((s) => s.alerts);
  const typeFilter = useStore((s) => s.typeFilter);
  const showClosed = useStore((s) => s.showClosed);
  const prefs = useStore((s) => s.prefs);
  const setSort = useStore((s) => s.setSort);
  const queue = useMemo(() => selectQueue({ alerts, typeFilter, showClosed, prefs }), [alerts, typeFilter, showClosed, prefs]);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const fresh = useStore((s) => s.fresh);
  const loaded = useStore((s) => s.loaded);
  const now = useNow();
  const selectedIncident = selectedId ? alerts[selectedId]?.incident?.id : undefined;
  // Audio y foto de cualquier reporte del grupo: la tarjeta muestra la primera alerta, pero el audio
  // puede venir en otra (p. ej. SOS por botón y, al minuto, el mismo vecino por voz).
  const groupMedia = useMemo(() => {
    const m = new Map<string, { audio: boolean; photo: boolean }>();
    for (const a of Object.values(alerts)) {
      if (!a.incident) continue;
      const e = m.get(a.incident.id) ?? { audio: false, photo: false };
      m.set(a.incident.id, { audio: e.audio || a.hasAudio, photo: e.photo || a.hasPhoto });
    }
    return m;
  }, [alerts]);

  const pendingUrgent = useMemo(
    () => queue.items.filter((a) => a.status === 'PENDING' && (a.type === 'EMERGENCY_SOS' || a.incident?.level === 'CRITICA')).length,
    [queue.items],
  );

  return (
    <section aria-label="Cola de alertas" className="flex flex-col h-full border-r border-line bg-surface">
      <div className="shrink-0 px-4 py-2 border-b border-line text-sm space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{showClosed ? 'Cerradas' : 'Activas'}</span>
          <span className="text-ink-muted tabular-nums" title="Situaciones (los reportes repetidos se agrupan)">
            {queue.items.length}
            {!showClosed && queue.reports > queue.items.length ? <span className="text-ink-faint"> · {queue.reports} reportes</span> : null}
          </span>
          {pendingUrgent > 0 ? (
            <span className="ml-auto inline-flex items-center gap-1 text-high">
              <ShieldAlert size={14} />
              {pendingUrgent} sin acusar
            </span>
          ) : null}
        </div>
        {!showClosed ? (
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            Ordenar por
            <select
              value={prefs.sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              className="h-7 px-1.5 rounded-ctl bg-bg border border-line text-xs text-ink"
              data-testid="queue-sort"
            >
              {(Object.keys(SORT_LABEL) as SortMode[]).map((m) => (
                <option key={m} value={m}>
                  {SORT_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <ul className="flex-1 overflow-y-auto gi-scroll">
        {!loaded ? (
          <li className="p-4 text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando alertas
          </li>
        ) : queue.items.length === 0 ? (
          <li className="p-6 text-sm text-ink-muted">
            {showClosed ? 'No hay alertas cerradas con este filtro.' : 'Sin alertas activas. Las nuevas aparecen aquí al instante.'}
          </li>
        ) : (
          queue.items.map((a) => (
            <AlertRow
              key={a.id}
              alert={a}
              grouped={!showClosed}
              media={!showClosed && a.incident ? groupMedia.get(a.incident.id) : undefined}
              selected={a.id === selectedId || (!showClosed && !!a.incident && a.incident.id === selectedIncident)}
              fresh={a.id in fresh}
              now={now}
              onSelect={() => select(a.id)}
            />
          ))
        )}
      </ul>
    </section>
  );
}

function AlertRow({
  alert,
  grouped,
  media,
  selected,
  fresh,
  now,
  onSelect,
}: {
  alert: AnyAlert;
  grouped: boolean;
  media?: { audio: boolean; photo: boolean };
  selected: boolean;
  fresh: boolean;
  now: number;
  onSelect: () => void;
}) {
  const inc = grouped ? alert.incident : null;
  const level = alert.incident?.level ?? null;
  const urgent = alert.status === 'PENDING' && (alert.type === 'EMERGENCY_SOS' || level === 'CRITICA');
  const ageS = (now - new Date(alert.createdAt).getTime()) / 1000;
  const ageTone = alert.status !== 'PENDING' ? 'text-ink-muted' : ageS > 120 && urgent ? 'text-high' : ageS > 60 && urgent ? 'text-medium' : 'text-ink-muted';
  const bar = level ? LEVEL_STYLE[level].bar : alert.type === 'EMERGENCY_SOS' ? 'bg-high' : 'bg-line-strong';
  const lowTrust = alert.citizenTrustScore !== null && alert.citizenTrustScore < 50;
  const last = lastReportAt(alert);
  const repeated = !!inc && inc.alertCount > 1;

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
          <span className="text-sm font-medium truncate">
            {categoryLabel(alert.category, alert.type === 'EMERGENCY_SOS' ? 'SOS sin clasificar' : 'Reporte sin clasificar')}
          </span>
          <span className={`ml-auto shrink-0 text-sm tabular-nums ${ageTone}`} title={`Llegó a las ${formatTime(alert.createdAt)}`}>
            {formatWait(alert.createdAt, now)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-muted min-w-0">
          <span className="truncate">{STATUS[alert.status]}</span>
          {repeated ? (
            <span className="inline-flex items-center gap-1 text-ink shrink-0" title={`${inc.alertCount} reportes de ${inc.citizenCount} vecinos`}>
              <Users size={12} aria-hidden />×{inc.alertCount}
              {inc.citizenCount > 1 ? <span className="text-ink-muted">· {inc.citizenCount} vecinos</span> : null}
            </span>
          ) : null}
          {inc && inc.recurrenceCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-medium shrink-0" title="Ya se había resuelto en este lugar y volvió">
              <Repeat size={12} aria-hidden />
              Recurrente
            </span>
          ) : null}
          {alert.aiStatus === 'QUEUED' || alert.aiStatus === 'PROCESSING' ? (
            <span className="inline-flex items-center gap-1 shrink-0">
              <Spinner className="h-2.5 w-2.5" /> {AI_STATUS[alert.aiStatus]}
            </span>
          ) : null}
          {alert.hasAudio || media?.audio ? <Mic size={12} aria-label="Con audio" className="shrink-0" /> : null}
          {alert.hasPhoto || media?.photo ? <Camera size={12} aria-label="Con foto" className="shrink-0" /> : null}
          {lowTrust ? <span className="text-medium shrink-0">Baja confianza</span> : null}
          <span className="ml-auto inline-flex items-center gap-1.5 shrink-0">
            {fresh ? <span className="text-accent">Nueva</span> : null}
            {level ? (
              <span
                className={`inline-flex items-center h-5 px-1.5 rounded-ctl border text-[11px] ${LEVEL_STYLE[level].chip}`}
                title={`Importancia ${alert.incident!.importance} de 100`}
              >
                {IMPORTANCE[level]}
              </span>
            ) : null}
          </span>
        </div>
        {repeated && last !== alert.createdAt ? <p className="mt-1 text-xs text-ink-faint">Último reporte {formatSince(last, now)}</p> : null}
        {alert.aiSummary ? <p className="mt-1 text-xs text-ink-muted truncate">{alert.aiSummary}</p> : null}
      </button>
    </li>
  );
}
