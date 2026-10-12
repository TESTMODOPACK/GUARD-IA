import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { logout } from '@/lib/api';
import { formatPhone } from '@/lib/phone';
import { registerDevice, type PushResult } from '@/lib/push';
import { useSession } from '@/lib/session';
import { LinkButton, Screen } from '@/components/ui';
import { color, font, radius } from '@/theme';

/**
 * Inicio del vecino: SOS (cuenta regresiva y envío en /sos), estado del teléfono para avisos y
 * registro del dispositivo (PUT /me/devices) al abrir.
 */
export default function Home() {
  const { session } = useSession();
  const [push, setPush] = useState<PushResult | null>(null);

  useEffect(() => {
    registerDevice()
      .then(setPush)
      .catch(() => setPush({ state: 'unavailable', reason: 'no se pudo registrar ahora; se reintenta al abrir la app' }));
  }, []);

  if (!session) return null;

  const pushText =
    push === null
      ? 'Revisando avisos…'
      : push.state === 'registered'
        ? 'Avisos de la central activados'
        : push.state === 'denied'
          ? 'Avisos desactivados: actívalos en Ajustes para saber cuándo llega la unidad'
          : `Avisos no disponibles: ${push.reason}`;

  return (
    <Screen>
      <View style={styles.head}>
        <View>
          <Text style={styles.hello}>Hola</Text>
          <Text style={styles.tenant}>{formatPhone(session.citizen.phone)}</Text>
        </View>
        <View style={styles.chip}>
          <View style={styles.chipDot} />
          <Text style={styles.chipText}>Sesión activa</Text>
        </View>
      </View>

      <View style={styles.sosWrap}>
        <Pressable
          onPress={() => router.push('/sos')}
          role="button"
          accessibilityLabel="Pedir ayuda: SOS con cuenta regresiva de 5 segundos"
          style={({ pressed }) => [styles.sos, pressed && { transform: [{ scale: 0.97 }] }]}
        >
          <Text style={styles.sosText}>SOS</Text>
          <Text style={styles.sosSub}>Toca para pedir ayuda</Text>
        </Pressable>
        <Text style={styles.note}>5 segundos para arrepentirte · cancelas hasta 30 s después</Text>
      </View>

      <View style={styles.tiles}>
        <Pressable onPress={() => router.push('/voice')} role="button" style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]}>
          <View style={[styles.tileChip, { backgroundColor: 'rgba(255,59,79,0.16)' }]} />
          <Text style={styles.tileTitle}>Hablar</Text>
          <Text style={styles.tileSub}>Cuenta qué pasa</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/discreet')}
          role="button"
          accessibilityLabel="Modo discreto: pantalla negra que graba 15 segundos y envía el SOS sin que se note"
          style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]}
        >
          <View style={[styles.tileChip, { backgroundColor: 'rgba(185,165,255,0.16)' }]} />
          <Text style={styles.tileTitle}>Discreto</Text>
          <Text style={styles.tileSub}>Pantalla negra, sin sonido</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/report')} role="button" style={({ pressed }) => [styles.tile, pressed && { opacity: 0.8 }]}>
          <View style={[styles.tileChip, { backgroundColor: 'rgba(62,224,181,0.14)' }]} />
          <Text style={styles.tileTitle}>Reportar</Text>
          <Text style={styles.tileSub}>Bache, luz, basura…</Text>
        </Pressable>
      </View>

      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text style={styles.cardLabel}>Este teléfono</Text>
        <Text style={styles.cardText}>{pushText}</Text>
        <Text style={styles.cardMeta}>Confianza {session.citizen.trustScore} / 100 · consentimiento {session.citizen.consentVersion}</Text>
      </View>

      <Pressable
        onPress={() => router.push('/cases')}
        role="button"
        style={({ pressed }) => [styles.casesBtn, pressed && { opacity: 0.8 }]}
      >
        <Text style={styles.casesTitle}>Mis casos</Text>
        <Text style={styles.casesSub}>Estado de tus alertas y reportes, en vivo</Text>
      </Pressable>

      <Pressable
        onPress={() => router.push('/privacy')}
        role="button"
        style={({ pressed }) => [styles.casesBtn, pressed && { opacity: 0.8 }]}
      >
        <Text style={styles.casesTitle}>Mis datos</Text>
        <Text style={styles.casesSub}>Descargar lo que guardamos o borrar tu cuenta</Text>
      </Pressable>

      <LinkButton label="Cerrar sesión" onPress={() => void logout()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hello: { color: color.inkMuted, fontFamily: font.body, fontSize: 13 },
  tenant: { color: color.ink, fontFamily: font.display, fontSize: 22 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(62,224,181,0.14)',
  },
  chipDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.ok },
  chipText: { color: color.ok, fontFamily: font.bodyBold, fontSize: 12 },
  sosWrap: { alignItems: 'center', gap: 12, paddingVertical: 8 },
  sos: {
    width: 196,
    height: 196,
    borderRadius: 98,
    backgroundColor: color.sos,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 10,
    borderColor: 'rgba(255,59,79,0.22)',
  },
  sosText: { color: '#ffffff', fontFamily: font.display, fontSize: 50, lineHeight: 54 },
  sosSub: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 13 },
  note: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12, textAlign: 'center', maxWidth: 300 },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, gap: 6, padding: 14, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  tileChip: { width: 36, height: 36, borderRadius: 12 },
  tileTitle: { color: color.ink, fontFamily: font.bodyBold, fontSize: 15 },
  tileSub: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12 },
  casesBtn: { gap: 2, padding: 16, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  casesTitle: { color: color.ink, fontFamily: font.bodyBold, fontSize: 15 },
  casesSub: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12 },
  card: { gap: 6, padding: 16, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  cardLabel: { color: color.inkMuted, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  cardText: { color: color.ink, fontFamily: font.body, fontSize: 14, lineHeight: 20 },
  cardMeta: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12 },
});
