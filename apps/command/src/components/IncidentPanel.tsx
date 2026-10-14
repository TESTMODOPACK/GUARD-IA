'use client';

import type { AlertDetail } from '@guardia/shared';
import { Camera, Mic, Repeat, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { categoryLabel, formatSince, IMPORTANCE, IMPORTANCE_REASON, SOURCE, STATUS } from '@/lib/labels';
import { useStore, type AnyAlert } from '@/lib/store';
import { LEVEL_STYLE } from './AlertQueue';
import { Button, Spinner } from './ui';

/**
 * Transcripción del audio, a la vista del operador apenas está lista. Si no hay, dice por qué:
 * en curso, IA en modo de prueba (sin servicio de voz configurado) o audio sin habla clara.
 */
export function Transcript({ detail }: { detail: AlertDetail }) {
  if (!detail.hasAudio) return null;
  const busy = detail.aiStatus === 'QUEUED' || detail.aiStatus === 'PROCESSING';
  const lastAi = [...detail.events].reverse().find((e) => e.kind === 'AI_PROCESSED' || e.kind === 'AI_FAILED');
  const mock = lastAi?.payload?.provider === 'mock';

  return (
    <section className="rounded-ctl border border-line p-3" aria-live="polite">
      <h3 className="text-sm font-medium">Transcripción del audio</h3>
      {detail.transcription ? (
        <blockquote className="mt-2 text-sm border-l-2 border-accent/60 pl-3 whitespace-pre-wrap">{detail.transcription}</blockquote>
      ) : busy ? (
        <p className="mt-2 text-sm text-ink-muted flex items-center gap-2">
          <Spinner className="h-3 w-3" /> Transcribiendo… escucha el audio mientras tanto.
        </p>
      ) : mock ? (
        <p className="mt-2 text-sm text-medium">
          Sin transcripción: la IA está en modo de prueba (no hay servicio de voz configurado). Escucha el audio.
        </p>
      ) : detail.aiStatus === 'FAILED' ? (
        <p className="mt-2 text-sm text-medium">No se pudo transcribir. Escucha el audio.</p>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">El audio no tenía habla clara (ruido o silencio). Escúchalo para confirmar.</p>
      )}
    </section>
  );
}

/**
 * La situación a la que pertenece la alerta: cuántos reportes y vecinos, recurrencia, por qué tiene
 * esa importancia y los demás reportes del grupo. Permite separar una alerta mal agrupada.
 */
export function IncidentPanel({ alert }: { alert: AnyAlert }) {
  const inc = alert.incident;
  const alerts = useStore((s) => s.alerts);
  const select = useStore((s) => s.select);
  const upsertAlert = useStore((s) => s.upsertAlert);
  const notify = useStore((s) => s.notify);
  const canOperate = useStore((s) => s.viewer?.canOperate ?? true);
  const [busy, setBusy] = useState(false);
  const members = useMemo(
    () =>
      inc
        ? Object.values(alerts)
            .filter((a) => a.incident?.id === inc.id && a.id !== alert.id)
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        : [],
    [alerts, inc, alert.id],
  );
  if (!inc) return null;
  const now = Date.now();
  const grouped = inc.alertCount > 1;
  const withAudio = !alert.hasAudio ? members.find((m) => m.hasAudio) : undefined;

  const detach = async () => {
    setBusy(true);
    try {
      upsertAlert(await api.detach(alert.id));
      notify('ok', 'Alerta separada: ahora es una situación aparte');
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-ctl border border-line p-3 space-y-2" data-testid="incident-panel">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Importancia</h3>
        <span className={`inline-flex items-center h-6 px-2 rounded-ctl border text-xs ${LEVEL_STYLE[inc.level].chip}`}>
          {IMPORTANCE[inc.level]} · {inc.importance}/100
        </span>
      </div>
      {grouped && inc.category && inc.category !== alert.category ? (
        <p className="text-sm">
          <span className="text-ink-muted">La situación se clasificó como </span>
          <span className="font-medium">{categoryLabel(inc.category)}</span>
          {inc.summary ? <span className="text-ink-muted"> · {inc.summary}</span> : null}
        </p>
      ) : null}
      {inc.reasons.length ? (
        <ul className="text-xs text-ink-muted list-disc pl-4 space-y-0.5">
          {inc.reasons.map((r) => (
            <li key={r}>{IMPORTANCE_REASON[r]}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-muted">Un solo reporte, sin señales de riesgo.</p>
      )}

      {grouped || inc.recurrenceCount > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {grouped ? (
            <span className="inline-flex items-center gap-1.5">
              <Users size={14} className="text-ink-muted" aria-hidden />
              {inc.alertCount} reportes de {inc.citizenCount} {inc.citizenCount === 1 ? 'vecino' : 'vecinos'}
              <span className="text-ink-muted">· último {formatSince(inc.lastAlertAt, now)}</span>
            </span>
          ) : null}
          {inc.recurrenceCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-medium">
              <Repeat size={14} aria-hidden />
              Recurrente: ya se resolvió aquí {inc.recurrenceCount === 1 ? '1 vez' : `${inc.recurrenceCount} veces`} en 90 días
            </span>
          ) : null}
        </div>
      ) : null}

      {withAudio ? (
        <div className="flex items-center gap-2 rounded-ctl border border-accent/40 bg-accent/10 px-2.5 py-2 text-sm">
          <Mic size={14} className="text-accent shrink-0" aria-hidden />
          <span>Otro reporte de esta situación tiene audio.</span>
          <button className="ml-auto text-accent hover:underline shrink-0" onClick={() => select(withAudio.id)}>
            Escuchar
          </button>
        </div>
      ) : null}

      {members.length ? (
        <div>
          <h4 className="text-xs text-ink-muted mb-1">Otros reportes de esta situación</h4>
          <ul className="space-y-1">
            {members.map((m) => (
              <li key={m.id}>
                <button onClick={() => select(m.id)} className="w-full text-left text-xs flex items-center gap-2 rounded-ctl px-2 py-1 hover:bg-surface-2">
                  <span className="truncate">
                    {categoryLabel(m.category, m.type === 'EMERGENCY_SOS' ? 'SOS' : 'Reporte')} por {SOURCE[m.source]}
                  </span>
                  {m.hasAudio ? <Mic size={12} className="text-accent shrink-0" aria-label="Con audio" /> : null}
                  {m.hasPhoto ? <Camera size={12} className="text-ink-muted shrink-0" aria-label="Con foto" /> : null}
                  <span className="text-ink-muted shrink-0">{STATUS[m.status]}</span>
                  <span className="ml-auto text-ink-faint shrink-0">{formatSince(m.createdAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {grouped && canOperate ? (
        <Button variant="ghost" className="h-8 px-2 text-xs" busy={busy} onClick={() => void detach()} data-testid="action-detach">
          No es la misma situación: separar este reporte
        </Button>
      ) : null}
    </section>
  );
}
