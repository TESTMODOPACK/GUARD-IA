'use client';

import { AlertTriangle, Camera, LogOut, MapPin, Navigation, Radio, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  categoriesFor,
  FIELD_LOCATION_EVERY_MS,
  FIELD_PHOTOS_MAX,
  type AlertCategory,
  type DispatchOutcome,
  type FieldAlarm,
  type FieldDispatch,
  type FieldLocation,
  type FieldState,
} from '@guardia/shared';
import { api, ApiRequestError, logout } from '@/lib/api';
import { connectField } from '@/lib/field-realtime';
import {
  CATEGORY,
  classificationLabel,
  DISPATCH_OUTCOME,
  DISPATCH_STATUS,
  FIELD_OUTCOME_HELP,
  formatAge,
  formatTime,
  PRIORITY,
  UNIT_KIND,
  UNIT_STATUS,
} from '@/lib/labels';
import { homeFor, loadSession, onSessionChange, type Session } from '@/lib/session';
import { ping, unlockAudio } from '@/lib/sound';
import { Button, PriorityDot, Spinner, textareaClass } from '@/components/ui';

type Toast = { kind: 'ok' | 'error'; text: string } | null;

/**
 * Terreno (fase PT, migración 0012; docs/plan-plataforma.md §5c): la página del funcionario en su teléfono. Elige
 * su unidad, recibe el despacho (categoría, resumen, lugar, preguntas), marca "voy en camino" y "llegué", informa
 * el resultado con nota y fotos, y tiene un botón de pánico. La posición se envía solo con un despacho abierto.
 * La unidad informa; la central cierra el caso y avisa al vecino.
 */
