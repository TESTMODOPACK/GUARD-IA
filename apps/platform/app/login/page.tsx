'use client';

import type { PlatformLoginStep, PlatformSession } from '@guardia/shared';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorNote, Field, inputClass, SecretValue } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { saveSession } from '@/lib/session';

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP": más fácil de escribir a mano en la app de autenticación. */
const group = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/** Pasos que piden el código; `done` (desarrollo sin segundo factor) entra directo. */
type CodeStep = Exclude<PlatformLoginStep, { step: 'done' }>;

/**
 * Ingreso en dos pasos: contraseña y código de 6 dígitos de la app de autenticación. El primer ingreso
 * enrola el segundo factor: la consola muestra la clave una vez y la activa con el primer código correcto.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<CodeStep | null>(null);
  const [code, setCode] = useState('');
  const [codeHint, setCodeHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enter = (s: PlatformSession) => {
    saveSession(s);
    router.replace(s.user.mustChangePassword ? '/cambiar-clave' : '/');
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(email.trim(), password);
      setPassword('');
      if (r.step === 'done') return enter(r.session);
      setStep(r);
      setBusy(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      enter(await api.totp(step.challengeToken, code));
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
      // El paso venció (5 min): volver a la contraseña.
      if (/venció/.test(errorMessage(err))) setStep(null);
      setBusy(false);
    }
  };

  /** Solo números. Si llegan letras, es la clave de configuración pegada en el lugar equivocado. */
  const onCode = (raw: string) => {
    setCodeHint(
      /[A-Za-z]/.test(raw)
        ? 'Eso parece la clave larga: esa va en la app del teléfono. Aquí van los 6 números que la app muestra.'
        : null,
    );
    setCode(raw.replace(/\D/g, '').slice(0, 6));
  };

  const back = () => {
    setStep(null);
    setCode('');
    setCodeHint(null);
    setError(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-[440px] max-w-full rounded-lg border border-line bg-surface p-6 space-y-5">
        <div className="flex items-center gap-3">
          <img src="/brand-mark.png" alt="" width={36} height={36} />
          <div>
            <div className="font-bold tracking-wide">
              GUARD<span className="text-accent">-IA</span> <span className="font-normal text-ink-muted">Plataforma</span>
            </div>
            <div className="text-xs text-ink-faint">Consola del equipo Guard-IA.</div>
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
                  <p>Primer ingreso: activa el segundo factor. Desde ahora cada ingreso pedirá tu contraseña y un código del teléfono.</p>
                </div>
                <ol className="list-decimal pl-5 space-y-2 text-ink-muted">
                  <li>
                    En tu <strong className="text-ink">teléfono</strong>, abre Google Authenticator o Microsoft Authenticator (gratis en la
                    tienda de apps).
                  </li>
                  <li>
                    Toca <strong className="text-ink">+</strong> → <em>Ingresar una clave de configuración</em>. Nombre:{' '}
                    <strong className="text-ink">Guard-IA</strong>. Clave: la de este recuadro. Tipo: <em>basada en tiempo</em>.
                  </li>
                </ol>
                <div>
                  <span className="block text-xs text-ink-muted mb-1">Clave para la app del teléfono (no va en el campo Código)</span>
                  <SecretValue value={group(step.secret)} label="clave del segundo factor" />
                </div>
                <ol start={3} className="list-decimal pl-5 text-ink-muted">
                  <li>
                    La app mostrará un número de <strong className="text-ink">6 dígitos</strong> que cambia cada 30 segundos. Escríbelo
                    abajo, en Código.
                  </li>
                </ol>
                <p className="text-ink-faint text-xs">
                  Si abriste esta página en el mismo teléfono, puedes{' '}
                  <a className="text-accent underline" href={step.otpauthUri}>
                    agregarla directo en la app
                  </a>
                  . La clave se muestra solo ahora; si la pierdes, un superadministrador debe restablecer tu cuenta.
                </p>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Escribe el código de 6 dígitos que muestra la app de autenticación de tu teléfono.</p>
            )}
            <Field label="Código de 6 dígitos de la app">
              <input
                className={`${inputClass} font-mono tracking-[0.4em] text-center text-lg`}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => onCode(e.target.value)}
                aria-describedby={codeHint ? 'code-hint' : undefined}
                required
                autoFocus
              />
            </Field>
            {codeHint ? (
              <p id="code-hint" role="status" className="text-sm text-medium -mt-2">
                {codeHint}
              </p>
            ) : null}
            <ErrorNote>{error}</ErrorNote>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={back} disabled={busy}>
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
