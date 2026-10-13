'use client';

import type { PlatformLoginStep } from '@guardia/shared';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorNote, Field, inputClass, SecretValue } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { saveSession } from '@/lib/session';

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP": más fácil de escribir a mano en la app de autenticación. */
const group = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/**
 * Ingreso en dos pasos: contraseña y código de 6 dígitos de la app de autenticación. El primer ingreso
 * enrola el segundo factor: la consola muestra la clave una vez y la activa con el primer código correcto.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<PlatformLoginStep | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStep(await api.login(email.trim(), password));
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.totp(step.challengeToken, code);
      saveSession(s);
      router.replace(s.user.mustChangePassword ? '/cambiar-clave' : '/');
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
      // El paso venció (5 min): volver a la contraseña.
      if (/venció/.test(errorMessage(err))) setStep(null);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-[420px] max-w-full rounded-lg border border-line bg-surface p-6 space-y-5">
        <div className="flex items-center gap-3">
          <img src="/brand-mark.png" alt="" width={36} height={36} />
          <div>
            <div className="font-bold tracking-wide">
              GUARD<span className="text-accent">-IA</span> <span className="font-normal text-ink-muted">Plataforma</span>
            </div>
            <div className="text-xs text-ink-faint">Consola del equipo Guard-IA. Acceso con segundo factor.</div>
          </div>
        </div>

        {!step ? (
          <form onSubmit={submitPassword} className="space-y-3">
            <Field label="Correo">
              <input className={inputClass} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Contraseña">
              <input
                className={inputClass}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" variant="primary" busy={busy} className="w-full">
              Continuar
            </Button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            {step.step === 'enroll' ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-2 text-ink">
                  <ShieldCheck size={18} className="text-accent shrink-0 mt-0.5" />
                  <p>Primer ingreso: activa el segundo factor. Lo pedirá cada vez que entres a la consola.</p>
                </div>
                <ol className="list-decimal pl-5 space-y-1 text-ink-muted">
                  <li>Abre tu app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password u otra).</li>
                  <li>
                    Agrega una cuenta con <em>clave de configuración</em> y escribe esta clave (es por tiempo, 6 dígitos):
                  </li>
                </ol>
                <SecretValue value={group(step.secret)} label="clave del segundo factor" />
                <p className="text-ink-faint text-xs">
                  En el teléfono también puedes{' '}
                  <a className="text-accent underline" href={step.otpauthUri}>
                    abrirla directo en la app
                  </a>
                  . La clave se muestra solo ahora; si la pierdes, un superadministrador debe restablecer tu cuenta.
                </p>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Escribe el código de 6 dígitos que muestra tu app de autenticación.</p>
            )}
            <Field label="Código">
              <input
                className={`${inputClass} font-mono tracking-[0.4em] text-center text-lg`}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
              />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep(null);
                  setCode('');
                  setError(null);
                }}
                disabled={busy}
              >
                Volver
              </Button>
              <Button type="submit" variant="primary" busy={busy} className="flex-1" disabled={code.length !== 6}>
                {step.step === 'enroll' ? 'Activar y entrar' : 'Entrar'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
