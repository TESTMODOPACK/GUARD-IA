import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { errorMessage, sendAlert } from '@/lib/api';
import { currentFix, LocationError, type Fix } from '@/lib/location';
import { color, font, radius } from '@/theme';

const COUNTDOWN_S = 5;

type Phase = { kind: 'counting'; left: number } | { kind: 'sending' } | { kind: 'error'; message: string };

/**
 * SOS por botón: 5 s para arrepentirse ("No enviar" no toca la API). La ubicación se pide en paralelo
 * para que, al llegar a 0, la alerta salga de inmediato. Un mismo `clientRef` para todo el intento.
 */
export default function Sos() {
  const [phase, setPhase] = useState<Phase>({ kind: 'counting', left: COUNTDOWN_S });
  const clientRef = useRef(Crypto.randomUUID());
  const fix = useRef<Promise<Fix> | null>(null);

  const locate = useCallback(() => {
    const p = currentFix();
    p.catch(() => undefined); // el error se muestra al enviar
    fix.current = p;
    return p;
  }, []);

  useEffect(() => {
    void locate();
  }, [locate]);

  const send = useCallback(async () => {
    setPhase({ kind: 'sending' });
    try {
      const loc = await (fix.current ?? locate());
      const res = await sendAlert({
        type: 'EMERGENCY_SOS',
        source: 'BUTTON',
        location: { lat: loc.lat, lng: loc.lng },
        accuracyM: loc.accuracyM,
        clientRef: clientRef.current,
      });
      router.replace({ pathname: '/alert/[id]', params: { id: res.alertId } });
    } catch (e) {
      if (e instanceof LocationError) fix.current = null; // reintentar vuelve a pedir el permiso
      setPhase({ kind: 'error', message: e instanceof LocationError ? e.message : errorMessage(e) });
    }
  }, [locate]);

  useEffect(() => {
    if (phase.kind !== 'counting') return;
    if (phase.left <= 0) {
      void send();
      return;
    }
    const t = setTimeout(() => setPhase({ kind: 'counting', left: phase.left - 1 }), 1000);
    return () => clearTimeout(t);
  }, [phase, send]);

  return (
    <View style={styles.screen}>
      {phase.kind === 'counting' ? (
        <>
          <Text style={styles.kicker}>Enviando alerta en</Text>
          <View style={styles.ring} accessibilityLiveRegion="assertive">
            <Text style={styles.count}>{phase.left}</Text>
            <Text style={styles.unit}>segundos</Text>
          </View>
          <Text style={styles.body}>Tu ubicación irá a la central de tu municipio.</Text>
          <Pressable
            onPress={() => router.back()}
            role="button"
            accessibilityLabel="No enviar la alerta"
            style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.cancelText}>No enviar</Text>
          </Pressable>
        </>
      ) : phase.kind === 'sending' ? (
        <>
          <ActivityIndicator size="large" color="#ffffff" />
          <Text style={styles.kicker}>Enviando a la central…</Text>
        </>
      ) : (
        <>
          <Text style={styles.kicker}>No se pudo enviar</Text>
          <Text style={styles.body}>{phase.message}</Text>
          <Pressable onPress={send} role="button" style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.85 }]}>
            <Text style={styles.cancelText}>Reintentar</Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL('tel:133')} role="button" style={styles.outline}>
            <Text style={styles.outlineText}>Llamar al 133 · Carabineros</Text>
          </Pressable>
          <Pressable onPress={() => router.back()} role="button" style={styles.link}>
            <Text style={styles.linkText}>Volver</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.sosDeep, alignItems: 'center', justifyContent: 'center', gap: 26, padding: 24 },
  kicker: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 15, letterSpacing: 1.5, textTransform: 'uppercase', textAlign: 'center' },
  ring: {
    width: 224,
    height: 224,
    borderRadius: 112,
    borderWidth: 10,
    borderColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { color: '#ffffff', fontFamily: font.display, fontSize: 96, lineHeight: 100 },
  unit: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 13 },
  body: { color: '#ffffff', fontFamily: font.body, fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 300 },
  cancel: {
    alignSelf: 'stretch',
    minHeight: 60,
    borderRadius: 18,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: color.sosDeep, fontFamily: font.bodyBold, fontSize: 17 },
  outline: {
    alignSelf: 'stretch',
    minHeight: 56,
    borderRadius: radius.ctl,
    borderWidth: 2,
    borderColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineText: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 16 },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 15 },
});
