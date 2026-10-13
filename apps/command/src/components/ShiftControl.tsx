'use client';

import type { ShiftStatus } from '@guardia/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { formatDateTime } from '@/lib/labels';
import { Button, Dialog, Field, textareaClass } from './ui';

const errText = (e: unknown) => (e instanceof ApiRequestError ? e.message : 'No se pudo conectar con la API.');
const hhmm = (iso: string) => new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** Estado del turno del operador, recargado cada minuto y al iniciar o terminar. */
export function useShiftStatus() {
  const [status, setStatus] = useState<ShiftStatus | null>(null);
  const reload = useCallback(async () => {
    try {
      setStatus(await api.shiftStatus());
    } catch {
      // Sin red: se reintenta en el próximo ciclo; el control queda como estaba.
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 60_000);
    return () => clearInterval(t);
  }, [reload]);
  return { status, reload };
}

/**
 * Control compacto de la barra superior: "Iniciar turno" o "En turno desde 08:02 · Terminar".
 * Al iniciar muestra la nota que dejó el turno anterior.
 */
export function ShiftControl() {
  const { status, reload } = useShiftStatus();
  const [dialog, setDialog] = useState<'end' | 'handover' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.startShift();
      await reload();
      if (status.lastHandover) setDialog('handover');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      {status.mine?.startedAt ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-ok whitespace-nowrap">
            <span className="h-2 w-2 rounded-full bg-ok" /> En turno desde {hhmm(status.mine.startedAt)}
          </span>
          <Button variant="ghost" className="h-8 px-2" onClick={() => setDialog('end')}>
            Terminar
          </Button>
        </>
      ) : (
        <Button
          variant="quiet"
          className="h-8"
          busy={busy}
          onClick={() => void start()}
          title={status.next?.plannedStart ? `Turno programado: ${formatDateTime(status.next.plannedStart)}` : 'No tienes turno programado; se registra igual'}
        >
          Iniciar turno
        </Button>
      )}
      {error ? (
        <span role="alert" className="text-high text-xs max-w-48 truncate" title={error}>
          {error}
        </span>
      ) : null}
      {dialog === 'end' ? (
        <EndShiftDialog
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            await reload();
          }}
        />
      ) : null}
      {dialog === 'handover' && status.lastHandover ? <HandoverDialog handover={status.lastHandover} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

export function EndShiftDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> | void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Terminar turno" onClose={onClose} busy={busy}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.endShift(note.trim());
            await onDone();
          } catch (err) {
            setError(errText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Nota de entrega para el turno siguiente">
          <textarea
            className={textareaClass}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={5}
            placeholder="Casos abiertos, unidades fuera de servicio, algo que vigilar…"
          />
        </Field>
        <p className="text-xs text-ink-faint">La lee quien inicie el próximo turno. Es opcional, pero ayuda a no perder nada entre turnos.</p>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Seguir de turno
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Terminar turno
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function HandoverDialog({ handover, onClose }: { handover: NonNullable<ShiftStatus['lastHandover']>; onClose: () => void }) {
  return (
    <Dialog title="Entrega del turno anterior" onClose={onClose}>
      <p className="text-xs text-ink-muted">
        {handover.operatorName} · terminó {formatDateTime(handover.endedAt)}
      </p>
      <p className="mt-3 text-sm whitespace-pre-wrap rounded-ctl border border-line bg-bg/60 p-3">{handover.note}</p>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Entendido
        </Button>
      </div>
    </Dialog>
  );
}
