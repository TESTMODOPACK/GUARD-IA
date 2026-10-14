'use client';

import { OPERATOR_ROLES, type AreaRef, type OperatorAccount, type OperatorRole, type TemporaryPassword } from '@guardia/shared';
import { Copy, KeyRound, Pencil, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime, ROLE, ROLE_HELP } from '@/lib/labels';
import { AdminShell, Card, ConfirmDialog, errText, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Button, Dialog, Field, inputClass, Spinner, Tag } from '@/components/ui';

type DialogState =
  | { kind: 'create' }
  | { kind: 'edit'; op: OperatorAccount }
  | { kind: 'toggle'; op: OperatorAccount }
  | { kind: 'reset'; op: OperatorAccount }
  | { kind: 'password'; result: TemporaryPassword; reason: 'created' | 'reset' }
  | null;

/** Usuarios de la central del municipio. El administrador los gestiona; el supervisor solo los ve. */
export default function UsersPage() {
  const session = useOperatorSession(['ADMIN', 'SUPERVISOR']);
  const [list, setList] = useState<OperatorAccount[] | null>(null);
  /** Áreas activas del municipio (0013); vacío: el municipio no se divide en áreas. */
  const [areas, setAreas] = useState<AreaRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ops, refs] = await Promise.all([api.operators(), api.areas.refs()]);
      setList(ops);
      setAreas(refs);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  if (!session) return null;
  const canManage = session.operator.role === 'ADMIN';
  const visible = list?.filter((o) => showInactive || o.active) ?? [];
  const inactiveCount = list?.filter((o) => !o.active).length ?? 0;

  /** A qué áreas pertenece la cuenta. El administrador ve todas; terreno no usa la central. */
  const areaCell = (o: OperatorAccount) => {
    if (o.role === 'FIELD') return <span className="text-ink-faint">—</span>;
    const names = o.areaIds.map((id) => areas.find((a) => a.id === id)?.name).filter(Boolean);
    if (o.role === 'ADMIN') return names.length ? `Todas (${names.join(', ')})` : 'Todas';
    return names.length ? names.join(', ') : <Tag tone="medium">Sin área</Tag>;
  };

  const done = (text: string) => {
    setDialog(null);
    setNotice(text);
    void load();
  };

  return (
    <AdminShell
      session={session}
      title="Usuarios de la central"
      actions={
        <>
          {inactiveCount ? (
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none mr-2">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-[var(--color-accent)]" />
              Mostrar desactivados ({inactiveCount})
            </label>
          ) : null}
          {canManage ? (
            <Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>
              <UserPlus size={16} /> Nuevo usuario
            </Button>
          ) : null}
        </>
      }
    >
      {!canManage ? <Notice kind="ok">Puedes ver el equipo. Solo un administrador crea o modifica cuentas.</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <Card>
        {!list ? (
          <p className="text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando usuarios
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead>
                <tr className="text-left text-xs text-ink-muted border-b border-line">
                  <th className="py-2 pr-3 font-medium">Nombre</th>
                  <th className="py-2 pr-3 font-medium">Correo</th>
                  <th className="py-2 pr-3 font-medium">Rol</th>
                  {areas.length ? <th className="py-2 pr-3 font-medium">Áreas</th> : null}
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  <th className="py-2 pr-3 font-medium">Último ingreso</th>
                  {canManage ? <th className="py-2 font-medium text-right">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {visible.map((o) => {
                  const me = o.id === session.operator.id;
                  return (
                    <tr key={o.id} className={`border-b border-line/60 last:border-0 ${o.active ? '' : 'opacity-60'}`}>
                      <td className="py-2 pr-3">
                        {o.name}
                        {me ? <span className="text-ink-faint"> (tú)</span> : null}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{o.email}</td>
                      <td className="py-2 pr-3">{ROLE[o.role]}</td>
                      {areas.length ? <td className="py-2 pr-3 text-ink-muted">{areaCell(o)}</td> : null}
                      <td className="py-2 pr-3">
                        <span className="inline-flex flex-wrap gap-1.5">
                          {!o.active ? <Tag>Desactivado</Tag> : null}
                          {o.active && o.mustChangePassword ? <Tag tone="medium">Debe crear su contraseña</Tag> : null}
                          {o.onShift ? <Tag tone="ok">De turno</Tag> : null}
                          {o.online ? <Tag tone="accent">Conectado</Tag> : null}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{o.lastLoginAt ? formatDateTime(o.lastLoginAt) : 'Nunca'}</td>
                      {canManage ? (
                        <td className="py-1.5 text-right whitespace-nowrap">
                          <Button variant="ghost" className="h-8 px-2" aria-label={`Editar a ${o.name}`} onClick={() => setDialog({ kind: 'edit', op: o })}>
                            <Pencil size={15} />
                          </Button>
                          {!me ? (
                            <>
                              <Button
                                variant="ghost"
                                className="h-8 px-2"
                                aria-label={`Restablecer la contraseña de ${o.name}`}
                                disabled={!o.active}
                                onClick={() => setDialog({ kind: 'reset', op: o })}
                              >
                                <KeyRound size={15} />
                              </Button>
                              <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => setDialog({ kind: 'toggle', op: o })}>
                                {o.active ? 'Desactivar' : 'Activar'}
                              </Button>
                            </>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Qué puede hacer cada rol">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          {OPERATOR_ROLES.map((r) => (
            <li key={r}>
              <span className="font-medium">{ROLE[r]}:</span> <span className="text-ink-muted">{ROLE_HELP[r]}</span>
            </li>
          ))}
        </ul>
      </Card>

      {dialog?.kind === 'create' ? (
        <OperatorForm
          title="Nuevo usuario"
          areas={areas}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const result = await api.createOperator({ name: v.name, email: v.email, role: v.role, areaIds: v.areaIds });
            setDialog({ kind: 'password', result, reason: 'created' });
            void load();
          }}
        />
      ) : null}
      {dialog?.kind === 'edit' ? (
        <OperatorForm
          title={`Editar a ${dialog.op.name}`}
          initial={dialog.op}
          areas={areas}
          lockRole={dialog.op.id === session.operator.id}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await api.updateOperator(dialog.op.id, {
              name: v.name,
              ...(dialog.op.id !== session.operator.id ? { role: v.role } : {}),
              ...(areas.length ? { areaIds: v.areaIds } : {}),
            });
            done(`Se guardaron los cambios de ${v.name}.`);
          }}
        />
      ) : null}
      {dialog?.kind === 'toggle' ? (
        <ConfirmDialog
          title={dialog.op.active ? `Desactivar a ${dialog.op.name}` : `Activar a ${dialog.op.name}`}
          confirmLabel={dialog.op.active ? 'Desactivar' : 'Activar'}
          danger={dialog.op.active}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.updateOperator(dialog.op.id, { active: !dialog.op.active });
            done(dialog.op.active ? `${dialog.op.name} ya no puede entrar a la central.` : `${dialog.op.name} puede volver a entrar.`);
          }}
        >
          {dialog.op.active
            ? 'Se cierran sus sesiones abiertas y, si está de turno, su turno. Su historial se conserva.'
            : 'Podrá entrar con su contraseña actual.'}
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'reset' ? (
        <ConfirmDialog
          title={`Restablecer la contraseña de ${dialog.op.name}`}
          confirmLabel="Restablecer"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const result = await api.resetPassword(dialog.op.id);
            setDialog({ kind: 'password', result, reason: 'reset' });
            void load();
          }}
        >
          Se genera una contraseña temporal y se cierran sus sesiones abiertas. Al entrar, deberá crear una nueva.
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'password' ? (
        <TemporaryPasswordDialog result={dialog.result} reason={dialog.reason} onClose={() => done(`Cuenta de ${dialog.result.operator.name} lista.`)} />
      ) : null}
    </AdminShell>
  );
}

function OperatorForm({
  title,
  initial,
  areas,
  lockRole = false,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: OperatorAccount;
  areas: AreaRef[];
  lockRole?: boolean;
  onClose: () => void;
  onSubmit: (v: { name: string; email: string; role: OperatorRole; areaIds: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [role, setRole] = useState<OperatorRole>(initial?.role ?? 'OPERATOR');
  // Solo áreas activas: una desactivada que tuviera la cuenta se suelta al guardar.
  const [areaIds, setAreaIds] = useState<string[]>(() => (initial?.areaIds ?? []).filter((id) => areas.some((a) => a.id === id)));
  const toggleArea = (id: string) => setAreaIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length >= 2 && /.+@.+\..+/.test(email.trim());

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
            // Terreno no usa la central: sin áreas.
            await onSubmit({ name: name.trim(), email: email.trim().toLowerCase(), role, areaIds: role === 'FIELD' ? [] : areaIds });
          } catch (err) {
            setError(errText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Nombre y apellido">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </Field>
        <Field label="Correo (es su usuario para entrar)">
          <input
            className={inputClass}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!!initial}
            maxLength={160}
            required
          />
        </Field>
        <Field label="Rol">
          <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as OperatorRole)} disabled={lockRole}>
            {OPERATOR_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE[r]} — {ROLE_HELP[r]}
              </option>
            ))}
          </select>
        </Field>
        {areas.length && role !== 'FIELD' ? (
          <fieldset data-testid="operator-areas">
            <legend className="text-sm mb-1.5">Áreas</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {areas.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input type="checkbox" checked={areaIds.includes(a.id)} onChange={() => toggleArea(a.id)} className="accent-[var(--color-accent)]" />
                  {a.name}
                  {a.receivesSos ? <span className="text-xs text-ink-faint">(SOS)</span> : null}
                </label>
              ))}
            </div>
            <p className={`mt-1.5 text-xs ${role !== 'ADMIN' && areaIds.length === 0 ? 'text-medium' : 'text-ink-faint'}`}>
              {role === 'ADMIN'
                ? 'El administrador ve todas las áreas; marcarlas solo indica a cuál pertenece.'
                : areaIds.length === 0
                  ? 'Sin área solo verá las alertas que aún no tienen área.'
                  : 'Verá las alertas de estas áreas; si una recibe los SOS, también los reportes con carácter de seguridad.'}
            </p>
          </fieldset>
        ) : null}
        {initial ? <p className="text-xs text-ink-faint">El correo no se cambia: es la identidad de la cuenta.</p> : null}
        {lockRole ? <p className="text-xs text-ink-faint">No puedes cambiar tu propio rol.</p> : null}
        {!initial ? <p className="text-xs text-ink-muted">Se generará una contraseña temporal para entregarle. Al entrar, deberá crear la suya.</p> : null}
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
            {initial ? 'Guardar' : 'Crear usuario'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** La contraseña temporal se muestra una sola vez: no se guarda en ningún lado de la central. */
function TemporaryPasswordDialog({ result, reason, onClose }: { result: TemporaryPassword; reason: 'created' | 'reset'; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title={reason === 'created' ? 'Usuario creado' : 'Contraseña restablecida'} onClose={onClose}>
      <p className="text-sm text-ink-muted">
        Entrégale a <span className="text-ink">{result.operator.name}</span> ({result.operator.email}) esta contraseña temporal. Se muestra
        solo esta vez; al entrar deberá crear la suya.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <code className="flex-1 h-10 px-3 inline-flex items-center rounded-ctl bg-bg border border-line-strong font-mono text-lg tracking-wider select-all">
          {result.temporaryPassword}
        </code>
        <Button
          variant="quiet"
          aria-label="Copiar contraseña"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(result.temporaryPassword);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy size={15} /> {copied ? 'Copiada' : 'Copiar'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-ink-faint">Entrégala en persona o por un canal seguro; no la envíes por un chat grupal.</p>
      <div className="mt-5 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Listo
        </Button>
      </div>
    </Dialog>
  );
}
