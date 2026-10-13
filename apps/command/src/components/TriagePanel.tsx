'use client';

import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import {
  DEFAULT_QUESTIONS,
  SUBCATEGORIES,
  SUGGESTED_AGENCIES,
  categoriesFor,
  triageRuleLabel,
  type AlertCategory,
  type AlertDetail,
  type AlertSummary,
  type SuggestedAgency,
  type TenantOption,
} from '@guardia/shared';
import { api } from '@/lib/api';
import { AGENCY, agencyList, CATEGORY, classificationLabel, formatTime, subcategoryLabel } from '@/lib/labels';
import { useStore } from '@/lib/store';
import { Button, Dialog, Field, inputClass, Tag, textareaClass } from './ui';

/**
 * Agente de clasificación en la ficha: a quién derivar y por qué, qué preguntarle al vecino y
 * dónde dice que ocurre. El operador confirma o corrige ("Corregir clasificación") y registra a
 * quién derivó ("Derivado a…"); ambas cosas quedan como etiqueta para medir y mejorar la IA.
 */
export function TriagePanel({ alert, detail }: { alert: AlertSummary; detail: AlertDetail | null }) {
  const upsertAlert = useStore((s) => s.upsertAlert);
  const notify = useStore((s) => s.notify);
  const removeAlert = useStore((s) => s.removeAlert);
  const [dialog, setDialog] = useState<'refer' | 'reclassify' | null>(null);
  const [transfer, setTransfer] = useState<{ tenantId: string | null; reason: string } | null>(null);

  const triage = detail?.triage ?? null;
  const label = detail?.triageLabel ?? null;
  const category = alert.category ?? (alert.type === 'EMERGENCY_SOS' ? 'OTRO_EMERGENCIA' : 'OTRO_URBANO');
  const questions = triage?.questions.length ? triage.questions : DEFAULT_QUESTIONS[category];
  const suggested: { agency: SuggestedAgency; reason: string | null }[] = triage
    ? triage.agencies
    : alert.suggestedAgency
      ? [{ agency: alert.suggestedAgency, reason: null }]
      : [];
  const rules = (triage?.rules ?? []).map((id) => triageRuleLabel(id)).filter((x): x is string => !!x);
  const place = triage?.location;
  const geo = detail?.geo ?? null;
  const mentioned = geo?.mentioned ?? null;
  // Solo lo que nadie ha despachado todavía (lo mismo que exige transfer_alert en la base).
  const canTransfer = !!detail && ['PENDING', 'ACKNOWLEDGED'].includes(alert.status) && detail.dispatches.length === 0;

  const save = async (fn: () => Promise<AlertDetail>, ok: string) => {
    const d = await fn();
    upsertAlert(d);
    notify('ok', ok);
  };

  return (
    <section className="rounded-ctl border border-line p-3" data-testid="triage-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Derivación</h3>
        {triage ? <span className="text-xs text-ink-faint">{triage.provider === 'mock' ? 'sin IA (reglas)' : 'sugerida por IA'}</span> : null}
      </div>

      {suggested.length ? (
        <ol className="mt-2 space-y-1.5" aria-label="Instituciones sugeridas">
          {suggested.map((a, i) => (
            <li key={a.agency} className="flex items-start gap-2 text-sm">
              <span className="text-xs text-ink-faint tabular-nums w-4 pt-0.5">{i + 1}.</span>
              <span className="min-w-0">
                <span className="font-medium">{AGENCY[a.agency]}</span>
                {a.reason ? <span className="text-ink-muted"> · {a.reason}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1.5 text-xs text-ink-muted">Sin sugerencia todavía.</p>
      )}

      {rules.length ? <p className="mt-2 text-xs text-medium">Regla de seguridad aplicada: {rules.join(' · ')}</p> : null}

      {label?.referredAt ? (
        <p className="mt-2 text-xs">
          <Tag tone="ok">Derivado a {agencyList(label.agencies)}</Tag>{' '}
          <span className="text-ink-muted">
            por {label.referredBy ?? 'operador'} · {formatTime(label.referredAt)}
          </span>
        </p>
      ) : null}
      {label?.classifiedAt && label.category ? (
        <p className="mt-1.5 text-xs text-ink-muted">
          Clasificación del operador: {classificationLabel(label.category, label.subcategory)} · por {label.classifiedBy ?? 'operador'}
          {triage && triage.category !== label.category ? ` (la IA dijo ${CATEGORY[triage.category].toLowerCase()})` : ''}
        </p>
      ) : null}

      <div className="mt-3 rounded-ctl bg-bg/60 border border-line px-2.5 py-2 text-sm space-y-1" data-testid="triage-place">
        <p className="flex items-start gap-1.5">
          <MapPin size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <span>
            {place?.mentioned ? <>Lugar mencionado: {place.mentioned}</> : 'El vecino no da una dirección'}
            {geo?.comuna ? <span className="text-ink-muted"> · GPS en {geo.comuna.name}</span> : null}
          </span>
        </p>
        {place?.elsewhere ? (
          <p className="text-xs text-medium">El hecho ocurre en otro lugar: el punto del mapa es dónde está el vecino.</p>
        ) : null}
        {mentioned ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-medium">
              Ocurre en {mentioned.name}
              {mentioned.tenantName ? ` · la atiende ${mentioned.tenantName}` : ', comuna que no usa Guard-IA: derivar por teléfono'}
            </span>
            {canTransfer && mentioned.tenantId ? (
              <Button
                variant="quiet"
                className="h-7 px-2 text-xs"
                onClick={() => setTransfer({ tenantId: mentioned.tenantId, reason: `El vecino indica que ocurre en ${mentioned.name}` })}
                data-testid="action-transfer-mentioned"
              >
                Traspasar a {mentioned.tenantName}
              </Button>
            ) : null}
          </div>
        ) : null}
        {(geo?.nearby ?? []).map((n) => (
          <div key={n.tenantId} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-ink-muted">
              {n.distanceM === 0 ? 'Dentro del margen del GPS' : `A ${n.distanceM} m`} del límite con {n.tenantName}
            </span>
            {canTransfer && n.tenantId !== mentioned?.tenantId ? (
              <Button
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setTransfer({ tenantId: n.tenantId, reason: `El vecino está en el límite con ${n.tenantName}` })}
              >
                Traspasar
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-3">
        <h4 className="text-xs text-ink-muted mb-1">Preguntas para el vecino</h4>
        <ul className="space-y-1 text-sm list-disc pl-5">
          {questions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="quiet" className="h-8 text-xs" onClick={() => setDialog('refer')} data-testid="action-refer">
          Derivado a…
        </Button>
        <Button variant="ghost" className="h-8 text-xs" onClick={() => setDialog('reclassify')} data-testid="action-reclassify">
          Corregir clasificación
        </Button>
        {canTransfer ? (
          <Button variant="ghost" className="h-8 text-xs" onClick={() => setTransfer({ tenantId: null, reason: '' })} data-testid="action-transfer">
            Traspasar a otro municipio…
          </Button>
        ) : null}
      </div>

      {transfer ? (
        <TransferDialog
          initial={transfer}
          onClose={() => setTransfer(null)}
          onConfirm={async (tenantId, reason) => {
            const r = await api.transfer(alert.id, tenantId, reason);
            removeAlert(alert.id);
            notify('ok', `Alerta traspasada a ${r.toTenantName}`);
          }}
        />
      ) : null}

      {dialog === 'refer' ? (
        <ReferDialog
          initial={label?.agencies.length ? label.agencies : suggested.map((a) => a.agency)}
          onClose={() => setDialog(null)}
          onConfirm={(agencies, notes) => save(() => api.refer(alert.id, agencies, notes), `Derivado a ${agencyList(agencies)}`)}
        />
      ) : null}
      {dialog === 'reclassify' ? (
        <ReclassifyDialog
          type={alert.type}
          category={alert.category}
          subcategory={alert.subcategory}
          onClose={() => setDialog(null)}
          onConfirm={(c, s) => save(() => api.reclassify(alert.id, c, s), `Clasificación: ${classificationLabel(c, s)}`)}
        />
      ) : null}
    </section>
  );
}

function TransferDialog({
  initial,
  onConfirm,
  onClose,
}: {
  initial: { tenantId: string | null; reason: string };
  onConfirm: (tenantId: string, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<TenantOption[] | null>(null);
  const [tenantId, setTenantId] = useState(initial.tenantId ?? '');
  const [reason, setReason] = useState(initial.reason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .tenants()
      .then((l) => {
        if (!live) return;
        setOptions(l);
        setTenantId((t) => t || l[0]?.id || '');
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(tenantId, reason.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Traspasar a otro municipio" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <Field label="Municipio donde ocurre el hecho">
          <select className={inputClass} value={tenantId} onChange={(e) => setTenantId(e.target.value)} data-testid="transfer-tenant">
            {(options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Motivo (lo verá la otra central)">
          <textarea
            className={textareaClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej.: el vecino confirma que el incendio es en Bajos de Mena"
          />
        </Field>
        <p className="text-xs text-ink-muted">
          La alerta sale de esta central y llega como nueva a la otra; el vecino recibe aviso. Queda en la bitácora.
        </p>
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
        <Button
          variant="primary"
          onClick={submit}
          busy={busy}
          disabled={!tenantId || reason.trim().length < 3}
          data-testid="transfer-confirm"
        >
          Traspasar
        </Button>
      </div>
    </Dialog>
  );
}

function ReferDialog({
  initial,
  onConfirm,
  onClose,
}: {
  initial: SuggestedAgency[];
  onConfirm: (agencies: SuggestedAgency[], notes?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<SuggestedAgency[]>(initial);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Orden fijo de la lista, con las sugeridas primero.
  const options = [...initial, ...SUGGESTED_AGENCIES.filter((a) => !initial.includes(a))];

  const toggle = (a: SuggestedAgency) => setPicked((p) => (p.includes(a) ? p.filter((x) => x !== a) : [...p, a]));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(
        options.filter((a) => picked.includes(a)),
        notes.trim() || undefined,
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="¿A quién se derivó el caso?" onClose={onClose} busy={busy}>
      <fieldset className="space-y-1.5">
        <legend className="text-xs text-ink-muted mb-1">Marca las instituciones que contactaste</legend>
        {options.map((a) => (
          <label key={a} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={picked.includes(a)} onChange={() => toggle(a)} data-testid={`refer-${a}`} />
            {AGENCY[a]}
            {initial.includes(a) ? <span className="text-xs text-ink-faint">sugerida</span> : null}
          </label>
        ))}
      </fieldset>
      <div className="mt-4">
        <Field label="Nota (opcional)">
          <textarea
            className={textareaClass}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ej.: SAMU confirma móvil en camino, 14:32"
          />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-high">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" onClick={submit} busy={busy} disabled={picked.length === 0} data-testid="refer-confirm">
          Registrar derivación
        </Button>
      </div>
    </Dialog>
  );
}

function ReclassifyDialog({
  type,
  category,
  subcategory,
  onConfirm,
  onClose,
}: {
  type: AlertSummary['type'];
  category: AlertCategory | null;
  subcategory: string | null;
  onConfirm: (category: AlertCategory, subcategory: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const allowed = categoriesFor(type);
  const [cat, setCat] = useState<AlertCategory>(category && allowed.includes(category) ? category : allowed[0]);
  const [sub, setSub] = useState<string>(subcategory ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subs = SUBCATEGORIES[cat] as readonly string[];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(cat, sub && subs.includes(sub) ? sub : null);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Corregir clasificación" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <Field label="Categoría">
          <select
            className={inputClass}
            value={cat}
            onChange={(e) => {
              setCat(e.target.value as AlertCategory);
              setSub('');
            }}
            data-testid="reclassify-category"
          >
            {allowed.map((c) => (
              <option key={c} value={c}>
                {CATEGORY[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Detalle">
          <select className={inputClass} value={sub} onChange={(e) => setSub(e.target.value)} data-testid="reclassify-subcategory">
            <option value="">Sin detalle</option>
            {subs.map((s) => (
              <option key={s} value={s}>
                {subcategoryLabel(s)}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-xs text-ink-muted">
          Queda como la clasificación del caso y la IA ya no la cambia. También sirve para medir y mejorar al agente.
        </p>
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
        <Button variant="primary" onClick={submit} busy={busy} data-testid="reclassify-confirm">
          Guardar
        </Button>
      </div>
    </Dialog>
  );
}
