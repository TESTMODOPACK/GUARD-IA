'use client';

import {
  AREA_NAME_MAX,
  CIVIC_CATEGORIES,
  SUBCATEGORIES,
  SUGGESTED_AREAS,
  type Area,
  type AreaRule,
  type AreasConfig,
  type CivicCategory,
} from '@guardia/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { CATEGORY, subcategoryLabel } from '@/lib/labels';
import { AdminShell, Card, ConfirmDialog, errText, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Button, Dialog, Field, inputClass, Spinner, Tag, textareaClass } from '@/components/ui';

type DialogState =
  | { kind: 'create' }
  | { kind: 'rename'; area: Area }
  | { kind: 'toggle'; area: Area }
  | { kind: 'sos'; area: Area }
  | { kind: 'suggested' }
  | { kind: 'mode'; shared: boolean }
  | null;

/**
 * Áreas del municipio (0013). Las define el administrador: cada alerta llega a un área (los SOS a la que los recibe;
 * cada reporte urbano según su categoría o subcategoría) y cada cuenta ve las de sus áreas. Las categorías son
 * nacionales y las fija Guard-IA; aquí solo se decide quién las atiende.
 */
export default function AreasPage() {
  const session = useOperatorSession(['ADMIN']);
  const [cfg, setCfg] = useState<AreasConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const load = useCallback(async () => {
    try {
      setCfg(await api.areas.config());
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  if (!session) return null;

  const done = (next: AreasConfig, text: string) => {
    setCfg(next);
    setDialog(null);
    setNotice(text);
    setError(null);
  };
  const sosArea = cfg?.areas.find((a) => a.receivesSos && a.active);

  return (
    <AdminShell
      session={session}
      title="Áreas del municipio"
      actions={
        cfg ? (
          <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
            <Plus size={16} /> Nueva área
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-ink-muted -mt-3">
        Cada alerta llega a un área y cada cuenta ve las alertas de sus áreas. Las cuentas se asignan en{' '}
        <Link href="/admin/usuarios" className="text-accent hover:underline">
          Usuarios
        </Link>
        . El administrador ve todo.
      </p>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      {!cfg ? (
        <Card>
          <p className="text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando áreas
          </p>
        </Card>
      ) : cfg.areas.length === 0 ? (
        <Card title="Sin áreas todavía">
          <p className="text-sm text-ink-muted">
            Este municipio no se divide en áreas: todas las cuentas ven todas las alertas. Puedes partir con las áreas sugeridas (
            {SUGGESTED_AREAS.map((a) => a.name).join(', ')}) y ajustarlas, o crear las tuyas.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setDialog({ kind: 'suggested' })} data-testid="areas-suggested">
              Crear áreas sugeridas
            </Button>
            <Button variant="quiet" onClick={() => setDialog({ kind: 'create' })}>
              Crear la primera área
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card title="Áreas">
            <p className="text-sm mb-3">
              Los SOS llegan a: <span className="font-medium">{sosArea?.name ?? 'ninguna'}</span>
              <span className="text-ink-muted"> · también ve los reportes urbanos con carácter de seguridad.</span>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-left text-xs text-ink-muted border-b border-line">
                    <th className="py-2 pr-3 font-medium">Nombre</th>
                    <th className="py-2 pr-3 font-medium">Cuentas</th>
                    <th className="py-2 pr-3 font-medium">Alertas abiertas</th>
                    <th className="py-2 pr-3 font-medium">Estado</th>
                    <th className="py-2 font-medium text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {cfg.areas.map((a) => (
                    <tr key={a.id} className={`border-b border-line/60 last:border-0 ${a.active ? '' : 'opacity-60'}`} data-testid="area-row">
                      <td className="py-2 pr-3">
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          {a.name}
                          {a.receivesSos ? <Tag tone="high">Recibe los SOS</Tag> : null}
                        </span>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{a.members === 0 && a.active ? <Tag tone="medium">Sin cuentas</Tag> : a.members}</td>
                      <td className="py-2 pr-3 tabular-nums">{a.openAlerts}</td>
                      <td className="py-2 pr-3">{a.active ? 'Activa' : <Tag>Desactivada</Tag>}</td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        <Button variant="ghost" className="h-8 px-2" aria-label={`Renombrar ${a.name}`} onClick={() => setDialog({ kind: 'rename', area: a })}>
                          <Pencil size={15} />
                        </Button>
                        {a.active && !a.receivesSos ? (
                          <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => setDialog({ kind: 'sos', area: a })}>
                            Recibir los SOS
                          </Button>
                        ) : null}
                        {!a.receivesSos ? (
                          <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => setDialog({ kind: 'toggle', area: a })}>
                            {a.active ? 'Desactivar' : 'Activar'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <RulesEditor cfg={cfg} onSaved={(next) => done(next, 'Reglas guardadas: rigen para los reportes que lleguen desde ahora.')} />

          <Card title="Excepción: todas las áreas ven todo">
            <p className="text-sm text-ink-muted">
              {cfg.shared
                ? 'Activada: todas las cuentas ven todas las alertas, como si no hubiera áreas. Las alertas igual quedan marcadas con su área.'
                : 'Desactivada (lo normal): cada cuenta ve solo las alertas de sus áreas. Úsala solo si la central es chica y todos atienden todo.'}
            </p>
            <div className="mt-3">
              <Button variant={cfg.shared ? 'primary' : 'quiet'} onClick={() => setDialog({ kind: 'mode', shared: !cfg.shared })} data-testid="areas-mode">
                {cfg.shared ? 'Volver a separar por área' : 'Activar la excepción'}
              </Button>
            </div>
          </Card>
        </>
      )}

      {dialog?.kind === 'create' ? (
        <NameDialog
          title="Nueva área"
          hint={
            cfg?.areas.some((a) => a.receivesSos && a.active)
              ? 'Después asígnale categorías (abajo) y cuentas (en Usuarios).'
              : 'Es la primera: recibirá los SOS. Después asígnale categorías y cuentas.'
          }
          onClose={() => setDialog(null)}
          onSubmit={async (name) => done(await api.areas.create({ name }), `Área ${name} creada.`)}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <NameDialog
          title={`Renombrar ${dialog.area.name}`}
          initial={dialog.area.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => done(await api.areas.update(dialog.area.id, { name }), `Ahora se llama ${name}.`)}
        />
      ) : null}
      {dialog?.kind === 'suggested' ? (
        <ConfirmDialog
          title="Crear áreas sugeridas"
          confirmLabel="Crear"
          onClose={() => setDialog(null)}
          onConfirm={async () => done(await api.areas.suggested(), 'Áreas creadas. Revisa las reglas y asigna las cuentas en Usuarios.')}
        >
          Se crean {SUGGESTED_AREAS.map((a) => a.name).join(', ')}, con Seguridad recibiendo los SOS y cada categoría de reporte urbano en su
          área. Desde ese momento, una cuenta sin área solo ve alertas sin área: asigna las cuentas en Usuarios.
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'sos' ? (
        <ConfirmDialog
          title={`Los SOS a ${dialog.area.name}`}
          confirmLabel="Cambiar"
          onClose={() => setDialog(null)}
          onConfirm={async () => done(await api.areas.update(dialog.area.id, { receivesSos: true }), `Los SOS nuevos llegan a ${dialog.area.name}.`)}
        >
          Los SOS nuevos llegarán a {dialog.area.name}
          {sosArea ? ` y dejarán de llegar a ${sosArea.name}` : ''}. Los SOS abiertos siguen en su área; si hace falta, se pasan a mano desde la
          ficha.
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'toggle' ? (
        <ConfirmDialog
          title={dialog.area.active ? `Desactivar ${dialog.area.name}` : `Activar ${dialog.area.name}`}
          confirmLabel={dialog.area.active ? 'Desactivar' : 'Activar'}
          danger={dialog.area.active}
          onClose={() => setDialog(null)}
          onConfirm={async () =>
            done(
              await api.areas.update(dialog.area.id, { active: !dialog.area.active }),
              dialog.area.active ? `${dialog.area.name} desactivada.` : `${dialog.area.name} activa de nuevo.`,
            )
          }
        >
          {dialog.area.active
            ? 'Antes hay que pasar sus categorías a otra área y sus alertas abiertas. Sus cuentas dejan de ver las alertas de esta área.'
            : 'Vuelve a poder recibir categorías y cuentas.'}
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'mode' ? (
        <ModeDialog shared={dialog.shared} onClose={() => setDialog(null)} onSaved={(next) => done(next, next.shared ? 'Todas las áreas ven todo.' : 'Cada área ve solo lo suyo.')} />
      ) : null}
    </AdminShell>
  );
}

interface Exception {
  key: number;
  category: CivicCategory;
  subcategory: string;
  areaId: string;
}

let nextKey = 1;

/**
 * Qué área atiende cada categoría de reporte urbano y, como excepción, una subcategoría (p. ej. "árbol con riesgo de
 * caer" a Medio ambiente aunque las áreas verdes sean de Aseo). Se guarda todo junto.
 */
function RulesEditor({ cfg, onSaved }: { cfg: AreasConfig; onSaved: (next: AreasConfig) => void }) {
  const active = useMemo(() => cfg.areas.filter((a) => a.active), [cfg.areas]);
  const fromCfg = useCallback(() => {
    const general = Object.fromEntries(CIVIC_CATEGORIES.map((c) => [c, ''])) as Record<CivicCategory, string>;
    const exceptions: Exception[] = [];
    for (const r of cfg.rules) {
      if (r.subcategory) exceptions.push({ key: nextKey++, category: r.category, subcategory: r.subcategory, areaId: r.areaId });
      else general[r.category] = r.areaId;
    }
    return { general, exceptions };
  }, [cfg.rules]);
  const [state, setState] = useState(fromCfg);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setState(fromCfg()), [fromCfg]);

  const rules: AreaRule[] = [
    ...CIVIC_CATEGORIES.filter((c) => state.general[c]).map((c) => ({ category: c, subcategory: null, areaId: state.general[c] })),
    ...state.exceptions.filter((e) => e.subcategory && e.areaId).map((e) => ({ category: e.category, subcategory: e.subcategory, areaId: e.areaId })),
  ];
  const keyOf = (r: AreaRule) => `${r.category}/${r.subcategory ?? ''}/${r.areaId}`;
  const dirty = rules.map(keyOf).sort().join() !== cfg.rules.map(keyOf).sort().join() || state.exceptions.some((e) => !e.subcategory || !e.areaId);
  const missing = CIVIC_CATEGORIES.filter((c) => !state.general[c]);
  const repeated = new Set(
    state.exceptions.map((e) => `${e.category}/${e.subcategory}`).filter((k, i, all) => k.split('/')[1] && all.indexOf(k) !== i),
  );
  const incomplete = state.exceptions.some((e) => !e.subcategory || !e.areaId);
  const ready = dirty && missing.length === 0 && repeated.size === 0 && !incomplete;

  const setGeneral = (c: CivicCategory, areaId: string) => setState((s) => ({ ...s, general: { ...s.general, [c]: areaId } }));
  const setException = (key: number, patch: Partial<Exception>) =>
    setState((s) => ({ ...s, exceptions: s.exceptions.map((e) => (e.key === key ? { ...e, ...patch } : e)) }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.areas.rules({ rules }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const areaSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select className={`${inputClass} h-9`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">Elegir área…</option>
      {active.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );

  return (
    <Card title="Qué reportes urbanos atiende cada área">
      <p className="text-sm text-ink-muted">
        El agente clasifica cada reporte; según su categoría llega al área que elijas aquí. Rige para los reportes nuevos: los abiertos siguen en
        su área y se pasan a mano desde la ficha.
      </p>
      <div className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2" data-testid="area-rules">
        {CIVIC_CATEGORIES.map((c) => (
          <label key={c} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-3 text-sm">
            <span className={state.general[c] ? '' : 'text-medium'}>{CATEGORY[c]}</span>
            {areaSelect(state.general[c], (v) => setGeneral(c, v), `Área para ${CATEGORY[c]}`)}
          </label>
        ))}
      </div>

      <h3 className="mt-6 text-sm font-medium">Excepciones por subcategoría</h3>
      <p className="text-xs text-ink-muted mt-0.5">Mandan sobre la regla de su categoría.</p>
      <div className="mt-2 space-y-2">
        {state.exceptions.map((e) => (
          <div key={e.key} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center" data-testid="area-exception">
            <select
              className={`${inputClass} h-9`}
              value={e.category}
              onChange={(ev) => setException(e.key, { category: ev.target.value as CivicCategory, subcategory: '' })}
              aria-label="Categoría"
            >
              {CIVIC_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY[c]}
                </option>
              ))}
            </select>
            <select
              className={`${inputClass} h-9 ${repeated.has(`${e.category}/${e.subcategory}`) ? 'border-high' : ''}`}
              value={e.subcategory}
              onChange={(ev) => setException(e.key, { subcategory: ev.target.value })}
              aria-label="Subcategoría"
            >
              <option value="">Elegir subcategoría…</option>
              {(SUBCATEGORIES[e.category] as readonly string[]).map((s) => (
                <option key={s} value={s}>
                  {subcategoryLabel(s)}
                </option>
              ))}
            </select>
            {areaSelect(e.areaId, (v) => setException(e.key, { areaId: v }), 'Área de la excepción')}
            <Button
              variant="ghost"
              className="h-9 px-2"
              aria-label="Quitar excepción"
              onClick={() => setState((s) => ({ ...s, exceptions: s.exceptions.filter((x) => x.key !== e.key) }))}
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          className="h-8 px-2 text-sm"
          onClick={() =>
            setState((s) => ({ ...s, exceptions: [...s.exceptions, { key: nextKey++, category: CIVIC_CATEGORIES[0], subcategory: '', areaId: '' }] }))
          }
        >
          <Plus size={15} /> Agregar excepción
        </Button>
      </div>

      {missing.length ? <p className="mt-3 text-xs text-medium">Falta elegir el área de: {missing.map((c) => CATEGORY[c]).join(', ')}.</p> : null}
      {repeated.size ? <p className="mt-1 text-xs text-high">Hay subcategorías repetidas.</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-high">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        {dirty ? (
          <Button variant="ghost" onClick={() => setState(fromCfg())} disabled={busy}>
            Descartar cambios
          </Button>
        ) : null}
        <Button variant="primary" onClick={() => void save()} busy={busy} disabled={!ready} data-testid="area-rules-save">
          Guardar reglas
        </Button>
      </div>
    </Card>
  );
}

function NameDialog({
  title,
  initial = '',
  hint,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: string;
  hint?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length >= 2 && name.trim() !== initial;
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          setError(null);
          try {
            await onSubmit(name.trim());
          } catch (err) {
            setError(errText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Nombre del área">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={AREA_NAME_MAX} required autoFocus />
        </Field>
        {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            Guardar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** La excepción (todas ven todo) y la vuelta a lo normal piden motivo: queda en la bitácora. */
function ModeDialog({ shared, onClose, onSaved }: { shared: boolean; onClose: () => void; onSaved: (next: AreasConfig) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = reason.trim().length >= 5;
  return (
    <Dialog title={shared ? 'Todas las áreas ven todo' : 'Volver a separar por área'} onClose={onClose} busy={busy}>
      <p className="text-sm text-ink-muted">
        {shared
          ? 'Todas las cuentas verán todas las alertas del municipio, de cualquier área. Es una excepción: úsala si la central es chica o en una contingencia.'
          : 'Cada cuenta volverá a ver solo las alertas de sus áreas. Las cuentas sin área solo verán alertas sin área.'}{' '}
        Las centrales abiertas se recargan solas.
      </p>
      <div className="mt-4">
        <Field label="Motivo (queda en la bitácora)">
          <textarea className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="areas-mode-reason" />
        </Field>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-high">
          {error}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!ready}
          data-testid="areas-mode-confirm"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onSaved(await api.areas.mode(shared, reason.trim()));
            } catch (e) {
              setError(errText(e));
              setBusy(false);
            }
          }}
        >
          {shared ? 'Activar la excepción' : 'Separar por área'}
        </Button>
      </div>
    </Dialog>
  );
}
