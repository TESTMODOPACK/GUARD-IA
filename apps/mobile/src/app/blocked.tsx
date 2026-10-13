import { router } from 'expo-router';
import { useEffect } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { logout, syncAccount } from '@/lib/api';
import { untilText } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { BrandMark } from '@/components/Brand';
import { Lead, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';
import { color, font, radius } from '@/theme';

const NUMBERS = [
  { number: '133', agency: 'Carabineros' },
  { number: '131', agency: 'SAMU' },
  { number: '132', agency: 'Bomberos' },
] as const;

/**
 * Cuenta bloqueada (decisión 13-10-2026: sin uso de la app). Nada de SOS ni reportes: solo los números de
 * emergencia, el plazo, quién lo decidió y cómo pedir revisión. Ninguna emergencia queda sin camino.
 */
export default function Blocked() {
  const { session } = useSession();
  const block = session?.citizen.account?.block ?? null;

  // Al abrir: si el bloqueo ya se levantó o venció, la app vuelve sola al inicio.
  useEffect(() => {
    void syncAccount();
  }, []);

  return (
    <Screen>
      <View style={styles.head}>
        <BrandMark size={44} />
        <Title>Tu cuenta está bloqueada</Title>
      </View>
      <Lead>
        {block
          ? `${block.tenantName} bloqueó tu cuenta ${untilText(block.endsAt)} por avisos falsos reiterados. Mientras dure, no puedes enviar alertas desde la app.`
          : 'Tu cuenta está bloqueada por avisos falsos reiterados. Mientras dure, no puedes enviar alertas desde la app.'}
      </Lead>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Ante una emergencia, llama directamente</Text>
        {NUMBERS.map((n) => (
          <Pressable
            key={n.number}
            onPress={() => Linking.openURL(`tel:${n.number}`)}
            role="button"
            accessibilityLabel={`Llamar al ${n.number}, ${n.agency}`}
            style={({ pressed }) => [styles.call, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.callNumber}>{n.number}</Text>
            <Text style={styles.callAgency}>{n.agency}</Text>
          </Pressable>
        ))}
      </View>

      <PrimaryButton label="Ver detalle o pedir revisión" onPress={() => router.push('/account')} />
      <LinkButton label="Cerrar sesión" onPress={() => void logout()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: 12 },
  card: { gap: 10, padding: 16, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  cardLabel: { color: color.inkMuted, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  call: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingHorizontal: 16,
    borderRadius: radius.ctl,
    backgroundColor: color.surface2,
  },
  callNumber: { color: color.ink, fontFamily: font.display, fontSize: 26 },
  callAgency: { color: color.inkMuted, fontFamily: font.body, fontSize: 15 },
});
