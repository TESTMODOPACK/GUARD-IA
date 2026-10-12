import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CONSENT_VERSION } from '@guardia/shared';
import { api, errorMessage, logout } from '@/lib/api';
import { updateCitizen } from '@/lib/session';
import { ErrorText, Kicker, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';
import { color, font, TOUCH } from '@/theme';

const ITEMS = [
  { title: 'Ubicación, audio y foto', text: 'Solo cuando pides ayuda o reportas, y van a la central de tu municipio.', tint: color.accent },
  { title: 'IA para priorizar', text: 'El audio se transcribe y clasifica con OpenAI. Se borra a los 90 días.', tint: color.ok },
  { title: 'Falsas alarmas', text: 'Bajan tu nivel de confianza; tus próximas alertas se revisan con más cuidado.', tint: color.warn },
  { title: 'Tus derechos', text: 'Puedes pedir una copia de tus datos o borrar tu cuenta cuando quieras.', tint: '#8fb4ea' },
] as const;

/** Consentimiento versionado (CONSENT_VERSION). Sin aceptar, la app no deja pedir ayuda. */
export default function Consent() {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.consent(CONSENT_VERSION);
      await updateCitizen(await api.me());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: 6, paddingTop: 12 }}>
        <Kicker>Consentimiento {CONSENT_VERSION} · Ley 21.719</Kicker>
        <Title>Así usamos tus datos</Title>
      </View>
      <View style={{ gap: 10 }}>
        {ITEMS.map((it) => (
          <View key={it.title} style={styles.item}>
            <View style={[styles.mark, { backgroundColor: it.tint }]} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.itemTitle}>{it.title}</Text>
              <Text style={styles.itemText}>{it.text}</Text>
            </View>
          </View>
        ))}
      </View>
      <Pressable
        onPress={() => setAccepted((v) => !v)}
        role="checkbox"
        aria-checked={accepted}
        style={styles.check}
      >
        <View style={[styles.box, accepted && styles.boxOn]}>{accepted ? <Text style={styles.tick}>✓</Text> : null}</View>
        <Text style={styles.checkText}>Leí y acepto el uso de mis datos para atender mis alertas.</Text>
      </Pressable>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label="Aceptar y continuar" onPress={accept} disabled={!accepted} busy={busy} />
      <LinkButton label="No acepto · salir" onPress={() => void logout()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    gap: 14,
    padding: 14,
    borderRadius: 18,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
  },
  mark: { width: 6, borderRadius: 3 },
  itemTitle: { color: color.ink, fontFamily: font.bodyBold, fontSize: 15 },
  itemText: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 13, lineHeight: 19 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TOUCH },
  box: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: color.accent, borderColor: color.accent },
  tick: { color: color.accentInk, fontFamily: font.bodyBold, fontSize: 16 },
  checkText: { flex: 1, color: color.ink, fontFamily: font.body, fontSize: 14, lineHeight: 20 },
});
