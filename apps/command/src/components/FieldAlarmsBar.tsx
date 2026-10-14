'use client';

import { AlertTriangle, MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FieldAlarm } from '@guardia/shared';
import { api, ApiRequestError } from '@/lib/api';
import { FIELD_ALARM, formatTime } from '@/lib/labels';
import { ping } from '@/lib/sound';
import { useStore } from '@/lib/store';
import { Button } from './ui';

const ORDER: Record<FieldAlarm['kind'], number> = { PANIC: 0, SUPPORT: 1, NO_NEWS: 2, LATE: 3 };

/**
 * Avisos de terreno (0012) arriba de la central: pánico del funcionario, pedido de apoyo y plazos vencidos. Quedan
 * hasta que un operador los atiende; un pánico abierto vuelve a sonar cada 15 s. La posición se muestra en
 * coordenadas (la unidad ya aparece en el mapa de la central); no se envía a servicios externos.
 */
export function FieldAlarmsBar() {
  const alarmsMap = useStore((s) => s.fieldAlarms);
  const select = useStore((s) => s.select);
  const notify = useStore((s) => s.notify);
  const upsert = useStore((s) => s.upsertFieldAlarm);
  // El apoyo administrativo ve los avisos de terreno; los atiende quien opera (0013).
  const canOperate = useStore((s) => s.viewer?.canOperate ?? true);
  const alarms = useMemo(
    () => Object.values(alarmsMap).sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.createdAt.localeCompare(a.createdAt)),
    [alarmsMap],
  );
  const panicOpen = alarms.some((a) => a.kind === 'PANIC');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!panicOpen) return;
    const t = setInterval(() => ping('panic'), 15_000);
    return () => clearInterval(t);
  }, [panicOpen]);

  if (alarms.length === 0) return null;

  const ack = async (a: FieldAlarm) => {
    setBusy(a.id);
    try {
      upsert(await api.ackFieldAlarm(a.id));
    } catch (e) {
      notify('error', e instanceof ApiRequestError ? e.message : 'No se pudo marcar como atendido');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Avisos de terreno" className="shrink-0 border-b border-line bg-surface-2 max-h-48 overflow-y-auto">
      {alarms.map((a) => {
        const panic = a.kind === 'PANIC';
        return (
          <div
            key={a.id}
            role={panic ? 'alert' : 'status'}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm border-b border-line last:border-b-0 ${
              panic ? 'bg-high/15 text-high' : a.kind === 'SUPPORT' ? 'text-high' : 'text-medium'
            }`}
          >
            <AlertTriangle size={16} aria-hidden className="shrink-0" />
            <span className="font-semibold">{FIELD_ALARM[a.kind]}</span>
            <span className="text-ink">{[a.unitCode, a.operatorName].filter(Boolean).join(' · ') || 'Unidad sin identificar'}</span>
            <span className="text-ink-muted tabular-nums">{formatTime(a.createdAt)}</span>
            {a.note ? <span className="text-ink">“{a.note}”</span> : null}
            {a.location ? (
              <span className="inline-flex items-center gap-1 text-ink-muted tabular-nums">
                <MapPin size={14} aria-hidden />
                {a.location.lat.toFixed(5)}, {a.location.lng.toFixed(5)}
              </span>
            ) : null}
            <span className="ml-auto flex gap-2">
              {a.alertId ? (
                <Button variant="ghost" className="h-8" onClick={() => select(a.alertId)}>
                  Ver caso
                </Button>
              ) : null}
              {canOperate ? (
                <Button variant={panic ? 'danger' : 'quiet'} className="h-8" busy={busy === a.id} onClick={() => void ack(a)}>
                  Atendido
                </Button>
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}
