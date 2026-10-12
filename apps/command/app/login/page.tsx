'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { loadSession, saveSession } from '@/lib/session';
import { Button, Field, inputClass } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loadSession()) router.replace('/');
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(email.trim(), password);
      saveSession(r);
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(
          err.code === 'RATE_LIMITED'
            ? 'Demasiados intentos. Espera un minuto y vuelve a intentar.'
            : err.code === 'UNAUTHORIZED'
              ? 'Correo o contraseña incorrectos.'
              : err.message,
        );
      } else {
        setError('No se pudo conectar con la API. Revisa la red o avisa a soporte.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="h-screen grid place-items-center p-6">
      <form onSubmit={submit} className="w-[380px] max-w-full rounded-lg border border-line bg-surface p-6 space-y-5">
        <div className="flex flex-col items-center text-center gap-2 pb-1">
          <img src="/brand-mark.png" alt="" width={72} height={72} />
          <h1 className="text-2xl font-bold tracking-wide leading-tight">
            GUARD<span className="text-accent">-IA</span>
          </h1>
          <p className="text-sm text-ink-muted">Central de monitoreo municipal</p>
          <p className="text-xs text-ink-faint">Seguridad ciudadana que responde en el momento en que importa</p>
        </div>
        <Field label="Correo">
          <input className={inputClass} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus data-testid="login-email" />
        </Field>
        <Field label="Contraseña">
          <input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="w-full" busy={busy} data-testid="login-submit">
          Entrar a la central
        </Button>
        <p className="text-xs text-ink-faint">Guard-IA no reemplaza al 133, 131 ni 132. Las derivaciones a Carabineros, SAMU y Bomberos se hacen por teléfono y se registran como nota.</p>
      </form>
    </main>
  );
}