export default function TerrenoPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [state, setState] = useState<FieldState | null>(null);
  const [online, setOnline] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [reporting, setReporting] = useState(false);
  const lastDispatch = useRef<string | null | undefined>(undefined);
  const lastPos = useRef<FieldLocation | null>(null);
  const now = useNow();

  const notify = useCallback((kind: 'ok' | 'error', text: string) => setToast({ kind, text }), []);

  useEffect(() => {
    const apply = (s: Session | null) => {
      setSession(s);
      if (!s) router.replace('/login');
      else if (s.operator.mustChangePassword) router.replace('/cambiar-clave');
      else if (s.operator.role !== 'FIELD') router.replace(homeFor(s.operator));
    };
    apply(loadSession());
    return onSessionChange(apply);
  }, [router]);

  const isField = session?.operator.role === 'FIELD' && !session.operator.mustChangePassword;

  const load = useCallback(async () => {
    try {
      const st = await api.field.state();
      setState(st);
      // Despacho nuevo: suena y vibra (con la página abierta; el aviso con el teléfono bloqueado llega en PT-4).
      const id = st.dispatch?.id ?? null;
      if (lastDispatch.current !== undefined && id && id !== lastDispatch.current) {
        ping('sos');
        navigator.vibrate?.([400, 150, 400, 150, 400]);
        setToast({ kind: 'ok', text: `Nuevo despacho para ${st.shift?.unit.code ?? 'tu unidad'}` });
      }
      if (lastDispatch.current && !id) setReporting(false);
      lastDispatch.current = id;
    } catch (e) {
      setToast({ kind: 'error', text: e instanceof ApiRequestError ? e.message : 'Sin conexión con la central' });
    }
  }, []);

  // Socket /field + respaldo cada 30 s y al volver a la pestaña.
  useEffect(() => {
    if (!isField) return;
    const close = connectField({
      onRefresh: () => void load(),
      onAlarm: (a: FieldAlarm) => {
        if (a.closedAt) setToast({ kind: 'ok', text: `La central atendió tu pánico${a.closedByName ? ` (${a.closedByName})` : ''}` });
        void load();
      },
      onConnection: setOnline,
    });
    void load();
    const t = setInterval(() => void load(), 30_000);
    const vis = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      close();
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [isField, load]);

  // Posición (RT-5): solo mientras hay un despacho abierto.
  const dispatchOpen = !!state?.dispatch;
  useEffect(() => {
    if (!dispatchOpen || !('geolocation' in navigator)) return;
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        lastPos.current = { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) };
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    const t = setInterval(() => {
      if (lastPos.current) void api.field.location(lastPos.current).catch(() => undefined);
    }, FIELD_LOCATION_EVERY_MS);
    return () => {
      navigator.geolocation.clearWatch(watch);
      clearInterval(t);
    };
  }, [dispatchOpen]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  if (!session || !isField) return null;

  const act = async (fn: () => Promise<FieldState>, ok?: string) => {
    try {
      const st = await fn();
      setState(st);
      lastDispatch.current = st.dispatch?.id ?? null;
      if (ok) notify('ok', ok);
      return true;
    } catch (e) {
      notify('error', e instanceof ApiRequestError ? e.message : 'No se pudo enviar. Revisa la señal.');
      return false;
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-bg text-ink" onPointerDown={unlockAudio}>
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 h-14 border-b border-line bg-surface">
        <Radio size={18} aria-hidden className="text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{state?.shift ? state.shift.unit.code : 'Terreno'}</p>
          <p className="text-xs text-ink-muted truncate">
            {session.operator.name} · {session.operator.tenantName}
          </p>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs ${online ? 'text-ok' : 'text-medium'}`} aria-live="polite">
          <span className={`w-2 h-2 rounded-full ${online ? 'bg-ok' : 'bg-medium'}`} aria-hidden />
          {online ? 'En línea' : 'Sin conexión'}
        </span>
        <button type="button" className="p-2 -mr-2 text-ink-muted hover:text-ink" aria-label="Cerrar sesión" onClick={() => void logout()}>
          <LogOut size={18} />
        </button>
      </header>

      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-4 pb-36 space-y-4">
        {state?.panic ? (
          <div role="alert" className="rounded-lg border border-high/60 bg-high/15 px-4 py-3 text-high">
            <p className="font-semibold">Pánico enviado a las {formatTime(state.panic.createdAt)}</p>
            <p className="text-sm text-ink">
              {state.panic.location
                ? 'La central fue avisada con tu posición. Si puedes, llama al 133.'
                : 'La central fue avisada, pero sin tu posición: activa la ubicación y vuelve a tocar el botón. Si puedes, llama al 133.'}
            </p>
          </div>
        ) : null}

        {!state ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : !state.shift ? (
          <PickUnit state={state} onPick={(id) => act(() => api.field.startShift(id), 'Turno iniciado')} />
        ) : !state.dispatch ? (
          <Idle state={state} onEnd={() => act(() => api.field.endShift(), 'Turno terminado')} />
        ) : reporting ? (
          <ReportForm
            dispatch={state.dispatch}
            onCancel={() => setReporting(false)}
            onSend={async (meta, photos) => {
              const ok = await act(
                () => api.field.report(state.dispatch!.id, { ...meta, location: lastPos.current ?? undefined }, photos),
                'Informe enviado a la central',
              );
              if (ok) setReporting(false);
            }}
          />
        ) : (
          <DispatchCard
            dispatch={state.dispatch}
            now={now}
            onStatus={(status) => act(() => api.field.status(state.dispatch!.id, { status, location: lastPos.current ?? undefined }))}
            onReport={() => setReporting(true)}
          />
        )}
      </main>

      <PanicButton
        sent={!!state?.panic}
        onPanic={async () => {
          const position = await currentPosition(lastPos.current);
          try {
            await api.field.panic({ location: position ?? undefined });
            notify('ok', 'Pánico enviado. La central fue avisada.');
            void load();
          } catch (e) {
            notify('error', `${e instanceof ApiRequestError ? e.message : 'No se pudo enviar'}. Llama al 133.`);
          }
        }}
      />

      {toast ? (
        <div
          role="status"
          className={`fixed top-16 inset-x-4 z-30 mx-auto max-w-md px-4 py-2.5 rounded-ctl border text-sm shadow-xl bg-surface-2 ${
            toast.kind === 'ok' ? 'border-ok/50 text-ok' : 'border-high/50 text-high'
          }`}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

function PickUnit({ state, onPick }: { state: FieldState; onPick: (unitId: string) => Promise<boolean> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Iniciar turno</h1>
        <p className="text-sm text-ink-muted">Elige la unidad con la que sales. La central te despacha a ella.</p>
      </div>
      {state.units.length === 0 ? (
        <p className="text-sm text-ink-muted">Tu municipio aún no tiene unidades. Pide a la central que las cree.</p>
      ) : (
        <ul className="space-y-2">
          {state.units.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(u.id);
                  await onPick(u.id);
                  setBusy(null);
                }}
                className="w-full min-h-16 flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left hover:border-line-strong disabled:opacity-60"
              >
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold">{u.code}</span>
                  <span className="block text-xs text-ink-muted">
                    {UNIT_KIND[u.kind]} · {UNIT_STATUS[u.status]}
                    {u.crew.length ? ` · con ${u.crew.join(', ')}` : ''}
                  </span>
                </span>
                {busy === u.id ? <Spinner /> : <span className="text-sm text-accent">Salir con esta</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Idle({ state, onEnd }: { state: FieldState; onEnd: () => Promise<boolean> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-line bg-surface px-4 py-6 text-center">
        <p className="text-lg font-semibold">Sin despacho</p>
        <p className="text-sm text-ink-muted mt-1">
          Turno con {state.shift!.unit.code} desde las {formatTime(state.shift!.startedAt)}. Mantén esta página abierta: aquí
          llega el próximo despacho, con sonido.
        </p>
      </div>
      {confirm ? (
        <div className="flex gap-2">
          <Button
            variant="danger"
            className="flex-1 h-12"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await onEnd();
              setBusy(false);
              setConfirm(false);
            }}
          >
            Sí, terminar turno
          </Button>
          <Button variant="quiet" className="h-12" onClick={() => setConfirm(false)}>
            No
          </Button>
        </div>
      ) : (
        <Button variant="quiet" className="w-full h-12" onClick={() => setConfirm(true)}>
          Terminar turno
        </Button>
      )}
    </section>
  );
}

function DispatchCard({
  dispatch: d,
  now,
  onStatus,
  onReport,
}: {
  dispatch: FieldDispatch;
  now: number;
  onStatus: (s: 'EN_ROUTE' | 'ON_SITE') => Promise<boolean>;
  onReport: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const a = d.alert;
  const run = async (s: 'EN_ROUTE' | 'ON_SITE') => {
    setBusy(s);
    await onStatus(s);
    setBusy(null);
  };
  return (
    <section className="space-y-4">
      <article className="rounded-lg border border-line bg-surface p-4 space-y-3">
        <div className="flex items-start gap-2">
          <PriorityDot priority={a.priority} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold leading-snug">
              {classificationLabel(a.category, a.subcategory, a.type === 'EMERGENCY_SOS' ? 'SOS sin clasificar' : 'Reporte sin clasificar')}
            </h1>
            <p className="text-xs text-ink-muted">
              {DISPATCH_STATUS[d.status]} · hace {formatAge(d.createdAt, now)}
              {a.priority ? ` · prioridad ${PRIORITY[a.priority].toLowerCase()}` : ''}
            </p>
          </div>
        </div>
        {a.summary ? <p className="text-sm">{a.summary}</p> : null}
        {a.place || a.addressHint ? (
          <p className="text-sm flex gap-1.5">
            <MapPin size={16} className="shrink-0 mt-0.5 text-accent" aria-hidden />
            <span>{a.place ?? a.addressHint}</span>
          </p>
        ) : null}
        {d.notes ? <p className="text-sm text-ink-muted">Central: {d.notes}</p> : null}
        {a.questions.length ? (
          <div>
            <p className="text-xs text-ink-muted mb-1">Para preguntar en el lugar</p>
            <ul className="list-disc pl-5 text-sm space-y-0.5">
              {a.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {a.photos.some((p) => p.url) ? (
          <div className="flex gap-2 overflow-x-auto">
            {a.photos
              .filter((p) => p.url)
              .map((p) => (
                <img key={p.id} src={p.url!} alt="Foto del caso" className="h-24 w-24 object-cover rounded-ctl border border-line" />
              ))}
          </div>
        ) : null}
        {d.outcome ? (
          <p className="text-sm text-medium">
            Informaste: {DISPATCH_OUTCOME[d.outcome]}
            {d.outcomeNote ? ` · ${d.outcomeNote}` : ''}
          </p>
        ) : null}
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${a.location.lat},${a.location.lng}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
        >
          <Navigation size={16} aria-hidden /> Cómo llegar
        </a>
      </article>

      <div className="grid gap-2">
        {d.status === 'ASSIGNED' ? (
          <Button variant="primary" className="h-14 text-base" busy={busy === 'EN_ROUTE'} onClick={() => void run('EN_ROUTE')}>
            Voy en camino
          </Button>
        ) : null}
        {d.status === 'ASSIGNED' || d.status === 'EN_ROUTE' ? (
          <Button
            variant={d.status === 'EN_ROUTE' ? 'primary' : 'quiet'}
            className="h-14 text-base"
            busy={busy === 'ON_SITE'}
            onClick={() => void run('ON_SITE')}
          >
            Llegué
          </Button>
        ) : null}
        <Button variant={d.status === 'ON_SITE' ? 'primary' : 'quiet'} className="h-14 text-base" onClick={onReport}>
          Informar resultado
        </Button>
      </div>
    </section>
  );
}

const OUTCOME_ORDER: DispatchOutcome[] = [
  'RESOLVED_ON_SITE',
  'REFERRED',
  'NEEDS_SUPPORT',
  'NOT_FOUND',
  'DIFFERENT_SITUATION',
  'FALSE_ALARM_CONFIRMED',
];

function ReportForm({
  dispatch: d,
  onCancel,
  onSend,
}: {
  dispatch: FieldDispatch;
  onCancel: () => void;
  onSend: (meta: { outcome: DispatchOutcome; notes?: string; category?: AlertCategory }, photos: File[]) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<DispatchOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState<AlertCategory | ''>('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const minNotes = outcome === 'FALSE_ALARM_CONFIRMED' ? 10 : outcome === 'NEEDS_SUPPORT' ? 3 : 0;
  const ready = !!outcome && notes.trim().length >= minNotes && (outcome !== 'DIFFERENT_SITUATION' || !!category);
  const options = categoriesFor(d.alert.type).filter((c) => c !== d.alert.category);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || !outcome) return;
        setBusy(true);
        await onSend(
          { outcome, notes: notes.trim() || undefined, category: outcome === 'DIFFERENT_SITUATION' && category ? category : undefined },
          photos,
        );
        setBusy(false);
      }}
    >
      <div>
        <h1 className="text-lg font-semibold">Informar resultado</h1>
        <p className="text-sm text-ink-muted">La central recibe tu informe y cierra el caso.</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">Resultado</legend>
        {OUTCOME_ORDER.map((o) => (
          <label
            key={o}
            className={`flex gap-3 rounded-lg border px-3 py-3 cursor-pointer ${outcome === o ? 'border-accent bg-accent/10' : 'border-line bg-surface'}`}
          >
            <input type="radio" name="outcome" className="mt-1" checked={outcome === o} onChange={() => setOutcome(o)} />
            <span>
              <span className="block font-medium">{DISPATCH_OUTCOME[o]}</span>
              <span className="block text-xs text-ink-muted">{FIELD_OUTCOME_HELP[o]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {outcome === 'DIFFERENT_SITUATION' ? (
        <label className="block space-y-1">
          <span className="text-sm">¿Qué era?</span>
          <select
            className="w-full h-12 rounded-ctl border border-line bg-surface px-3"
            value={category}
            onChange={(e) => setCategory(e.target.value as AlertCategory)}
          >
            <option value="">Elige la situación</option>
            {options.map((c) => (
              <option key={c} value={c}>
                {CATEGORY[c]}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="block space-y-1">
        <span className="text-sm">Nota{minNotes ? ` (mínimo ${minNotes} caracteres)` : ' (opcional)'}</span>
        <textarea
          className={textareaClass}
          value={notes}
          maxLength={1000}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={outcome === 'NEEDS_SUPPORT' ? 'Ej.: necesito SAMU, hay un herido' : 'Qué encontraste y qué hiciste'}
        />
      </label>

      <label className="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-3 cursor-pointer text-sm">
        <Camera size={18} aria-hidden className="text-accent" />
        <span className="flex-1">
          {photos.length
            ? `${photos.length} foto${photos.length === 1 ? '' : 's'} lista${photos.length === 1 ? '' : 's'}`
            : `Agregar fotos (hasta ${FIELD_PHOTOS_MAX})`}
        </span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, FIELD_PHOTOS_MAX))}
        />
      </label>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1 h-14 text-base" busy={busy} disabled={!ready}>
          Enviar a la central
        </Button>
        <Button type="button" variant="quiet" className="h-14" onClick={onCancel} disabled={busy}>
          Volver
        </Button>
      </div>
    </form>
  );
}

/** Pánico (RT-6): dos toques, para no enviarlo por accidente en el bolsillo. Nunca espera la ubicación más de 4 s. */
function PanicButton({ sent, onPanic }: { sent: boolean; onPanic: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <div className="fixed bottom-0 inset-x-0 z-20 border-t border-line bg-surface/95 backdrop-blur px-4 py-3">
      <div className="max-w-xl mx-auto">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!armed) {
              setArmed(true);
              navigator.vibrate?.(80);
              return;
            }
            setArmed(false);
            setBusy(true);
            await onPanic();
            setBusy(false);
          }}
          className={`w-full h-16 rounded-lg font-semibold text-base inline-flex items-center justify-center gap-2 transition-colors ${
            armed ? 'bg-high text-white' : 'bg-high/15 text-high border border-high/60'
          }`}
        >
          {busy ? <Spinner /> : armed ? <AlertTriangle size={20} aria-hidden /> : <ShieldAlert size={20} aria-hidden />}
          {armed ? 'Toca de nuevo para enviar el pánico' : sent ? 'Pánico enviado · toca para reenviar tu ubicación' : 'Pánico: estoy en peligro'}
        </button>
      </div>
    </div>
  );
}

/** Posición para el pánico: la última conocida o una nueva, sin esperar más de 4 s. */
function currentPosition(last: FieldLocation | null): Promise<FieldLocation | null> {
  if (last) return Promise.resolve(last);
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(t);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) });
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 4000, maximumAge: 30_000 },
    );
  });
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
