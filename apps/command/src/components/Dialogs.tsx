'use client';

import { useMemo, useState } from 'react';
import type { RejectReason, Unit } from '@guardia/shared';
import { REJECT_REASONS } from '@guardia/shared';
import { REJECT_REASON, UNIT_STATUS } from '@/lib/labels';
import { Button, Dialog, Field, inputClass, textareaClass } from './ui';

export function DispatchDialog({
  units,
  onConfirm,
  onClose,
}: {
  units: Unit[];
  onConfirm: (unitId: string, notes?: string) => Promise<void>;
  onClose: () => void;
}) {
  // Patrullas primero: para un SOS son la respuesta por defecto; motos e inspectores después.
  const KIND_RANK: Record<string, number> = { PATRULLA: 0, MOTO: 1, INSPECTOR: 2 };
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

export function RejectDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (reason: RejectReason, notes?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<RejectReason>('FALSE_ALARM');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
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
        <Field label="Motivo">
          <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as RejectReason)}>
            {REJECT_REASONS.map((r) => (
              <option key={r} value={r}>
                {REJECT_REASON[r]}
              </option>
            ))}
          </select>
        </Field>
        {reason === 'FALSE_ALARM' ? (
          <p className="text-xs text-medium">Una falsa alarma baja 25 puntos la confianza del vecino. Las siguientes alertas de esa persona se marcan en la cola.</p>
        ) : null}
        <Field label="Nota (opcional)">
          <textarea className={textareaClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error ? <p role="alert" className="text-sm text-high">{error}</p> : null}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="danger" onClick={submit} busy={busy}>
          Rechazar
        </Button>
      </div>
    </Dialog>
  );
}

export function ResolveDialog({ onConfirm, onClose }: { onConfirm: (notes?: string) => Promise<void>; onClose: () => void }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(notes.trim() || undefined);
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
