'use client';

import type { OperatorAccount, Shift } from '@guardia/shared';
import { CalendarPlus, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/labels';
import { AdminShell, Card, ConfirmDialog, errText, isManager, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { EndShiftDialog, useShiftStatus } from '@/components/ShiftControl';
import { Button, Dialog, Field, inputClass, Spinner, Tag } from '@/components/ui';

const DAY_MS = 86_400_000;
const hhmm = (iso: string) => new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const dayTitle = new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });

/** Lunes 00:00 local de la semana de `d`. */
function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
}

const PRESETS = [
  { id: 'M', label: 'Mañana 08:00 – 16:00', start: '08:00', end: '16:00' },
  { id: 'T', label: 'Tarde 16:00 – 00:00', start: '16:00', end: '00:00' },
  { id: 'N', label: 'Noche 00:00 – 08:00', start: '00:00', end: '08:00' },
  { id: 'C', label: 'Otro horario', start: '09:00', end: '18:00' },
] as const;

type ShiftState = { label: string; tone: 'ok' | 'neutral' | 'high' | 'medium' | 'accent' };

function stateOf(s: Shift, now: number): ShiftState {
  if (s.startedAt && !s.endedAt) return { label: 'En curso', tone: 'ok' };
  if (s.endedAt) return { label: s.plannedStart ? 'Terminado' : 'Terminado (sin programar)', tone: 'neutral' };
  if (s.plannedEnd && Date.parse(s.plannedEnd) < now) return { label: 'No se inició', tone: 'high' };
  if (s.plannedStart && Date.parse(s.plannedStart) <= now) return { label: 'Debió empezar', tone: 'medium' };
  return { label: 'Programado', tone: 'accent' };
}

