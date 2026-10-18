'use client';

import { incidentCode, type TenantIncident, type TenantPrivacyOverview } from '@guardia/shared';
import { ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, INCIDENT_NATURE, SUBPROCESSOR_SERVICE } from '@/lib/labels';
import { AdminShell, Card, errText, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Button, Dialog, Field, inputClass, Spinner, Tag, textareaClass } from '@/components/ui';

type Form = {
  contactEmail: string;
  contactAddress: string;
  dpoName: string;
  dpoEmail: string;
  policyUrl: string;
  policyVersion: string;
};

const EMPTY: Form = { contactEmail: '', contactAddress: '', dpoName: '', dpoEmail: '', policyUrl: '', policyVersion: '' };

/** «2026-10-15T14:30» en hora local, para un input datetime-local. */
const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/**
 * Privacidad del municipio (Ley 21.719, migración 0014). La municipalidad es la responsable de los datos de los
 * vecinos: aquí fija a quién pueden pedir sus derechos, ve qué proveedores autorizó y registra su parte de cada
 * incidente de seguridad que le avise Guard-IA. Lo edita el administrador; el supervisor lo consulta.
 */
export default function PrivacyPage() {
  const session = useOperatorSession(['ADMIN', 'SUPERVISOR']);
  const isAdmin = session?.operator.role === 'ADMIN';
  const [data, setData] = useState<TenantPrivacyOverview | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<{ incident: TenantIncident; kind: 'agency' | 'subjects' } | null>(null);

  const apply = useCallback((next: TenantPrivacyOverview) => {
    setData(next);
    const p = next.privacy;
    setForm(
      p
        ? {
            contactEmail: p.contactEmail,
            contactAddress: p.contactAddress ?? '',
            dpoName: p.dpoName ?? '',
            dpoEmail: p.dpoEmail ?? '',
            policyUrl: p.policyUrl ?? '',
            policyVersion: p.policyVersion ?? '',
          }
        : EMPTY,
    );
  }, []);

  useEffect(() => {
    if (!session) return;
    api.privacy
      .overview()
      .then(apply)
      .catch((e) => setError(errText(e)));
  }, [session, apply]);

  if (!session) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      apply(await api.privacy.update(form));
      setNotice('Contacto guardado. Los vecinos lo ven en la app, en cada caso de tu municipio.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <AdminShell session={session} title="Privacidad">
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <p className="text-sm text-ink-muted max-w-3xl">
        Tu municipalidad es la responsable de los datos de los vecinos que atiende (Ley 21.719). Guard-IA los trata por
        encargo suyo y solo con los proveedores que autorizó por escrito.
      </p>
      {!data ? (
        <p className="text-sm text-ink-muted flex items-center gap-2">
          <Spinner /> Cargando…
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Contacto para los vecinos">
            {!data.privacy ? (
              <div className="mb-3">
                <Notice kind="error">
                  Falta el contacto: los vecinos deben saber a quién pedir sus datos (art. 14 ter). También es requisito para
                  poner en marcha el servicio.
                </Notice>
              </div>
            ) : null}
            <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
              <Field label="Correo para ejercer derechos *">
                <input className={inputClass} type="email" required value={form.contactEmail} onChange={set('contactEmail')} disabled={!isAdmin} />
              </Field>
              <Field label="Dirección (opcional)">
                <input className={inputClass} value={form.contactAddress} onChange={set('contactAddress')} disabled={!isAdmin} maxLength={200} />
              </Field>
              <Field label="Delegado de protección de datos">
                <input className={inputClass} value={form.dpoName} onChange={set('dpoName')} disabled={!isAdmin} maxLength={120} />
              </Field>
              <Field label="Correo del delegado">
                <input className={inputClass} type="email" value={form.dpoEmail} onChange={set('dpoEmail')} disabled={!isAdmin} />
              </Field>
              <Field label="Política de tratamiento (https://…)">
                <input className={inputClass} type="url" value={form.policyUrl} onChange={set('policyUrl')} disabled={!isAdmin} />
              </Field>
              <Field label="Versión de la política">
                <input className={inputClass} value={form.policyVersion} onChange={set('policyVersion')} disabled={!isAdmin} maxLength={40} />
              </Field>
              {isAdmin ? (
                <div className="sm:col-span-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-ink-muted">
                    {data.privacy ? `Actualizado ${formatDateTime(data.privacy.updatedAt)}` : 'Aparece en la app del vecino, en cada caso.'}
                  </span>
                  <Button type="submit" variant="primary" busy={saving}>
                    Guardar
                  </Button>
                </div>
              ) : null}
            </form>
          </Card>

          <Card title="Proveedores autorizados (subencargados)">
            {data.missingSubprocessors.length ? (
              <div className="mb-3">
                <Notice kind="error">
                  En uso y sin tu autorización: {data.missingSubprocessors.map((m) => `${m.name} (${SUBPROCESSOR_SERVICE[m.service]})`).join(', ')}.
                  Guard-IA no los usa para tu municipio hasta que los autorices por escrito; mientras tanto, las alertas se
                  clasifican sin IA externa.
                </Notice>
              </div>
            ) : null}
            {data.subprocessors.length === 0 ? (
              <p className="text-sm text-ink-muted">Aún no hay autorizaciones registradas.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.subprocessors.map((s) => (
                  <li key={s.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{s.name}</span>
                      <Tag tone={s.inUse ? 'accent' : 'neutral'}>{SUBPROCESSOR_SERVICE[s.service]}</Tag>
                    </div>
                    <p className="text-xs text-ink-muted">
                      {s.country} · autorizado el {s.authorizedAt} por {s.authorizedBy} · {s.documentRef}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-muted">
              Las autorizaciones las registra el equipo Guard-IA con el documento firmado por tu municipio; quedan en la bitácora.
            </p>
          </Card>

          <Card title="Incidentes de seguridad" className="xl:col-span-2">
            {data.incidents.length === 0 ? (
              <p className="text-sm text-ink-muted flex items-center gap-2">
                <ShieldCheck size={16} className="text-ok" /> Guard-IA no ha informado incidentes que afecten a tu municipio.
              </p>
            ) : (
              <ul className="space-y-3">
                {data.incidents.map((i) => (
                  <li key={i.id} className="rounded-ctl border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{incidentCode(i.number)}</span>
                      <Tag tone={i.status === 'OPEN' ? 'high' : 'neutral'}>{i.status === 'OPEN' ? 'Abierto' : 'Cerrado'}</Tag>
                      <Tag>{INCIDENT_NATURE[i.nature]}</Tag>
                      {i.sensitiveData ? <Tag tone="medium">Datos sensibles</Tag> : null}
                      <span className="text-xs text-ink-muted">Detectado {formatDateTime(i.detectedAt)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap">{i.summary}</p>
                    <p className="mt-1 text-xs text-ink-muted">
                      Datos: {i.dataCategories}
                      {i.affectedEstimate !== null ? ` · ~${i.affectedEstimate} vecinos` : ''}
                    </p>
                    {i.measures ? <p className="mt-1 text-xs text-ink-muted">Medidas: {i.measures}</p> : null}
                    <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
                      <div>
                        <span className="block text-ink-muted">Guard-IA avisó</span>
                        {formatDateTime(i.tenant.notifiedAt)}
                      </div>
                      <div>
                        <span className="block text-ink-muted">Reporte a la Agencia</span>
                        {i.tenant.agencyReportedAt ? (
                          `${formatDateTime(i.tenant.agencyReportedAt)}${i.tenant.agencyRef ? ` · ${i.tenant.agencyRef}` : ''}`
                        ) : isAdmin ? (
                          <Button className="h-7 px-2 text-xs" onClick={() => setReport({ incident: i, kind: 'agency' })}>
                            Registrar reporte
                          </Button>
                        ) : (
                          'Pendiente'
                        )}
                      </div>
                      <div>
                        <span className="block text-ink-muted">Aviso a los vecinos</span>
                        {i.tenant.subjectsNotifiedAt || i.tenant.subjectsNote ? (
                          [i.tenant.subjectsNotifiedAt ? formatDateTime(i.tenant.subjectsNotifiedAt) : null, i.tenant.subjectsNote]
                            .filter(Boolean)
                            .join(' · ')
                        ) : isAdmin ? (
                          <Button className="h-7 px-2 text-xs" onClick={() => setReport({ incident: i, kind: 'subjects' })}>
                            Registrar aviso
                          </Button>
                        ) : (
                          'Pendiente'
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-muted">
              Tu municipio reporta a la Agencia sin dilaciones indebidas y avisa a los vecinos afectados si hay datos sensibles,
              de menores de 14 o económicos (art. 14 sexies). Procedimiento: docs/legal/procedimiento-incidentes.md.
            </p>
          </Card>
        </div>
      )}

      {report ? (
        <ReportDialog
          incident={report.incident}
          kind={report.kind}
          onClose={() => setReport(null)}
          onDone={(next, text) => {
            apply(next);
            setReport(null);
            setNotice(text);
          }}
        />
      ) : null}
    </AdminShell>
  );
}

function ReportDialog({
  incident,
  kind,
  onClose,
  onDone,
}: {
  incident: TenantIncident;
  kind: 'agency' | 'subjects';
  onClose: () => void;
  onDone: (next: TenantPrivacyOverview, text: string) => void;
}) {
  const [at, setAt] = useState(localNow);
  const [text, setText] = useState('');
  const [notApplicable, setNotApplicable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agency = kind === 'agency';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const when = new Date(at).toISOString();
      const next = await api.privacy.report(
        incident.id,
        agency
          ? { agencyReportedAt: when, agencyRef: text }
          : notApplicable
            ? { subjectsNotifiedAt: null, subjectsNote: text }
            : { subjectsNotifiedAt: when, subjectsNote: text },
      );
      onDone(next, agency ? 'Reporte a la Agencia registrado.' : 'Aviso a los vecinos registrado.');
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`${incidentCode(incident.number)} · ${agency ? 'Reporte a la Agencia' : 'Aviso a los vecinos'}`} onClose={onClose} busy={busy}>
      <div className="space-y-3">
        {!agency ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={notApplicable} onChange={(e) => setNotApplicable(e.target.checked)} />
            No correspondía avisar (explica por qué)
          </label>
        ) : null}
        {agency || !notApplicable ? (
          <Field label={agency ? 'Fecha y hora del reporte' : 'Fecha y hora del aviso'}>
            <input className={inputClass} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        ) : null}
        <Field label={agency ? 'Folio o referencia del reporte' : notApplicable ? 'Motivo' : 'Cómo se avisó (app, SMS, publicación)'}>
          <textarea className={textareaClass} value={text} onChange={(e) => setText(e.target.value)} maxLength={agency ? 200 : 1000} />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" busy={busy} disabled={notApplicable && text.trim().length < 5} onClick={() => void submit()}>
            Registrar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
