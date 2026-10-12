import { router } from 'expo-router';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatPhone, setPendingPhone, toE164 } from '@/lib/phone';
import { BrandLockup } from '@/components/Brand';
import { ErrorText, Field, Lead, PrimaryButton, Screen } from '@/components/ui';

/** Ingreso: celular chileno → código por SMS. Sin RUT ni contraseña (minimización, Ley 21.719). */
export default function Login() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = toE164(input);

  const submit = async () => {
    if (!phone) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestOtp(phone);
      setPendingPhone(phone);
      router.push('/verify');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen center>
      <BrandLockup tagline />
      <Lead>Entra con tu celular. Te enviamos un código por SMS; no pedimos RUT ni contraseña.</Lead>
      <Field
        label="Número de celular"
        prefix="+56"
        value={input}
        onChangeText={setInput}
        placeholder="9 1234 5678"
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        maxLength={12}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label="Recibir código por SMS" onPress={submit} disabled={!phone} busy={busy} />
      <Lead>{phone ? `Enviaremos el código al ${formatPhone(phone)}.` : 'Celular chileno: 9 dígitos, empieza con 9.'}</Lead>
    </Screen>
  );
}
