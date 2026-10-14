'use client';

import { PASSWORD_MIN_LENGTH } from '@guardia/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiRequestError, logout } from '@/lib/api';
import { homeFor, loadSession, updateOperator, type Session } from '@/lib/session';
import { Button, Field, inputClass } from '@/components/ui';

/** Cambio de contraseña: obligatorio con una temporal (cuenta nueva o restablecida), opcional si no. */
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
  const forced = session.operator.mustChangePassword;
  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== next;
  const ready = current.length > 0 && next.length >= PASSWORD_MIN_LENGTH && repeat === next;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const op = await api.changePassword(current, next);
      updateOperator(op);
      router.replace(homeFor(op));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'No se pudo conectar con la API.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="h-screen grid place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-[400px] rounded-lg border border-line bg-surface p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{forced ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h1>
          <p className="text-sm text-ink-muted">
            {forced
              ? `Hola, ${session.operator.name}. Entraste con una contraseña temporal: reemplázala por una tuya antes de usar la central.`
              : 'Después del cambio sigues con la sesión abierta.'}
          </p>
        </div>
        <Field label={forced ? 'Contraseña temporal' : 'Contraseña actual'}>
          <input className={inputClass} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
        </Field>
        <Field label={`Nueva contraseña (mínimo ${PASSWORD_MIN_LENGTH} caracteres)`}>
          <input className={inputClass} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label="Repite la nueva contraseña">
          <input className={inputClass} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </Field>
        {tooShort ? <p className="text-sm text-medium">Faltan {PASSWORD_MIN_LENGTH - next.length} caracteres.</p> : null}
        {mismatch ? <p className="text-sm text-medium">Las contraseñas no coinciden.</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <Button variant="primary" type="submit" busy={busy} disabled={!ready} className="w-full">
          Guardar contraseña
        </Button>
        <div className="flex justify-between text-sm">
          {forced ? (
            <span />
          ) : (
            <button type="button" className="text-ink-muted hover:text-ink" onClick={() => router.replace('/')}>
              Volver
            </button>
          )}
          <button type="button" className="text-ink-muted hover:text-ink" onClick={() => void logout().then(() => router.replace('/login'))}>
            Cerrar sesión
          </button>
        </div>
      </form>
    </main>
  );
}
