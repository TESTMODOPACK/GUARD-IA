'use client';

import { SUBPROCESSOR_SERVICES, type Subprocessor, type SubprocessorService } from '@guardia/shared';
import { useCallback, useEffect, useState } from 'react';
import { Shell, usePlatformSession } from '@/components/Shell';
import { Button, Card, Dialog, ErrorNote, Field, inputClass, Loading, Tag, textareaClass } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SUBPROCESSOR_SERVICE } from '@/lib/labels';

type Form = {
  key: string;
  name: string;
  service: SubprocessorService;
  country: string;
  dataCategories: string;
  guarantee: string;
  inUse: boolean;
};

const EMPTY: Form = { key: '', name: '', service: 'AI', country: '', dataCategories: '', guarantee: '', inUse: false };

/**
 * Subencargados (Ley 21.719, art. 15 bis; migración 0014): los proveedores que reciben datos de los vecinos. Los que
 * están "en uso" deben estar autorizados por escrito por cada municipio antes de activarlo; sin autorización, Guard-IA
 * no les envía datos de ese municipio. El aviso al vecino nombra el proveedor de IA configurado en el servidor.
 */
export default function SubprocessorsPage() {
  const session = usePlatformSession();
  const [list, setList] = useState<Subprocessor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Subprocessor | 'new' | null>(null);

  const reload = useCallback(() => {
    api
      .subprocessors()
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (session) reload();
  }, [session, reload]);

  if (!session) return null;
  const superadmin = session.user.role === 'SUPERADMIN';

  return (
    <Shell session={session}>
      <div className="flex items-end gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold">Subencargados</h1>
          <p className="text-sm text-ink-muted max-w-3xl">
            Proveedores que reciben datos de los vecinos (Ley 21.719, art. 15 bis). Los que están en uso deben estar autorizados
            por escrito por cada municipio: se registra en la ficha del municipio y es requisito para activarlo.
          </p>
        </div>
        {superadmin ? (
          <Button variant="primary" className="ml-auto" onClick={() => setEditing('new')}>
            Agregar
          </Button>
        ) : null}
      </div>
      <ErrorNote>{error}</ErrorNote>
      <Card>
        {!list ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-muted text-left">
                <tr>
                  <th className="py-2 pr-3 font-normal">Proveedor</th>
                  <th className="py-2 pr-3 font-normal">Servicio</th>
                  <th className="py-2 pr-3 font-normal">País</th>
                  <th className="py-2 pr-3 font-normal">Datos que recibe</th>
                  <th className="py-2 pr-3 font-normal">Garantía</th>
                  <th className="py-2 pr-3 font-normal">Municipios</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-ink-faint font-mono">{s.key}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <div>{SUBPROCESSOR_SERVICE[s.service]}</div>
                      {s.inUse ? <Tag tone="accent">En uso</Tag> : <Tag tone="faint">Sin uso</Tag>}
                    </td>
                    <td className="py-2 pr-3">{s.country}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.dataCategories}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.guarantee ?? '—'}</td>
                    <td className="py-2 pr-3">{s.authorizedTenants}</td>
                    <td className="py-2 text-right">
                      {superadmin ? (
                        <Button variant="ghost" className="h-8" onClick={() => setEditing(s)}>
                          Editar
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing ? (
        <SubprocessorDialog
          current={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(l) => {
            setList(l);
            setEditing(null);
          }}
        />
      ) : null}
    </Shell>
  );
}

function SubprocessorDialog({
  current,
  onClose,
  onDone,
}: {
  current: Subprocessor | null;
  onClose: () => void;
  onDone: (l: Subprocessor[]) => void;
}) {
  const [form, setForm] = useState<Form>(() =>
    current
      ? {
          key: current.key,
          name: current.name,
          service: current.service,
          country: current.country,
          dataCategories: current.dataCategories,
          guarantee: current.guarantee ?? '',
          inUse: current.inUse,
        }
      : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog title={current ? `Editar ${current.name}` : 'Agregar subencargado'} onClose={onClose} busy={busy} wide>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const body = {
            name: form.name.trim(),
            service: form.service,
            country: form.country.trim(),
            dataCategories: form.dataCategories.trim(),
            guarantee: form.guarantee.trim() || null,
            inUse: form.inUse,
          };
          try {
            onDone(current ? await api.updateSubprocessor(current.id, body) : await api.createSubprocessor({ ...body, key: form.key.trim() }));
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Clave" hint="Igual a AI_PROCESSOR_KEY si es el de IA (minúsculas)">
            <input className={inputClass} value={form.key} onChange={set('key')} required disabled={!!current} pattern="[a-z0-9][a-z0-9_\-]{1,39}" />
          </Field>
          <Field label="Nombre">
            <input className={inputClass} value={form.name} onChange={set('name')} required minLength={2} maxLength={120} />
          </Field>
          <Field label="Servicio">
            <select className={inputClass} value={form.service} onChange={set('service')}>
              {SUBPROCESSOR_SERVICES.map((s) => (
                <option key={s} value={s}>
                  {SUBPROCESSOR_SERVICE[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="País donde trata los datos">
            <input className={inputClass} value={form.country} onChange={set('country')} required minLength={2} maxLength={80} />
          </Field>
        </div>
        <Field label="Datos que recibe" hint="Se muestra al vecino en el aviso">
          <textarea className={textareaClass} value={form.dataCategories} onChange={set('dataCategories')} required minLength={2} maxLength={500} />
        </Field>
        <Field label="Garantía" hint="Cláusulas contractuales, país adecuado, sin retención ni entrenamiento…">
          <textarea className={textareaClass} value={form.guarantee} onChange={set('guarantee')} maxLength={500} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.inUse} onChange={(e) => setForm((f) => ({ ...f, inUse: e.target.checked }))} />
          En uso: cada municipio debe autorizarlo antes de activarse
        </label>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Guardar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
