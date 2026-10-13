'use client';

import { PLATFORM_ROLES, type PlatformRole, type PlatformUserAccount } from '@guardia/shared';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PersonDialog, TemporaryPasswordDialog } from '@/components/TenantDialogs';
import { Shell, usePlatformSession } from '@/components/Shell';
import { Button, Card, ErrorNote, Field, inputClass, Loading, Tag } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, ROLE } from '@/lib/labels';

/** Equipo Guard-IA (RF-4.1). Solo el superadministrador entra aquí. */
export default function UsersPage() {
  const session = usePlatformSession(['SUPERADMIN']);
  const [users, setUsers] = useState<PlatformUserAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState<PlatformRole>('IMPLEMENTATION');
  const [secret, setSecret] = useState<{ title: string; email: string; password: string } | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .users()
      .then((u) => {
        setUsers(u);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (session) reload();
  }, [session, reload]);

  if (!session) return null;

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusyRow(id);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyRow(null);
    }
  };

  return (
    <Shell session={session}>
      <div className="flex items-end gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold">Equipo Guard-IA</h1>
          <p className="text-sm text-ink-muted">Cuentas de la consola. Todas entran con contraseña y segundo factor.</p>
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
          Agregar persona
        </Button>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <Card>
        {!users ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-muted text-left">
                <tr>
                  <th className="py-2 pr-3 font-normal">Persona</th>
                  <th className="py-2 pr-3 font-normal">Rol</th>
                  <th className="py-2 pr-3 font-normal">Estado</th>
                  <th className="py-2 pr-3 font-normal">Último ingreso</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === session.user.id;
                  return (
                    <tr key={u.id} className="border-t border-line">
                      <td className="py-2 pr-3">
                        <div>{u.name}</div>
                        <div className="text-xs text-ink-faint">{u.email}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className={`${inputClass} h-8 w-56`}
                          value={u.role}
                          disabled={self || busyRow === u.id}
                          aria-label={`Rol de ${u.name}`}
                          onChange={(e) => void act(u.id, () => api.updateUser(u.id, { role: e.target.value as PlatformRole }))}
                        >
                          {PLATFORM_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 pr-3 space-x-1">
                        {!u.active ? <Tag tone="faint">Desactivada</Tag> : <Tag tone="ok">Activa</Tag>}
                        {u.lockedUntil ? <Tag tone="medium">Bloqueada</Tag> : null}
                        {!u.totpEnabled ? <Tag tone="medium">Sin segundo factor</Tag> : null}
                        {u.mustChangePassword ? <Tag tone="medium">Contraseña temporal</Tag> : null}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{formatDateTime(u.lastLoginAt)}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {!self ? (
                          <>
                            <Button
                              variant="ghost"
                              className="h-8 px-2"
                              aria-label={`Restablecer ${u.name}`}
                              title="Restablecer: contraseña temporal nueva y segundo factor por enrolar"
                              busy={busyRow === u.id}
                              onClick={() =>
                                void act(u.id, async () => {
                                  const r = await api.resetUser(u.id);
                                  setSecret({ title: 'Cuenta restablecida', email: r.user.email, password: r.temporaryPassword });
                                })
                              }
                            >
                              <KeyRound size={16} />
                            </Button>
                            <Button
                              variant="ghost"
                              className="h-8"
                              disabled={busyRow === u.id}
                              onClick={() => void act(u.id, () => api.updateUser(u.id, { active: !u.active }))}
                            >
                              {u.active ? 'Desactivar' : 'Reactivar'}
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-ink-faint">tú</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <PersonDialog
          title="Agregar persona al equipo"
          intro="Recibe una contraseña temporal; en su primer ingreso la cambia y activa el segundo factor."
          submitLabel="Agregar"
          extra={
            <Field label="Rol">
              <select className={inputClass} value={newRole} onChange={(e) => setNewRole(e.target.value as PlatformRole)}>
                {PLATFORM_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE[r]}
                  </option>
                ))}
              </select>
            </Field>
          }
          onClose={() => setCreating(false)}
          onSubmit={async (v) => {
            const r = await api.createUser({ ...v, role: newRole });
            setCreating(false);
            setSecret({ title: 'Persona agregada', email: r.user.email, password: r.temporaryPassword });
            reload();
          }}
        />
      ) : null}
      {secret ? (
        <TemporaryPasswordDialog title={secret.title} email={secret.email} password={secret.password} where="la consola" onClose={() => setSecret(null)} />
      ) : null}
    </Shell>
  );
}
