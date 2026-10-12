import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, errorMessage } from '@/lib/api';
import { formatPhone, setPendingPhone, toE164 } from '@/lib/phone';
import { ErrorText, Field, Lead, PrimaryButton, Screen, Title } from '@/components/ui';
import { color } from '@/theme';

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
      <View style={{ width: 64, height: 64, borderRadius: 20, borderWidth: 3, borderColor: color.accent, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: color.sos }} />
      </View>
      <View style={{ gap: 10 }}>
        <Title>Tu barrio,{'\n'}más cerca de ayuda.</Title>
        <Lead>Entra con tu celular. Te enviamos un código por SMS; no pedimos RUT ni contraseña.</Lead>
      </View>
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
