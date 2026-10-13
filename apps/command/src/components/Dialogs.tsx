'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AlertCategory, AlertType, CitizenStanding, DispatchOutcome, RecordOutcome, RejectReason, Unit } from '@guardia/shared';
import { DISPATCH_OUTCOMES, SUBCATEGORIES, categoriesFor } from '@guardia/shared';
import { api } from '@/lib/api';
import {
  CATEGORY,
  DISPATCH_OUTCOME,
  DISPATCH_OUTCOME_HELP,
  formatDateTime,
  ordinal,
  REJECT_REASON,
  REJECT_REASON_HELP,
  REJECT_REASON_ORDER,
  subcategoryLabel,
  UNIT_STATUS,
} from '@/lib/labels';
import { Button, Dialog, Field, inputClass, textareaClass } from './ui';

/** Patrullas primero: para un SOS son la respuesta por defecto; motos e inspectores después. */
const KIND_RANK: Record<string, number> = { PATRULLA: 0, MOTO: 1, INSPECTOR: 2 };

export function DispatchDialog({
  units,
  onConfirm,
  onClose,
}: {
  units: Unit[];
  onConfirm: (unitId: string, notes?: string) => Promise<void>;
  onClose: () => void;
}) {
  const available = useMemo(
    () =>
      units
        .filter((u) => u.status === 'AVAILABLE')
        .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.code.localeCompare(b.code)),
    [units],
  );
  const [unitId, setUnitId] = useState(available[0]?.id ?? '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!unitId) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(unitId, notes.trim() || undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Despachar unidad" onClose={onClose} busy={busy}>
      {available.length === 0 ? (
        <p className="text-sm text-ink-muted">No hay unidades disponibles. Libera una en el panel de unidades o cierra un despacho.</p>
      ) : (
        <div className="space-y-4">
          <Field label="Unidad">
            <select className={inputClass} value={unitId} onChange={(e) => setUnitId(e.target.value)} data-testid="dispatch-unit">
              {available.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {UNIT_STATUS[u.status]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Instrucciones para la unidad (opcional)">
            <textarea className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: acceso por calle lateral, vecino espera en el portón" />
          </Field>
          {error ? <p role="alert" className="text-sm text-high">{error}</p> : null}
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" onClick={submit} busy={busy} disabled={!unitId} data-testid="dispatch-confirm">
          Despachar
        </Button>
      </div>
    </Dialog>
  );
}

/** Una falta exige evidencia escrita (misma regla que la API). */
const MIN_EVIDENCE = 10;

/**
 * Rechazar sin sancionar por error (docs/plan-plataforma.md §5b): ningún motivo viene marcado, cada uno
 * dice su efecto, y el aviso falso intencional exige evidencia y muestra la consecuencia antes de confirmar.
 */
export function RejectDialog({
  alertId,
  initial,
  onConfirm,
  onClose,
}: {
  alertId: string;
  /** Precarga desde "falsa alarma confirmada" en terreno; el operador igual confirma. */
  initial?: { reason: RejectReason; notes: string };
  onConfirm: (reason: RejectReason, notes?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<RejectReason | null>(initial?.reason ?? null);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [standing, setStanding] = useState<CitizenStanding | null>(null);

  useEffect(() => {
    let live = true;
    api
      .citizenStanding(alertId)
      .then((s) => {
        if (live) setStanding(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [alertId]);

  const falseAlarm = reason === 'FALSE_ALARM';
  const evidenceOk = !falseAlarm || notes.trim().length >= MIN_EVIDENCE;
  const nextStrike = (standing?.activeStrikes ?? 0) + 1;
  const lastTest = standing?.recentRejections.find((r) => r.reason === 'TEST');

  const submit = async () => {
    if (!reason || !evidenceOk) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason, notes.trim() || undefined);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Rechazar alerta" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        {standing && (standing.activeStrikes > 0 || standing.recentRejections.length > 0) ? (
          <div className="rounded-ctl border border-line bg-bg/60 px-3 py-2 text-xs" data-testid="citizen-standing">
            {standing.activeStrikes > 0 ? (
              <p className="text-medium">
                Este vecino tiene {standing.activeStrikes} {standing.activeStrikes === 1 ? 'aviso falso' : 'avisos falsos'} en 90 días
                {standing.strikesByTenant.length ? ` (${standing.strikesByTenant.map((t) => `${t.tenantName}: ${t.count}`).join(', ')})` : ''}.
              </p>
            ) : null}
            {standing.recentRejections.length ? (
              <p className="text-ink-muted mt-0.5">
                Rechazos recientes aquí:{' '}
                {standing.recentRejections
                  .slice(0, 4)
                  .map((r) => `${REJECT_REASON[r.reason].toLowerCase()} (${formatDateTime(r.at)})`)
                  .join(' · ')}
              </p>
            ) : null}
            {lastTest ? <p className="text-ink-muted mt-0.5">Ya tuvo un rechazo por prueba: si vuelve a pasar, corresponde aviso falso.</p> : null}
          </div>
        ) : null}

        <fieldset className="space-y-1.5" data-testid="reject-reasons">
          <legend className="text-xs text-ink-muted mb-1">Motivo</legend>
          {REJECT_REASON_ORDER.map((r) => (
            <label
              key={r}
              className={`flex gap-2 rounded-ctl border px-2.5 py-1.5 text-sm cursor-pointer ${reason === r ? 'border-accent bg-accent/10' : 'border-line'}`}
            >
              <input type="radio" name="reject-reason" className="mt-1" checked={reason === r} onChange={() => setReason(r)} data-testid={`reason-${r}`} />
              <span className="min-w-0">
                <span className={r === 'FALSE_ALARM' ? 'font-medium text-high' : 'font-medium'}>{REJECT_REASON[r]}</span>
                <span className="block text-xs text-ink-muted">{REJECT_REASON_HELP[r]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {falseAlarm ? (
          <p className="text-xs text-high" data-testid="strike-consequence">
            {nextStrike >= 3
              ? `Será su ${ordinal(nextStrike)} falta en 90 días: el vecino recibe el aviso de que su cuenta queda en revisión.`
              : `Será su ${ordinal(nextStrike)} falta en 90 días: el vecino recibe la ${ordinal(nextStrike)} advertencia y su confianza baja 25 puntos.`}
          </p>
        ) : null}

        <Field label={falseAlarm ? 'Evidencia (obligatoria): qué se escuchó o se habló con el vecino' : 'Nota (opcional)'}>
          <textarea
            className={textareaClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={falseAlarm ? 'Ej.: al llamar, el vecino dijo que era una broma para un amigo' : undefined}
            data-testid="reject-notes"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="danger" onClick={submit} busy={busy} disabled={!reason || !evidenceOk} data-testid="reject-confirm">
          Rechazar
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Resultado en terreno (docs/plan-plataforma.md §5c): lo que informa la unidad, por ahora por radio.
 * "Era otra situación" pide la categoría real; "falsa alarma confirmada" pide qué se comprobó.
 */
export function OutcomeDialog({
  unitCode,
  alertType,
  onConfirm,
  onClose,
}: {
  unitCode: string;
  alertType: AlertType;
  onConfirm: (body: RecordOutcome) => Promise<void>;
  onClose: () => void;
}) {
  const allowed = categoriesFor(alertType);
  const [outcome, setOutcome] = useState<DispatchOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState<AlertCategory>(allowed[0]);
  const [subcategory, setSubcategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subs = SUBCATEGORIES[category] as readonly string[];
  const needsEvidence = outcome === 'FALSE_ALARM_CONFIRMED';
  const ok = !!outcome && (!needsEvidence || notes.trim().length >= MIN_EVIDENCE);

  const submit = async () => {
    if (!outcome || !ok) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        outcome,
        notes: notes.trim() || undefined,
        ...(outcome === 'DIFFERENT_SITUATION'
          ? { category, subcategory: subcategory && subs.includes(subcategory) ? subcategory : null }
          : {}),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Resultado en terreno · ${unitCode}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <fieldset className="space-y-1.5" data-testid="outcomes">
          <legend className="text-xs text-ink-muted mb-1">¿Qué informa la unidad?</legend>
          {DISPATCH_OUTCOMES.map((o) => (
            <label
              key={o}
              className={`flex gap-2 rounded-ctl border px-2.5 py-1.5 text-sm cursor-pointer ${outcome === o ? 'border-accent bg-accent/10' : 'border-line'}`}
            >
              <input type="radio" name="dispatch-outcome" className="mt-1" checked={outcome === o} onChange={() => setOutcome(o)} data-testid={`outcome-${o}`} />
              <span className="min-w-0">
                <span className="font-medium">{DISPATCH_OUTCOME[o]}</span>
                <span className="block text-xs text-ink-muted">{DISPATCH_OUTCOME_HELP[o]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {outcome === 'DIFFERENT_SITUATION' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lo que había">
              <select
                className={inputClass}
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as AlertCategory);
                  setSubcategory('');
                }}
                data-testid="outcome-category"
              >
                {allowed.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Detalle">
              <select className={inputClass} value={subcategory} onChange={(e) => setSubcategory(e.target.value)}>
                <option value="">Sin detalle</option>
                {subs.map((s) => (
                  <option key={s} value={s}>
                    {subcategoryLabel(s)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        <Field label={needsEvidence ? 'Qué comprobó la unidad (obligatorio)' : 'Nota (opcional)'}>
          <textarea
            className={textareaClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ej.: llegó a las 14:32, se calmó la discusión, sin heridos"
            data-testid="outcome-notes"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" onClick={submit} busy={busy} disabled={!ok} data-testid="outcome-confirm">
          Registrar
        </Button>
      </div>
    </Dialog>
  );
}

export function ResolveDialog({
  onConfirm,
  onClose,
  groupedOpen = 0,
}: {
  onConfirm: (notes: string | undefined, includeGrouped: boolean) => Promise<void>;
  onClose: () => void;
  /** Otras alertas abiertas de la misma situación. */
  groupedOpen?: number;
}) {
  const [notes, setNotes] = useState('');
  const [includeGrouped, setIncludeGrouped] = useState(groupedOpen > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(notes.trim() || undefined, groupedOpen > 0 && includeGrouped);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Resolver alerta" onClose={onClose} busy={busy}>
      <p className="text-sm text-ink-muted mb-4">Cierra el caso y libera las unidades despachadas. El vecino recibe el aviso.</p>
      <Field label="Cómo se resolvió (opcional)">
        <textarea className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {groupedOpen > 0 ? (
        <label className="mt-3 flex items-start gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeGrouped}
            onChange={(e) => setIncludeGrouped(e.target.checked)}
            className="mt-0.5 accent-[var(--color-accent)]"
            data-testid="resolve-grouped"
          />
          <span>
            Resolver también {groupedOpen === 1 ? 'el otro reporte' : `los otros ${groupedOpen} reportes`} de esta situación
            <span className="block text-xs text-ink-muted">Cada vecino que reportó recibe el aviso de que se resolvió.</span>
          </span>
        </label>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-high">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" onClick={submit} busy={busy}>
          Resolver
        </Button>
      </div>
    </Dialog>
  );
}
