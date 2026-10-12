import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { formatPhone, getPendingPhone, setPendingPhone } from '@/lib/phone';
import { saveTokens } from '@/lib/session';
import { ErrorText, Field, Lead, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';

const RESEND_AFTER_S = 60;

/** Código de 6 dígitos. Al verificar, la sesión queda guardada y el layout lleva a consentimiento o inicio. */
export default function Verify() {
  const [phone] = useState(getPendingPhone);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(RESEND_AFTER_S);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const verify = async (value = code) => {
    if (!phone || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const { citizen, ...pair } = await api.verifyOtp(phone, value);
      setPendingPhone(null);
      await saveTokens(pair, citizen);
      // El layout decide la siguiente pantalla (consentimiento o inicio).
    } catch (e) {
      setError(errorMessage(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!phone) return;
    setError(null);
    try {
      await api.requestOtp(phone);
      setWait(RESEND_AFTER_S);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Se abrió "Código" sin pasar por "Ingreso" (p. ej. recargando la web): volver a pedir el número.
  if (!phone) return <Redirect href="/login" />;

  return (
    <Screen center>
      <View style={{ gap: 10 }}>
        <Title>Revisa tus SMS</Title>
        <Lead>
          Enviamos un código de 6 dígitos al {phone ? formatPhone(phone) : 'tu celular'}. Vence en 5 minutos.
        </Lead>
      </View>
      <Field
        label="Código"
        value={code}
        onChangeText={(t) => {
          const digits = t.replace(/\D/g, '').slice(0, 6);
          setCode(digits);
          if (digits.length === 6) void verify(digits);
        }}
        placeholder="••••••"
        keyboardType="number-pad"
        autoComplete="sms-otp"
        textContentType="oneTimeCode"
        maxLength={6}
        autoFocus
        style={{ textAlign: 'center', fontSize: 28, letterSpacing: 12 }}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label="Verificar" onPress={() => verify()} disabled={code.length !== 6} busy={busy} />
      <LinkButton
        label={wait > 0 ? `Reenviar código en ${wait} s` : 'Reenviar código'}
        onPress={resend}
        disabled={wait > 0}
      />
      <LinkButton label="Cambiar número" onPress={() => router.back()} />
    </Screen>
  );
}
