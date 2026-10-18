'use client';

import {
  INCIDENT_NATURES,
  incidentCode,
  type IncidentNature,
  type PlatformRole,
  type SecurityIncident,
  type TenantListItem,
} from '@guardia/shared';
import { useCallback, useEffect, useState } from 'react';
import { Shell, usePlatformSession } from '@/components/Shell';
import { Button, Card, Dialog, ErrorNote, Field, inputClass, Loading, Tag, textareaClass } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, INCIDENT_NATURE } from '@/lib/labels';

/** Igual que la API: cualquiera del equipo salvo finanzas declara un incidente y avisa (procedimiento 0.6). */
const INCIDENT_MANAGERS: PlatformRole[] = ['SUPERADMIN', 'IMPLEMENTATION', 'SUPPORT'];

/** «2026-10-15T14:30» en hora local, para un input datetime-local. */
const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/**
 * Incidentes de seguridad (Ley 21.719, art. 14 sexies y 15 bis; migración 0014). Guard-IA registra cada vulneración,
 * avisa a cada municipio afectado (el responsable, que reporta a la Agencia y avisa a los vecinos) y la cierra con las
 * medidas adoptadas. Procedimiento completo: docs/legal/procedimiento-incidentes.md. Nada se borra.
 */
export default function IncidentsPage() {
  const session = usePlatformSession();
  const [list, setList] = useState<SecurityIncident[] | null>(null);
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SecurityIncident | null>(null);
  const [notifying, setNotifying] = useState<SecurityIncident | null>(null);

  const reload = useCallback(() => {
    api
      .incidents()
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!session) return;
    reload();
    api
      .tenants()
      .then((t) => setTenants(t.filter((x) => x.status !== 'TERMINATED')))
      .catch(() => setTenants([]));
  }, [session, reload]);

  if (!session) return null;
  const canAct = INCIDENT_MANAGERS.includes(session.user.role);

  return (
    <Shell session={session}>
      <div className="flex items-end gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold">Incidentes de seguridad</h1>
          <p className="text-sm text-ink-muted max-w-3xl">
            Toda vulneración que afecte datos personales se registra aquí, aunque parezca menor. Avisa al municipio afectado sin
            demora: él reporta a la Agencia y avisa a los vecinos cuando corresponde (Ley 21.719, art. 14 sexies).
          </p>
        </div>
        {canAct ? (
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            Declarar incidente
          </Button>
        ) : null}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!list ? (
        <Card>
          <Loading />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">No hay incidentes registrados.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((i) => (
            <Card key={i.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{incidentCode(i.number)}</span>
                <Tag tone={i.status === 'OPEN' ? 'medium' : 'faint'}>{i.status === 'OPEN' ? 'Abierto' : 'Cerrado'}</Tag>
                <Tag>{INCIDENT_NATURE[i.nature]}</Tag>
                {i.sensitiveData ? <Tag tone="medium">Datos sensibles</Tag> : null}
                <span className="text-xs text-ink-muted">
                  Detectado {formatDateTime(i.detectedAt)} por {i.detectedBy}
                  {i.closedAt ? ` · cerrado ${formatDateTime(i.closedAt)}` : ''}
                </span>
                {canAct ? (
                  <span className="ml-auto flex gap-2">
                    <Button variant="ghost" className="h-8" onClick={() => setNotifying(i)}>
                      Avisar a un municipio
                    </Button>
                    <Button variant="quiet" className="h-8" onClick={() => setEditing(i)}>
                      Actualizar
                    </Button>
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm whitespace-pre-wrap">{i.summary}</p>
              <p className="mt-1 text-xs text-ink-muted">
                Datos: {i.dataCategories}
                {i.affectedEstimate !== null ? ` · ~${i.affectedEstimate} vecinos` : ''}
                {i.startedAt ? ` · inicio estimado ${formatDateTime(i.startedAt)}` : ''}
              </p>
              {i.measures ? <p className="mt-1 text-xs text-ink-muted">Medidas: {i.measures}</p> : null}
              <div className="mt-3">
                <h3 className="text-xs text-ink-muted mb-1">Municipios avisados</h3>
                {i.tenants.length === 0 ? (
                  <p className="text-sm text-medium">Ninguno todavía.</p>
                ) : (
                  <ul className="text-sm divide-y divide-line">
                    {i.tenants.map((t) => (
                      <li key={t.tenantId} className="py-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        <span className="font-medium">{t.tenantName}</span>
                        <span className="text-ink-muted">avisado {formatDateTime(t.notifiedAt)}</span>
                        <span className={t.agencyReportedAt ? 'text-ok' : 'text-medium'}>
                          Agencia: {t.agencyReportedAt ? `${formatDateTime(t.agencyReportedAt)}${t.agencyRef ? ` · ${t.agencyRef}` : ''}` : 'pendiente'}
                        </span>
                        <span className={t.subjectsNotifiedAt || t.subjectsNote ? 'text-ok' : 'text-ink-muted'}>
                          Vecinos:{' '}
                          {t.subjectsNotifiedAt
                            ? formatDateTime(t.subjectsNotifiedAt)
                            : t.subjectsNote
                              ? `no correspondía (${t.subjectsNote})`
                              : 'pendiente'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating ? (
        <CreateDialog
          tenants={tenants}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            reload();
          }}
        />
      ) : null}
      {editing ? (
        <UpdateDialog
          incident={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
      {notifying ? (
        <NotifyDialog
          incident={notifying}
          tenants={tenants.filter((t) => !notifying.tenants.some((x) => x.tenantId === t.id))}
          onClose={() => setNotifying(null)}
          onDone={() => {
            setNotifying(null);
            reload();
          }}
        />
      ) : null}
    </Shell>
  );
}

function CreateDialog({ tenants, onClose, onDone }: { tenants: TenantListItem[]; onClose: () => void; onDone: () => void }) {
  const [detectedAt, setDetectedAt] = useState(localNow);
  const [startedAt, setStartedAt] = useState('');
  const [detectedBy, setDetectedBy] = useState('');
  const [nature, setNature] = useState<IncidentNature>('UNAUTHORIZED_ACCESS');
  const [summary, setSummary] = useState('');
  const [dataCategories, setDataCategories] = useState('');
  const [affected, setAffected] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [measures, setMeasures] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title="Declarar incidente de seguridad" onClose={onClose} busy={busy} wide>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.createIncident({
              detectedAt: new Date(detectedAt).toISOString(),
              startedAt: startedAt ? new Date(startedAt).toISOString() : null,
              detectedBy: detectedBy.trim(),
              nature,
              summary: summary.trim(),
              dataCategories: dataCategories.trim(),
              affectedEstimate: affected.trim() === '' ? null : Number(affected),
              sensitiveData: sensitive,
              measures: measures.trim() || null,
              tenantIds: selected,
            });
            onDone();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-ink-muted">
          Registra lo que se sabe ahora; se completa después. No borres ni alteres logs ni archivos relacionados.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Detectado el">
            <input className={inputClass} type="datetime-local" value={detectedAt} onChange={(e) => setDetectedAt(e.target.value)} required />
          </Field>
          <Field label="Inicio estimado (opcional)">
            <input className={inputClass} type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
          </Field>
          <Field label="Quién lo detectó">
            <input className={inputClass} value={detectedBy} onChange={(e) => setDetectedBy(e.target.value)} required minLength={2} maxLength={120} />
          </Field>
          <Field label="Naturaleza">
            <select className={inputClass} value={nature} onChange={(e) => setNature(e.target.value as IncidentNature)}>
              {INCIDENT_NATURES.map((n) => (
                <option key={n} value={n}>
                  {INCIDENT_NATURE[n]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Qué pasó y sus efectos">
          <textarea className={textareaClass} value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={10} maxLength={2000} />
        </Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Datos afectados">
            <input className={inputClass} value={dataCategories} onChange={(e) => setDataCategories(e.target.value)} required minLength={2} maxLength={500} />
          </Field>
          <Field label="Vecinos afectados (aprox.)">
            <input className={inputClass} type="number" min={0} value={affected} onChange={(e) => setAffected(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
          Afecta datos sensibles (contenido de alertas de violencia o salud), de menores de 14 o económicos
        </label>
        <Field label="Medidas tomadas (opcional)">
          <textarea className={textareaClass} value={measures} onChange={(e) => setMeasures(e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Municipios afectados (se les avisa al guardar)">
          <div className="max-h-40 overflow-y-auto rounded-ctl border border-line p-2 space-y-1">
            {tenants.length === 0 ? (
              <p className="text-sm text-ink-muted">No hay municipios.</p>
            ) : (
              tenants.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(t.id)}
                    onChange={(e) => setSelected((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))}
                  />
                  {t.name}
                </label>
              ))
            )}
          </div>
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Declarar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UpdateDialog({ incident, onClose, onDone }: { incident: SecurityIncident; onClose: () => void; onDone: () => void }) {
  const [summary, setSummary] = useState(incident.summary);
  const [dataCategories, setDataCategories] = useState(incident.dataCategories);
  const [affected, setAffected] = useState(incident.affectedEstimate === null ? '' : String(incident.affectedEstimate));
  const [sensitive, setSensitive] = useState(incident.sensitiveData);
  const [measures, setMeasures] = useState(incident.measures ?? '');
  const [close, setClose] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title={`Actualizar ${incidentCode(incident.number)}`} onClose={onClose} busy={busy} wide>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.updateIncident(incident.id, {
              summary: summary.trim(),
              dataCategories: dataCategories.trim(),
              affectedEstimate: affected.trim() === '' ? null : Number(affected),
              sensitiveData: sensitive,
              measures: measures.trim() || null,
              ...(close ? { status: 'CLOSED' as const } : reopen ? { status: 'OPEN' as const } : {}),
            });
            onDone();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Qué pasó y sus efectos">
          <textarea className={textareaClass} value={summary} onChange={(e) => setSummary(e.target.value)} required minLength={10} maxLength={2000} />
        </Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Datos afectados">
            <input className={inputClass} value={dataCategories} onChange={(e) => setDataCategories(e.target.value)} required minLength={2} maxLength={500} />
          </Field>
          <Field label="Vecinos afectados (aprox.)">
            <input className={inputClass} type="number" min={0} value={affected} onChange={(e) => setAffected(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
          Afecta datos sensibles, de menores de 14 o económicos
        </label>
        <Field label="Medidas adoptadas y para que no se repita">
          <textarea className={textareaClass} value={measures} onChange={(e) => setMeasures(e.target.value)} maxLength={2000} />
        </Field>
        {incident.status === 'OPEN' ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} />
            Cerrar el incidente (exige las medidas adoptadas)
          </label>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={reopen} onChange={(e) => setReopen(e.target.checked)} />
            Reabrir el incidente
          </label>
        )}
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

function NotifyDialog({
  incident,
  tenants,
  onClose,
  onDone,
}: {
  incident: SecurityIncident;
  tenants: TenantListItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [tenantId, setTenantId] = useState(tenants[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={`Avisar ${incidentCode(incident.number)} a un municipio`} onClose={onClose} busy={busy}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.notifyIncidentTenant(incident.id, tenantId);
            onDone();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-ink-muted">
          El municipio lo ve en «Privacidad» de su central y en su bitácora. Envía además el aviso por correo al delegado, con
          la plantilla A del procedimiento.
        </p>
        {tenants.length === 0 ? (
          <p className="text-sm text-ink-muted">Todos los municipios ya fueron avisados.</p>
        ) : (
          <Field label="Municipio">
            <select className={inputClass} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!tenantId}>
            Avisar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
