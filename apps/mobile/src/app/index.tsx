import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { CONSENT_VERSION } from '@guardia/shared';
import { API_URL, API_BASE } from '@/lib/config';
import { color, font, radius, TOUCH } from '@/theme';

type Health = { ok: boolean; db: boolean; redis: boolean; storage: boolean };
type Check = { state: 'loading' } | { state: 'ok'; health: Health; ms: number } | { state: 'error'; message: string };

/**
 * Entrega 3a: pantalla de arranque que prueba la conexión con la API local y el paquete compartido.
 * Las pantallas reales (ingreso, SOS, seguimiento) llegan en 3b–3f.
 */
export default function Home() {
  const [check, setCheck] = useState<Check>({ state: 'loading' });

  const run = useCallback(async () => {
    setCheck({ state: 'loading' });
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      const health = (await res.json()) as Health;
      setCheck({ state: 'ok', health, ms: Date.now() - t0 });
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      setCheck({ state: 'error', message: aborted ? 'La API no respondió en 6 s' : (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <View style={styles.screen}>
      <View style={styles.brand}>
        <View style={styles.shield}>
          <View style={styles.dot} />
        </View>
        <View>
          <Text style={styles.title}>Guard-IA</Text>
          <Text style={styles.subtitle}>App del vecino · versión de desarrollo</Text>
        </View>
      </View>

      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text style={styles.label}>Conexión con la API</Text>
        <Text style={styles.mono} selectable>
          {API_URL}
        </Text>
        {check.state === 'loading' ? (
          <View style={styles.row}>
            <ActivityIndicator color={color.accent} />
            <Text style={styles.body}>Probando…</Text>
          </View>
        ) : check.state === 'ok' ? (
          <>
            <Text style={[styles.status, { color: check.health.ok ? color.ok : color.warn }]}>
              {check.health.ok ? `En línea · ${check.ms} ms` : 'La API responde con problemas'}
            </Text>
            <Text style={styles.body}>
              Base {check.health.db ? '✓' : '✗'} · Redis {check.health.redis ? '✓' : '✗'} · Archivos{' '}
              {check.health.storage ? '✓' : '✗'}
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.status, { color: color.sosSoft }]}>Sin conexión</Text>
            <Text style={styles.body}>{check.message}</Text>
            <Text style={styles.hint}>
              Revisa que el teléfono esté en la misma wifi que el PC, que la API corra (pnpm dev) y que el
              firewall de Windows permita el puerto 3000.
            </Text>
          </>
        )}
        <Pressable
          onPress={run}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.buttonText}>Probar de nuevo</Text>
        </Pressable>
      </View>

      <Text style={styles.footnote}>Contrato compartido cargado · consentimiento {CONSENT_VERSION}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 28, justifyContent: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  shield: {
    width: 52,
    height: 52,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: color.sos },
  title: { color: color.ink, fontFamily: font.display, fontSize: 32, letterSpacing: -0.5 },
  subtitle: { color: color.inkMuted, fontFamily: font.body, fontSize: 14 },
  card: {
    gap: 10,
    padding: 18,
    borderRadius: radius.card,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
  },
  label: { color: color.inkMuted, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  mono: { color: color.ink, fontFamily: font.bodyRegular, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontFamily: font.display, fontSize: 24 },
  body: { color: color.ink, fontFamily: font.body, fontSize: 15 },
  hint: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 13, lineHeight: 19 },
  button: {
    marginTop: 6,
    minHeight: TOUCH + 8,
    borderRadius: radius.ctl,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: color.accentInk, fontFamily: font.bodyBold, fontSize: 16 },
  footnote: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12, textAlign: 'center' },
});
