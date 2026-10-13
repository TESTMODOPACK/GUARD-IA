'use client';

import { useState } from 'react';
import type { TenantDetail, TenantStatus } from '@guardia/shared';
import { api, errorMessage } from '@/lib/api';
import { STATUS_ACTION, STATUS_EFFECT } from '@/lib/labels';
import { Button, Dialog, ErrorNote, Field, inputClass, SecretValue, textareaClass } from './ui';

/** Alta de un municipio desde su comuna (RF-3.1). Nace en implementación. */
export function CreateTenantDialog({
  comuna,
  onClose,
  onCreated,
}: {
  comuna: { cut: number; name: string; regionName: string };
  onClose: () => void;
  onCreated: (t: TenantDetail) => void;
}) {
  const [name, setName] = useState(`Municipalidad de ${comuna.name}`);
  const [legalName, setLegalName] = useState(`Ilustre Municipalidad de ${comuna.name}`);
  const [rut, setRut] = useState('');
  const [address, setAddress] = useState('');
  const [techContactName, setTechName] = useState('');
  const [techContactEmail, setTechEmail] = useState('');
  const [billingContactEmail, setBillingEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.createTenant({
        comunaCut: comuna.cut,
        name: name.trim(),
        legalName: legalName.trim() || null,
        rut: rut.trim() || null,
        address: address.trim() || null,
        techContactName: techContactName.trim() || null,
        techContactEmail: techContactEmail.trim() || null,
        billingContactEmail: billingContactEmail.trim() || null,
      });
      onCreated(t);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Dar de alta: ${comuna.name}`} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink-muted">
          {comuna.regionName} · CUT {String(comuna.cut).padStart(5, '0')}. El municipio toma el límite oficial de la comuna y
          queda <strong className="text-ink">en implementación</strong>: solo sus teléfonos de prueba llegan a la central hasta que
          se active.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Nombre en Guard-IA">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
          </Field>
          <Field label="Razón social">
            <input className={inputClass} value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={160} />
          </Field>
          <Field label="RUT" hint="Con o sin puntos: 69.070.100-7">
            <input className={inputClass} value={rut} onChange={(e) => setRut(e.target.value)} maxLength={12} placeholder="69.000.000-0" />
          </Field>
          <Field label="Dirección">
            <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Contacto técnico">
            <input className={inputClass} value={techContactName} onChange={(e) => setTechName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Correo del contacto técnico">
            <input className={inputClass} type="email" value={techContactEmail} onChange={(e) => setTechEmail(e.target.value)} maxLength={160} />
          </Field>
          <Field label="Correo de facturación">
            <input className={inputClass} type="email" value={billingContactEmail} onChange={(e) => setBillingEmail(e.target.value)} maxLength={160} />
          </Field>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Dar de alta
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Activar, suspender o dar de baja. Se confirma escribiendo el nombre de la comuna (como al borrar un
 * repositorio): un clic equivocado no puede dejar a una comuna sin central.
 */
export function StatusDialog({
  tenant,
  to,
  onClose,
  onDone,
}: {
  tenant: TenantDetail;
  to: TenantStatus;
  onClose: () => void;
  onDone: (t: TenantDetail) => void;
}) {
  const expected = tenant.comunaName ?? tenant.name;
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = to === 'ACTIVE' && tenant.status === 'ONBOARDING' && !tenant.readiness.ready;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.changeStatus(tenant.id, { status: to, reason: reason.trim(), confirmName: confirmName.trim() }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`${STATUS_ACTION[to]}: ${tenant.name}`} onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink-muted">{STATUS_EFFECT[to]}</p>
        {missing ? (
          <p className="text-sm text-medium">La lista de puesta en marcha está incompleta: la base no permitirá activarlo todavía.</p>
        ) : null}
        <Field label="Motivo (queda en la bitácora de la plataforma y del municipio)">
          <textarea className={textareaClass} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={500} required />
        </Field>
        <Field label={`Para confirmar, escribe "${expected}"`}>
          <input className={inputClass} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" required />
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant={to === 'ACTIVE' ? 'primary' : 'danger'} busy={busy} disabled={reason.trim().length < 5 || !confirmName.trim()}>
            {STATUS_ACTION[to]}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Correo y nombre de una cuenta nueva (administrador municipal o equipo Guard-IA). */
export function PersonDialog({
  title,
  intro,
  submitLabel,
  extra,
  onClose,
  onSubmit,
}: {
  title: string;
  intro: string;
  submitLabel: string;
  extra?: React.ReactNode;
  onClose: () => void;
  onSubmit: (v: { email: string; name: string }) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title={title} onClose={onClose} busy={busy}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onSubmit({ email: email.trim(), name: name.trim() });
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-ink-muted">{intro}</p>
        <Field label="Nombre">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
        </Field>
        <Field label="Correo">
          <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={160} />
        </Field>
        {extra}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function TestPhoneDialog({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: () => void }) {
  const [phone, setPhone] = useState('+569');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Agregar teléfono de prueba" onClose={onClose} busy={busy}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.addTestPhone(tenantId, { phone: phone.replace(/[\s-]/g, ''), label: label.trim() });
            onDone();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-ink-muted">
          Mientras el municipio está en implementación, solo los SOS y reportes de estos teléfonos llegan a su central. Usa
          teléfonos de funcionarios, nunca de vecinos.
        </p>
        <Field label="Teléfono (formato internacional)" hint="Ej.: +56912345678">
          <input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" />
        </Field>
        <Field label="De quién es">
          <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} required minLength={2} maxLength={80} placeholder="Jefa de seguridad municipal" />
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Agregar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Contraseña temporal: se ve una sola vez. Quien la recibe la cambia al entrar. */
export function TemporaryPasswordDialog({
  title,
  email,
  password,
  where,
  onClose,
}: {
  title: string;
  email: string;
  password: string;
  where: string;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">
          Entrégala a <strong className="text-ink">{email}</strong> por un canal seguro (no por el mismo correo). Se muestra solo
          esta vez; al entrar a {where} se le pedirá cambiarla.
        </p>
        <SecretValue value={password} label="contraseña temporal" />
        <div className="flex justify-end pt-2">
          <Button variant="primary" onClick={onClose}>
            Listo, la guardé
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
