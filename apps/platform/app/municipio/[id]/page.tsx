'use client';

import type { PlatformAuditEntry, TenantDetail, TenantStatus, UpdateTenant } from '@guardia/shared';
import { ArrowLeft, CheckCircle2, Circle, KeyRound, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PersonDialog, StatusDialog, TemporaryPasswordDialog, TestPhoneDialog } from '@/components/TenantDialogs';
import { canManage, Shell, usePlatformSession } from '@/components/Shell';
import { Button, Card, ErrorNote, Field, inputClass, Loading, StatusTag, Tag } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ACTION, formatDate, formatDateTime, READINESS, STATUS_ACTION } from '@/lib/labels';

type Secret = { title: string; email: string; password: string };

export default function TenantPage() {
  const session = usePlatformSession();
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<TenantDetail | null>(null);
  const [log, setLog] = useState<PlatformAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusTo, setStatusTo] = useState<TenantStatus | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [d, l] = await Promise.all([api.tenant(id), api.audit({ tenantId: id, limit: 20 })]);
      setT(d);
      setLog(l.items);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    if (session) void reload();
  }, [session, reload]);

  if (!session) return null;
  const manager = canManage(session);

  return (
    <Shell session={session}>
      <Link
        href={t?.regionCut ? `/region/${t.regionCut}?comuna=${t.comunaCut}` : '/municipios'}
        className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink mb-3"
      >
        <ArrowLeft size={16} /> {t?.regionName ?? 'Municipios'}
      </Link>
      <ErrorNote>{error}</ErrorNote>
      {!t ? (
        <Loading />
      ) : (
        <>
          <div className="flex flex-wrap items-start gap-4 mb-5">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold truncate">{t.name}</h1>
                <StatusTag status={t.status} />
              </div>
              <p className="text-sm text-ink-muted">
                {t.comunaName ? `${t.comunaName} · Provincia de ${t.provinciaName} · ${t.regionName}` : 'Municipio sin comuna (límite propio)'}
                {t.goLiveAt ? ` · en servicio desde ${formatDate(t.goLiveAt)}` : ''}
              </p>
              {t.statusReason ? (
                <p className="text-xs text-ink-faint mt-1">
                  Último cambio de estado ({formatDateTime(t.statusChangedAt)}): {t.statusReason}
                </p>
              ) : null}
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              {t.transitions.map((s) => (
                <Button key={s} variant={s === 'ACTIVE' ? 'primary' : 'danger'} onClick={() => setStatusTo(s)}>
                  {STATUS_ACTION[s]}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
            <Card
              title="Puesta en marcha"
              actions={t.readiness.ready ? <Tag tone="ok">Completa</Tag> : <Tag tone="medium">Pendiente</Tag>}
            >
              <ul className="space-y-2">
                {t.readiness.items.map((i) => (
                  <li key={i.key} className="flex items-start gap-2 text-sm">
                    {i.ok ? (
                      <CheckCircle2 size={18} className="text-ok shrink-0 mt-0.5" aria-label="Listo" />
                    ) : (
                      <Circle size={18} className="text-ink-faint shrink-0 mt-0.5" aria-label="Falta" />
                    )}
                    <span className="flex-1">
                      <span className={i.ok ? '' : 'text-ink'}>{READINESS[i.key].label}</span>
                      <span className="block text-xs text-ink-faint">
                        {i.count}/{i.required} · {READINESS[i.key].who}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {t.status === 'ONBOARDING' ? (
                <p className="text-xs text-ink-faint mt-4">
                  Activar exige la lista completa: lo valida la base de datos, no solo esta pantalla.
                </p>
              ) : null}
            </Card>

            <div className="space-y-5">
              <Card title="Actividad (30 días)">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <Metric label="Alertas" value={t.alertsMonth} />
                  <Metric label="SOS" value={t.sosMonth} />
                  <Metric label="Abiertas ahora" value={t.openAlerts} />
                </div>
                <p className="text-xs text-ink-faint mt-3">Solo cifras: la consola no ve alertas, vecinos ni casos.</p>
              </Card>

              <Card title="Uso indebido">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                  <Metric label="Faltas (30 días)" value={t.misuse.strikesMonth} />
                  <Metric label="Bloqueos vigentes" value={t.misuse.activeBlocks} />
                  <Metric label="Bloqueos por aprobar" value={t.misuse.pendingProposals} />
                  <Metric label="Revisiones pendientes" value={t.misuse.pendingReviews} />
                </div>
                <p className="text-xs text-ink-faint mt-3">
                  Lo decide la central del municipio. Si se acumulan revisiones sin responder, conviene hablar con el
                  municipio.
                </p>
              </Card>

              <Card
                title="Administradores municipales"
                actions={
                  manager && t.status !== 'TERMINATED' ? (
                    <Button variant="quiet" className="h-8" onClick={() => setAdminOpen(true)}>
                      Crear administrador
                    </Button>
                  ) : null
                }
              >
                {t.admins.length === 0 ? (
                  <p className="text-sm text-ink-muted">Sin administrador todavía. Es el primer paso de la puesta en marcha.</p>
                ) : (
                  <ul className="divide-y divide-line -my-2">
                    {t.admins.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">{a.name}</span>
                          <span className="block text-xs text-ink-faint truncate">
                            {a.email} · {a.lastLoginAt ? `último ingreso ${formatDateTime(a.lastLoginAt)}` : 'nunca ha ingresado'}
                          </span>
                        </span>
                        {!a.active ? <Tag tone="faint">Desactivado</Tag> : a.mustChangePassword ? <Tag tone="medium">Contraseña temporal</Tag> : <Tag tone="ok">Activo</Tag>}
                        {manager ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2"
                            aria-label={`Restablecer acceso de ${a.name}`}
                            title="Restablecer acceso: contraseña temporal nueva"
                            busy={busyRow === a.id}
                            onClick={async () => {
                              setBusyRow(a.id);
                              try {
                                const r = await api.resetAdmin(t.id, a.id);
                                setSecret({ title: 'Acceso restablecido', email: r.admin.email, password: r.temporaryPassword });
                                await reload();
                              } catch (e) {
                                setError(errorMessage(e));
                              } finally {
                                setBusyRow(null);
                              }
                            }}
                          >
                            <KeyRound size={16} />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                title="Teléfonos de prueba"
                actions={
                  manager && t.status !== 'TERMINATED' ? (
                    <Button variant="quiet" className="h-8" onClick={() => setPhoneOpen(true)}>
                      Agregar
                    </Button>
                  ) : null
                }
              >
                <p className="text-xs text-ink-faint mb-3">
                  {t.status === 'ONBOARDING'
                    ? 'En implementación solo estos teléfonos llegan a la central; los vecinos ven "fuera de cobertura".'
                    : 'Sirven para la prueba de extremo a extremo; en servicio, todos los vecinos llegan a la central.'}
                </p>
                {t.testPhones.length === 0 ? (
                  <p className="text-sm text-ink-muted">Ninguno.</p>
                ) : (
                  <ul className="divide-y divide-line -my-2">
                    {t.testPhones.map((p) => (
                      <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
                        <span className="font-mono">{p.phone}</span>
                        <span className="flex-1 min-w-0 truncate text-ink-muted">{p.label}</span>
                        {manager ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-2"
                            aria-label={`Quitar ${p.phone}`}
                            busy={busyRow === p.id}
                            onClick={async () => {
                              setBusyRow(p.id);
                              try {
                                await api.removeTestPhone(t.id, p.id);
                                await reload();
                              } catch (e) {
                                setError(errorMessage(e));
                              } finally {
                                setBusyRow(null);
                              }
                            }}
                          >
                            <Trash2 size={16} />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>

          <ProfileCard tenant={t} editable={manager && t.status !== 'TERMINATED'} onSaved={setT} />

          <Card title="Bitácora de este municipio" className="mt-5">
            {log.length === 0 ? (
              <p className="text-sm text-ink-muted">Sin movimientos.</p>
            ) : (
              <ul className="divide-y divide-line -my-2">
                {log.map((e) => (
                  <li key={e.id} className="py-2 text-sm flex flex-wrap gap-x-3">
                    <span className="text-ink-faint tabular-nums w-32 shrink-0">{formatDateTime(e.createdAt)}</span>
                    <span className="flex-1 min-w-0">
                      {ACTION[e.action]}
                      {e.payload && 'to' in e.payload ? ` → ${String(e.payload.to)}` : ''}
                      {e.reason ? <span className="text-ink-muted"> · {e.reason}</span> : null}
                    </span>
                    <span className="text-ink-muted">{e.actorName ?? 'Sistema'}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/bitacora" className="inline-block mt-3 text-xs text-accent hover:underline">
              Ver la bitácora completa
            </Link>
          </Card>
        </>
      )}

      {t && statusTo ? (
        <StatusDialog
          tenant={t}
          to={statusTo}
          onClose={() => setStatusTo(null)}
          onDone={(d) => {
            setStatusTo(null);
            setT(d);
            void reload();
          }}
        />
      ) : null}
      {t && adminOpen ? (
        <PersonDialog
          title="Crear administrador municipal"
          intro="Recibe una contraseña temporal que debe cambiar al entrar a la central. Desde ahí crea a sus operadores, contactos, unidades y turnos."
          submitLabel="Crear"
          onClose={() => setAdminOpen(false)}
          onSubmit={async (v) => {
            const r = await api.createAdmin(t.id, v);
            setAdminOpen(false);
            setSecret({ title: 'Administrador creado', email: r.admin.email, password: r.temporaryPassword });
            await reload();
          }}
        />
      ) : null}
      {t && phoneOpen ? (
        <TestPhoneDialog
          tenantId={t.id}
          onClose={() => setPhoneOpen(false)}
          onDone={() => {
            setPhoneOpen(false);
            void reload();
          }}
        />
      ) : null}
      {secret ? (
        <TemporaryPasswordDialog title={secret.title} email={secret.email} password={secret.password} where="la central" onClose={() => setSecret(null)} />
      ) : null}
    </Shell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  );
}

type ProfileForm = {
  name: string;
  legalName: string;
  rut: string;
  address: string;
  techContactName: string;
  techContactEmail: string;
  techContactPhone: string;
  billingContactName: string;
  billingContactEmail: string;
  contractSignedAt: string;
  dpaSignedAt: string;
  audioRetentionDays: string;
};

function toForm(t: TenantDetail): ProfileForm {
  return {
    name: t.name,
    legalName: t.legalName ?? '',
    rut: t.rut ?? '',
    address: t.address ?? '',
    techContactName: t.techContactName ?? '',
    techContactEmail: t.techContactEmail ?? '',
    techContactPhone: t.techContactPhone ?? '',
    billingContactName: t.billingContactName ?? '',
    billingContactEmail: t.billingContactEmail ?? '',
    contractSignedAt: t.contractSignedAt ?? '',
    dpaSignedAt: t.dpaSignedAt ?? '',
    audioRetentionDays: String(t.audioRetentionDays),
  };
}

/** Ficha del municipio (RF-3.1, 3.7). La fecha de firma del contrato y del anexo es requisito para activar. */
function ProfileCard({ tenant, editable, onSaved }: { tenant: TenantDetail; editable: boolean; onSaved: (t: TenantDetail) => void }) {
  const [form, setForm] = useState<ProfileForm>(() => toForm(tenant));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setForm(toForm(tenant)), [tenant]);

  const set = (k: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };
  const text = (k: keyof ProfileForm, label: string, type = 'text', hint?: string) => (
    <Field label={label} hint={hint}>
      <input className={inputClass} type={type} value={form[k]} onChange={set(k)} disabled={!editable} />
    </Field>
  );

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const orNull = (v: string) => (v.trim() === '' ? null : v.trim());
    const body: UpdateTenant = {
      name: form.name.trim(),
      legalName: orNull(form.legalName),
      rut: orNull(form.rut),
      address: orNull(form.address),
      techContactName: orNull(form.techContactName),
      techContactEmail: orNull(form.techContactEmail),
      techContactPhone: orNull(form.techContactPhone),
      billingContactName: orNull(form.billingContactName),
      billingContactEmail: orNull(form.billingContactEmail),
      contractSignedAt: orNull(form.contractSignedAt),
      dpaSignedAt: orNull(form.dpaSignedAt),
      audioRetentionDays: Number(form.audioRetentionDays),
    };
    try {
      onSaved(await api.updateTenant(tenant.id, body));
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Ficha del municipio" className="mt-5">
      <form onSubmit={save} className="space-y-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {text('name', 'Nombre en Guard-IA')}
          {text('legalName', 'Razón social')}
          {text('rut', 'RUT', 'text', 'Con o sin puntos')}
          {text('address', 'Dirección')}
          {text('techContactName', 'Contacto técnico')}
          {text('techContactEmail', 'Correo del contacto técnico', 'email')}
          {text('techContactPhone', 'Teléfono del contacto técnico', 'tel')}
          {text('billingContactName', 'Contacto de facturación')}
          {text('billingContactEmail', 'Correo de facturación', 'email')}
          {text('contractSignedAt', 'Contrato firmado el', 'date')}
          {text('dpaSignedAt', 'Anexo de tratamiento de datos firmado el', 'date')}
          {text('audioRetentionDays', 'Retención de audio (días)', 'number')}
        </div>
        <ErrorNote>{error}</ErrorNote>
        {editable ? (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" busy={busy}>
              Guardar ficha
            </Button>
            {saved ? <span className="text-sm text-ok">Guardada</span> : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
