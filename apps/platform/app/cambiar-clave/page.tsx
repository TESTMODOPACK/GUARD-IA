'use client';

import { PLATFORM_PASSWORD_MIN_LENGTH } from '@guardia/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, ErrorNote, Field, inputClass } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { loadSession, updateUser, type Session } from '@/lib/session';

/** Cambio de contraseña propia; obligatorio tras recibir una temporal. */
export default function ChangePasswordPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (!s) router.replace('/login');
    else setSession(s);
  }, [router]);

  if (!session) return null;
  const forced = session.user.mustChangePassword;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError('Las contraseñas nuevas no coinciden');
    setBusy(true);
    setError(null);
    try {
      updateUser(await api.changePassword({ currentPassword: current, newPassword: next }));
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-[420px] max-w-full rounded-lg border border-line bg-surface p-6 space-y-4">
        <h1 className="text-base font-semibold">{forced ? 'Define tu contraseña' : 'Cambiar contraseña'}</h1>
        {forced ? (
          <p className="text-sm text-ink-muted">
            Entraste con una contraseña temporal. Elige una propia de al menos {PLATFORM_PASSWORD_MIN_LENGTH} caracteres: con
            esta cuenta se administran todos los municipios.
          </p>
        ) : null}
        <Field label={forced ? 'Contraseña temporal' : 'Contraseña actual'}>
          <input className={inputClass} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="Contraseña nueva" hint={`Mínimo ${PLATFORM_PASSWORD_MIN_LENGTH} caracteres; una frase larga es más fácil de recordar.`}>
          <input
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={PLATFORM_PASSWORD_MIN_LENGTH}
          />
        </Field>
        <Field label="Repite la contraseña nueva">
          <input className={inputClass} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex gap-2">
          {!forced ? (
            <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>
              Cancelar
            </Button>
          ) : null}
          <Button type="submit" variant="primary" busy={busy} className="flex-1">
            Guardar
          </Button>
        </div>
      </form>
    </div>
  );
}