/** Turnos: el propio (iniciar / terminar con entrega), quién está de turno y la semana programada. */
export default function ShiftsPage() {
  const session = useOperatorSession();
  const manager = isManager(session);
  const { status, reload: reloadStatus } = useShiftStatus();
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [operators, setOperators] = useState<OperatorAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'plan' } | { kind: 'remove'; shift: Shift } | { kind: 'end' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setShifts(await api.shifts(week.toISOString(), new Date(week.getTime() + 7 * DAY_MS).toISOString()));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [week]);

  useEffect(() => {
    if (!session) return;
    void load();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [session, load]);

  useEffect(() => {
    if (!manager) return;
    api
      .operators()
      .then((l) => setOperators(l.filter((o) => o.active)))
      .catch(() => setOperators([]));
  }, [manager]);

  const days = useMemo(() => {
    const out: { date: Date; items: Shift[] }[] = [];
    for (let i = 0; i < 7; i++) out.push({ date: new Date(week.getTime() + i * DAY_MS), items: [] });
    for (const s of shifts ?? []) {
      const ref = new Date(s.plannedStart ?? s.startedAt ?? s.createdAt);
      const idx = Math.floor((new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime() - week.getTime()) / DAY_MS);
      if (idx >= 0 && idx < 7) out[idx].items.push(s);
    }
    return out;
  }, [shifts, week]);

  if (!session) return null;
  const mine = status?.mine;

  const startMine = async () => {
    setBusy(true);
    try {
      await api.startShift();
      await Promise.all([reloadStatus(), load()]);
      setNotice('Turno iniciado.');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminShell
      session={session}
      title="Turnos"
      actions={
        manager ? (
          <Button variant="primary" onClick={() => setDialog({ kind: 'plan' })}>
            <CalendarPlus size={16} /> Programar turno
          </Button>
        ) : null
      }
    >
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Mi turno">
          {!status ? (
            <Spinner />
          ) : mine?.startedAt ? (
            <div className="space-y-3">
              <p className="text-sm">
                <span className="text-ok">En turno</span> desde {hhmm(mine.startedAt)}
                {mine.plannedEnd ? <span className="text-ink-muted"> · programado hasta {hhmm(mine.plannedEnd)}</span> : null}
              </p>
              <Button variant="quiet" onClick={() => setDialog({ kind: 'end' })}>
                Terminar turno
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-muted">
                {status.next?.plannedStart
                  ? `Tu próximo turno: ${formatDateTime(status.next.plannedStart)} – ${hhmm(status.next.plannedEnd!)}`
                  : 'No tienes turnos programados. Puedes iniciar uno igual.'}
              </p>
              <Button variant="primary" busy={busy} onClick={() => void startMine()}>
                Iniciar turno
              </Button>
            </div>
          )}
        </Card>
        <Card title="De turno ahora">
          {!status ? (
            <Spinner />
          ) : status.onDuty.length === 0 ? (
            <p className="text-sm text-high">Nadie ha iniciado turno.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {status.onDuty.map((d) => (
                <li key={d.operatorId} className="flex justify-between gap-2">
                  <span>{d.name}</span>
                  <span className="text-ink-muted tabular-nums">desde {hhmm(d.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Última entrega de turno">
          {!status ? (
            <Spinner />
          ) : status.lastHandover ? (
            <div className="space-y-1">
              <p className="text-xs text-ink-muted">
                {status.lastHandover.operatorName} · {formatDateTime(status.lastHandover.endedAt)}
              </p>
              <p className="text-sm whitespace-pre-wrap max-h-36 overflow-y-auto gi-scroll">{status.lastHandover.note}</p>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Aún no hay notas de entrega.</p>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Button variant="ghost" className="h-8 px-2" aria-label="Semana anterior" onClick={() => setWeek(new Date(week.getTime() - 7 * DAY_MS))}>
            <ChevronLeft size={16} />
          </Button>
          <h2 className="text-sm font-medium">
            Semana del {dayTitle.format(week)} al {dayTitle.format(new Date(week.getTime() + 6 * DAY_MS))}
          </h2>
          <Button variant="ghost" className="h-8 px-2" aria-label="Semana siguiente" onClick={() => setWeek(new Date(week.getTime() + 7 * DAY_MS))}>
            <ChevronRight size={16} />
          </Button>
          <Button variant="ghost" className="h-8 ml-auto" onClick={() => setWeek(weekStart(new Date()))}>
            Esta semana
          </Button>
        </div>
        {!shifts ? (
          <p className="text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando turnos
          </p>
        ) : (
          <div className="divide-y divide-line">
            {days.map((d) => (
              <div key={d.date.toISOString()} className="py-3 grid gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="text-sm font-medium first-letter:uppercase">{dayTitle.format(d.date)}</div>
                {d.items.length === 0 ? (
                  <p className="text-sm text-ink-faint">Sin turnos</p>
                ) : (
                  <ul className="space-y-1.5">
                    {d.items.map((s) => {
                      const st = stateOf(s, now);
                      return (
                        <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                          <span className="min-w-36">{s.operatorName}</span>
                          <span className="tabular-nums text-ink-muted">
                            {s.plannedStart ? `${hhmm(s.plannedStart)} – ${hhmm(s.plannedEnd!)}` : 'Sin programar'}
                          </span>
                          {s.startedAt ? (
                            <span className="tabular-nums text-ink-faint text-xs">
                              real {hhmm(s.startedAt)}
                              {s.endedAt ? ` – ${hhmm(s.endedAt)}` : ''}
                            </span>
                          ) : null}
                          <Tag tone={st.tone}>{st.label}</Tag>
                          {s.handoverNote ? (
                            <span className="text-xs text-ink-faint truncate max-w-72" title={s.handoverNote}>
                              Entrega: {s.handoverNote}
                            </span>
                          ) : null}
                          {manager && !s.startedAt ? (
                            <Button
                              variant="ghost"
                              className="h-7 px-1.5 ml-auto"
                              aria-label={`Eliminar el turno de ${s.operatorName}`}
                              onClick={() => setDialog({ kind: 'remove', shift: s })}
                            >
                              <Trash2 size={14} />
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {dialog?.kind === 'plan' ? (
        <PlanShiftDialog
          operators={operators}
          defaultDate={new Date(Math.max(week.getTime(), Date.now()))}
          onClose={() => setDialog(null)}
          onDone={(s) => {
            setDialog(null);
            setNotice(`Turno programado para ${s.operatorName}.`);
            void load();
          }}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <ConfirmDialog
          title="Eliminar turno programado"
          confirmLabel="Eliminar"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.removeShift(dialog.shift.id);
            setDialog(null);
            setNotice('Turno eliminado.');
            void load();
          }}
        >
          {dialog.shift.operatorName}, {dialog.shift.plannedStart ? formatDateTime(dialog.shift.plannedStart) : ''}. Queda registrado en la bitácora.
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'end' ? (
        <EndShiftDialog
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            setNotice('Turno terminado. Tu nota quedó para el turno siguiente.');
            await Promise.all([reloadStatus(), load()]);
          }}
        />
      ) : null}
    </AdminShell>
  );
}

function toDateInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function PlanShiftDialog({
  operators,
  defaultDate,
  onClose,
  onDone,
}: {
  operators: OperatorAccount[];
  defaultDate: Date;
  onClose: () => void;
  onDone: (s: Shift) => void;
}) {
  const [operatorId, setOperatorId] = useState(operators[0]?.id ?? '');
  const [date, setDate] = useState(toDateInput(defaultDate));
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('M');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('16:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (id: (typeof PRESETS)[number]['id']) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id)!;
    if (id !== 'C') {
      setStart(p.start);
      setEnd(p.end);
    }
  };

  // Hora local del navegador (la central opera en la zona del municipio). Si el término es antes del
  // inicio, el turno cruza la medianoche.
  const range = (() => {
    const [y, m, d] = date.split('-').map(Number);
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if (!y || Number.isNaN(sh) || Number.isNaN(eh)) return null;
    const s = new Date(y, m - 1, d, sh, sm);
    const e = new Date(y, m - 1, d, eh, em);
    if (e <= s) e.setDate(e.getDate() + 1);
    return { s, e };
  })();

  return (
    <Dialog title="Programar turno" onClose={onClose} busy={busy}>
      <form
        className="space-y-4"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (!range || !operatorId) return;
          setBusy(true);
          setError(null);
          try {
            onDone(await api.planShift({ operatorId, plannedStart: range.s.toISOString(), plannedEnd: range.e.toISOString() }));
          } catch (e) {
            setError(errText(e));
            setBusy(false);
          }
        }}
      >
        <Field label="Persona">
          <select className={inputClass} value={operatorId} onChange={(e) => setOperatorId(e.target.value)} required>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fecha">
          <input className={inputClass} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Horario">
          <select className={inputClass} value={preset} onChange={(e) => choose(e.target.value as (typeof PRESETS)[number]['id'])}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        {preset === 'C' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Desde">
              <input className={inputClass} type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
            </Field>
            <Field label="Hasta">
              <input className={inputClass} type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </Field>
          </div>
        ) : null}
        {range ? (
          <p className="text-xs text-ink-muted">
            {formatDateTime(range.s.toISOString())} → {formatDateTime(range.e.toISOString())}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!range || !operatorId}>
            Programar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
