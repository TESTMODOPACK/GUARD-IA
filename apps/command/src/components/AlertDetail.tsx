'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Phone, X } from 'lucide-react';
import type { AlertCategory, AlertDetail as AlertDetailT, Dispatch, DispatchStatus, Priority } from '@guardia/shared';
import { api } from '@/lib/api';
import {
  AGENCY,
  AI_STATUS,
  CATEGORY,
  categoryLabel,
  DISPATCH_STATUS,
  EVENT_KIND,
  FLAG,
  formatAge,
  formatDateTime,
  formatTime,
  PRIORITY,
  SOURCE,
  STATUS,
} from '@/lib/labels';
import { isDetail, useStore } from '@/lib/store';
import { useNow } from './AlertQueue';
import { AudioPlayer } from './AudioPlayer';
import { DispatchDialog, RejectDialog, ResolveDialog } from './Dialogs';
import { Button, PriorityDot, Spinner, Tag, textareaClass } from './ui';

export function AlertDetailPanel() {
  const selectedId = useStore((s) => s.selectedId);
  const alert = useStore((s) => (selectedId ? s.alerts[selectedId] : undefined));
  const upsertAlert = useStore((s) => s.upsertAlert);
  const select = useStore((s) => s.select);
  const clearFresh = useStore((s) => s.clearFresh);
  const notify = useStore((s) => s.notify);
  const units = useStore((s) => s.units);
  const now = useNow();

  const [dialog, setDialog] = useState<'dispatch' | 'reject' | 'resolve' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');

  // Al seleccionar, pedir la ficha completa (media firmada, eventos, despachos).
  useEffect(() => {
    if (!selectedId) return;
    clearFresh(selectedId);
    let cancelled = false;
    api
      .alert(selectedId)
      .then((d) => {
        if (!cancelled) upsertAlert(d);
      })
      .catch((e: Error) => notify('error', `No se pudo cargar la alerta: ${e.message}`));
    return () => {
      cancelled = true;
    };
  }, [selectedId, upsertAlert, clearFresh, notify]);

  if (!selectedId || !alert) {
    return (
      <aside className="h-full border-l border-line bg-surface flex items-center justify-center p-6 text-sm text-ink-muted text-center">
        Selecciona una alerta en la cola o en el mapa para ver el detalle y actuar.
      </aside>
    );
  }

  const detail: AlertDetailT | null = isDetail(alert) ? alert : null;
  const audio = detail?.media.find((m) => m.kind === 'AUDIO');
  const photo = detail?.media.find((m) => m.kind === 'PHOTO');
  const openDispatch = detail?.dispatches.find((d) => ['ASSIGNED', 'EN_ROUTE', 'ON_SITE'].includes(d.status)) ?? null;
  const lowTrust = alert.citizenTrustScore !== null && alert.citizenTrustScore < 50;

  /** Recarga la ficha sin fallar: la acción ya se hizo y el WS también la trae. */
  const refreshDetail = (id: string) =>
    api
      .alert(id)
      .then((d) => upsertAlert(d))
      .catch(() => undefined);

  const run = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'events' in (r as object)) upsertAlert(r as AlertDetailT);
      notify('ok', okText);
    } catch (e) {
      notify('error', (e as Error).message);
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const canAck = alert.status === 'PENDING';
  const canDispatch = alert.status === 'PENDING' || alert.status === 'ACKNOWLEDGED';
  const canReject = alert.status === 'PENDING' || alert.status === 'ACKNOWLEDGED';
  const canResolve = ['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'].includes(alert.status);

  return (
    <aside aria-label="Detalle de la alerta" className="h-full border-l border-line bg-surface flex flex-col min-h-0">
      <div className="px-4 pt-3 pb-2 border-b border-line">
        <div className="flex items-start gap-2">
          <PriorityDot priority={alert.priority} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight">
              {categoryLabel(alert.category, alert.type === 'EMERGENCY_SOS' ? 'SOS sin clasificar' : 'Reporte sin clasificar')}
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {alert.type === 'EMERGENCY_SOS' ? 'SOS' : 'Reporte urbano'} por {SOURCE[alert.source]} · hace {formatAge(alert.createdAt, now)}
            </p>
          </div>
          <Button variant="ghost" aria-label="Cerrar detalle" onClick={() => select(null)} className="h-8 px-2 -mr-2">
            <X size={16} />
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Tag tone={alert.status === 'PENDING' ? 'high' : alert.status === 'DISPATCHED' ? 'accent' : alert.status === 'RESOLVED' ? 'ok' : 'neutral'}>
            {STATUS[alert.status]}
          </Tag>
          {alert.priority ? <Tag tone={alert.priority === 'HIGH' ? 'high' : alert.priority === 'MEDIUM' ? 'medium' : 'low'}>Prioridad {PRIORITY[alert.priority].toLowerCase()}</Tag> : null}
          {alert.suggestedAgency ? <Tag>Sugerido: {AGENCY[alert.suggestedAgency]}</Tag> : null}
          {lowTrust ? <Tag tone="medium">Vecino con baja confianza ({alert.citizenTrustScore})</Tag> : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto gi-scroll px-4 py-3 space-y-5">
        {/* Acciones */}
        <div className="flex flex-wrap gap-2" data-testid="alert-actions">
          {canAck ? (
            <Button variant="quiet" busy={busy === 'ack'} onClick={() => run('ack', () => api.ack(alert.id), 'Recibo acusado')} data-testid="action-ack">
              Acusar recibo
            </Button>
          ) : null}
          {canDispatch ? (
            <Button variant="primary" onClick={() => setDialog('dispatch')} data-testid="action-dispatch">
              Despachar unidad
            </Button>
          ) : null}
          {openDispatch ? <DispatchControls dispatch={openDispatch} busy={busy} run={run} /> : null}
          {canResolve ? (
            <Button variant="quiet" onClick={() => setDialog('resolve')} data-testid="action-resolve">
              Resolver
            </Button>
          ) : null}
          {canReject ? (
            <Button variant="danger" onClick={() => setDialog('reject')} data-testid="action-reject">
              Rechazar
            </Button>
          ) : null}
        </div>

        {/* Audio y foto */}
        {!detail ? (
          <p className="text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando ficha
          </p>
        ) : (
          <>
            {audio ? (
              <section>
                <h3 className="text-xs text-ink-muted mb-1.5">Audio del vecino</h3>
                <AudioPlayer media={audio} />
              </section>
            ) : null}
            {photo?.url ? (
              <section>
                <h3 className="text-xs text-ink-muted mb-1.5">Foto</h3>
                <img src={photo.url} alt="Foto enviada por el vecino" className="rounded-ctl border border-line max-h-56 object-cover" />
              </section>
            ) : null}

            {/* Ficha IA */}
            <section className="rounded-ctl border border-line bg-bg/60 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Análisis de IA</h3>
                <span className="text-xs text-ink-muted inline-flex items-center gap-1">
                  {detail.aiStatus === 'PROCESSING' || detail.aiStatus === 'QUEUED' ? <Spinner className="h-2.5 w-2.5" /> : null}
                  {AI_STATUS[detail.aiStatus]}
                  {detail.aiConfidence !== null ? ` · confianza ${Math.round(detail.aiConfidence * 100)} %` : ''}
                </span>
              </div>
              {detail.aiSummary ? <p className="mt-2 text-sm">{detail.aiSummary}</p> : null}
              {detail.transcription ? (
                <blockquote className="mt-2 text-sm text-ink-muted border-l-2 border-line-strong pl-3 whitespace-pre-wrap">{detail.transcription}</blockquote>
              ) : detail.hasAudio && detail.aiStatus === 'DONE' ? (
                <p className="mt-2 text-sm text-ink-muted">El audio no tenía habla inteligible.</p>
              ) : null}
              {detail.userText ? (
                <p className="mt-2 text-sm">
                  <span className="text-ink-muted">Escribió: </span>
                  {detail.userText}
                </p>
              ) : null}
              {detail.aiFlags ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(detail.aiFlags)
                    .filter(([, v]) => v)
                    .map(([k]) => (
                      <Tag key={k} tone={k === 'possible_false_alarm' ? 'medium' : 'high'}>
                        {FLAG[k] ?? k}
                      </Tag>
                    ))}
                </div>
              ) : null}
              {detail.aiError ? <p className="mt-2 text-xs text-medium">{detail.aiError}</p> : null}
            </section>

            {/* Vecino y ubicación */}
            <section className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <h3 className="text-xs text-ink-muted mb-1">Vecino</h3>
                <p>{detail.citizenName ?? 'Sin nombre'}</p>
                {detail.citizenPhone ? (
                  <a href={`tel:${detail.citizenPhone}`} className="inline-flex items-center gap-1 text-accent hover:underline">
                    <Phone size={13} /> {detail.citizenPhone}
                  </a>
                ) : null}
                <p className="text-xs text-ink-muted mt-1">Confianza {detail.citizenTrustScore ?? '—'} / 100</p>
              </div>
              <div>
                <h3 className="text-xs text-ink-muted mb-1">Ubicación</h3>
                <p className="tabular-nums">
                  {detail.location.lat.toFixed(5)}, {detail.location.lng.toFixed(5)}
                </p>
                <p className="text-xs text-ink-muted">{detail.accuracyM !== null ? `Precisión ±${Math.round(detail.accuracyM)} m` : 'Precisión desconocida'}</p>
                <a
                  href={`https://www.google.com/maps?q=${detail.location.lat},${detail.location.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline text-xs mt-1"
                >
                  <ExternalLink size={12} /> Abrir en Google Maps
                </a>
              </div>
            </section>

            {/* Despachos */}
            {detail.dispatches.length > 0 ? (
              <section>
                <h3 className="text-xs text-ink-muted mb-1.5">Despachos</h3>
                <ul className="space-y-1 text-sm">
                  {detail.dispatches.map((d) => (
                    <li key={d.id} className="flex items-center gap-2">
                      <span className="font-medium">{d.unitCode}</span>
                      <Tag tone={d.status === 'CLOSED' ? 'ok' : d.status === 'CANCELLED' ? 'neutral' : 'accent'}>{DISPATCH_STATUS[d.status]}</Tag>
                      <span className="ml-auto text-xs text-ink-muted tabular-nums">{formatTime(d.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* Nota */}
            <section>
              <h3 className="text-xs text-ink-muted mb-1.5">Agregar nota</h3>
              <textarea
                className={textareaClass}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Ej.: se derivó a Carabineros por teléfono a las 14:32"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  variant="quiet"
                  disabled={!note.trim()}
                  busy={busy === 'note'}
                  onClick={async () => {
                    const text = note.trim();
                    try {
                      await run('note', () => api.note(alert.id, text), 'Nota guardada');
                    } catch {
                      return; // `run` ya avisó; el texto queda para reintentar.
                    }
                    setNote('');
                    void refreshDetail(alert.id);
                  }}
                >
                  Guardar nota
                </Button>
              </div>
            </section>

            {/* Línea de tiempo */}
            <section>
              <h3 className="text-xs text-ink-muted mb-1.5">Línea de tiempo</h3>
              <ol className="space-y-2 text-sm">
                {detail.events.map((ev) => (
                  <li key={ev.id} className="flex gap-3">
                    <span className="text-xs text-ink-muted tabular-nums w-16 shrink-0 pt-0.5">{formatTime(ev.createdAt)}</span>
                    <div className="min-w-0">
                      <p>{EVENT_KIND[ev.kind]}</p>
                      <EventDetail kind={ev.kind} payload={ev.payload} />
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-ink-faint">Recibida el {formatDateTime(detail.createdAt)}</p>
            </section>
          </>
        )}
      </div>

      {dialog === 'dispatch' ? (
        <DispatchDialog
          units={Object.values(units)}
          onClose={() => setDialog(null)}
          onConfirm={async (unitId, notes) => {
            // Si solo falla la recarga, el despacho igual quedó hecho: no mostrarlo como error.
            await run('dispatch', () => api.dispatch(alert.id, unitId, notes), 'Unidad despachada');
            void refreshDetail(alert.id);
          }}
        />
      ) : null}
      {dialog === 'reject' ? (
        <RejectDialog onClose={() => setDialog(null)} onConfirm={(reason, notes) => run('reject', () => api.reject(alert.id, reason, notes), 'Alerta rechazada')} />
      ) : null}
      {dialog === 'resolve' ? (
        <ResolveDialog onClose={() => setDialog(null)} onConfirm={(notes) => run('resolve', () => api.resolve(alert.id, notes), 'Alerta resuelta')} />
      ) : null}
    </aside>
  );
}

const NEXT_DISPATCH: Partial<Record<DispatchStatus, { to: DispatchStatus; label: string }>> = {
  ASSIGNED: { to: 'EN_ROUTE', label: 'Marcar en camino' },
  EN_ROUTE: { to: 'ON_SITE', label: 'Marcar en el lugar' },
};

function DispatchControls({
  dispatch,
  busy,
  run,
}: {
  dispatch: Dispatch;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>, okText: string) => Promise<void>;
}) {
  const upsertAlert = useStore((s) => s.upsertAlert);
  const next = NEXT_DISPATCH[dispatch.status];
  // `run` ya avisó del error; aquí solo se evita una promesa rechazada sin capturar.
  const refresh = () =>
    api
      .alert(dispatch.alertId)
      .then((d) => upsertAlert(d))
      .catch(() => undefined);
  return (
    <>
      {next ? (
        <Button
          variant="quiet"
          busy={busy === 'dispatch-next'}
          onClick={() => run('dispatch-next', () => api.updateDispatch(dispatch.id, next.to), `${dispatch.unitCode}: ${DISPATCH_STATUS[next.to].toLowerCase()}`).then(refresh, () => undefined)}
        >
          {next.label} ({dispatch.unitCode})
        </Button>
      ) : null}
      <Button
        variant="ghost"
        busy={busy === 'dispatch-cancel'}
        onClick={() => run('dispatch-cancel', () => api.updateDispatch(dispatch.id, 'CANCELLED'), `Despacho de ${dispatch.unitCode} cancelado`).then(refresh, () => undefined)}
      >
        Cancelar despacho
      </Button>
    </>
  );
}

function EventDetail({ kind, payload }: { kind: string; payload: Record<string, unknown> }) {
  const p = payload as Record<string, string | number | boolean | null | undefined>;
  let text: string | null = null;
  switch (kind) {
    case 'NOTE':
      text = String(p.text ?? '');
      break;
    case 'DISPATCHED':
      text = `${p.unitCode ?? ''}${p.notes ? ` · ${p.notes}` : ''}`;
      break;
    case 'DISPATCH_STATUS':
      text = `${p.unitCode ?? ''} ${p.status ? DISPATCH_STATUS[p.status as DispatchStatus]?.toLowerCase() ?? p.status : ''}${p.revertedToAck ? ' · la alerta vuelve a revisión' : ''}`;
      break;
    case 'REJECTED':
      text = `${p.reason ?? ''}${p.notes ? ` · ${p.notes}` : ''}`;
      break;
    case 'RESOLVED':
      text = p.notes ? String(p.notes) : null;
      break;
    case 'AI_PROCESSED':
      text = p.skipped
        ? 'Sin audio ni texto que analizar'
        : `${CATEGORY[p.category as AlertCategory] ?? p.category ?? ''} · prioridad ${(PRIORITY[p.priority as Priority] ?? String(p.priority ?? '')).toLowerCase()}${p.loweredByTrust ? ' (bajada por confianza del vecino)' : ''}`;
      break;
    case 'CREATED':
      text = `${p.hasAudio ? 'con audio' : 'sin audio'}${p.accuracyM ? ` · ±${Math.round(Number(p.accuracyM))} m` : ''}`;
      break;
    case 'PUSH_SENT':
      text = p.ok ? `${p.devices} dispositivo(s)` : 'el push no llegó; el vecino lo verá al abrir la app';
      break;
  }
  return text ? <p className="text-xs text-ink-muted whitespace-pre-wrap">{text}</p> : null;
}
