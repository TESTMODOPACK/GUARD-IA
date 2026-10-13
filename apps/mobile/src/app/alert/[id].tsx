import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CANCEL_WINDOW_SECONDS, type CitizenAlert } from '@guardia/shared';
import { api, errorMessage } from '@/lib/api';
import { dispatchLine, FINAL, isWarning, kindLabel, textFor, titleFor } from '@/lib/labels';
import { onAlertStatus, onConnection } from '@/lib/realtime';
import { ErrorText, LinkButton, Screen } from '@/components/ui';
import { color, font, radius } from '@/theme';

/** Respaldo si el WebSocket se cae; con el canal en vivo los cambios llegan al instante. */
const POLL_MS = 15_000;

/**
 * Estado de una alerta propia: llega en vivo por /citizen (`alert.status`) y se reconsulta cada 15 s
 * por si el canal se cortó. Cancelar solo mientras está PENDING y dentro de los 30 s (la API valida
 * lo mismo).
 */
export default function AlertStatus() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [alert, setAlert] = useState<CitizenAlert | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [live, setLive] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setAlert(await api.alert(id));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cambios en vivo de esta alerta.
  useEffect(
    () =>
      onAlertStatus((a) => {
        if (a.id === id) setAlert(a);
      }),
    [id],
  );
  // Al reconectar, recuperar lo que pudo cambiar mientras no había canal.
  useEffect(
    () =>
      onConnection((online) => {
        setLive(online);
        if (online) void load();
      }),
    [load],
  );

  const final = alert ? FINAL.includes(alert.status) : false;
  useEffect(() => {
    if (final) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [final, load]);

  // Reloj de la ventana de cancelación.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!alert) {
    return (
      <Screen center>
        {error ? <ErrorText>{error}</ErrorText> : <ActivityIndicator color={color.accent} size="large" />}
      </Screen>
    );
  }

  const cancelLeft = Math.max(0, Math.ceil((new Date(alert.createdAt).getTime() + CANCEL_WINDOW_SECONDS * 1000 - now) / 1000));
  const canCancel = alert.status === 'PENDING' && cancelLeft > 0;
  const unrouted = alert.status === 'UNROUTED';
  const done = alert.status === 'RESOLVED';
  const tone =
    unrouted || isWarning(alert)
      ? styles.toneWarn
      : done
        ? styles.toneOk
        : alert.status === 'CANCELLED' || alert.status === 'REJECTED'
          ? styles.toneNeutral
          : styles.toneSos;
  const unit = dispatchLine(alert);

  const cancel = async () => {
    setCancelling(true);
    try {
      setAlert(await api.cancelAlert(alert.id));
    } catch (e) {
      setError(errorMessage(e));
      void load();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Screen>
      <View style={[styles.card, tone]}>
        <Text style={styles.kicker}>{kindLabel(alert)} · {alert.tenantName ?? 'sin municipio'}</Text>
        <Text style={styles.title} accessibilityLiveRegion="polite">
          {titleFor(alert)}
        </Text>
        <Text style={styles.text}>{textFor(alert)}</Text>
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
      </View>

      {unrouted ? (
        <Pressable onPress={() => Linking.openURL('tel:133')} role="button" style={styles.call}>
          <Text style={styles.callText}>Llamar al 133 · Carabineros</Text>
        </Pressable>
      ) : null}

      {canCancel ? (
        <Pressable
          onPress={cancel}
          disabled={cancelling}
          role="button"
          style={({ pressed }) => [styles.cancel, (pressed || cancelling) && { opacity: 0.7 }]}
        >
          <Text style={styles.cancelText}>{cancelling ? 'Cancelando…' : `Cancelar ${alert.type === 'CIVIC_REPORT' ? 'reporte' : 'alerta'} · quedan ${cancelLeft} s`}</Text>
        </Pressable>
      ) : alert.status === 'ACKNOWLEDGED' || alert.status === 'DISPATCHED' ? (
        <Text style={styles.note}>La central ya tomó tu caso; no se puede cancelar desde la app.</Text>
      ) : null}

      {error ? <ErrorText>{error}</ErrorText> : null}
      {!final ? (
        <Text style={styles.note}>{live ? 'En vivo · los cambios de la central aparecen al instante' : 'Reconectando… revisamos el estado cada 15 s'}</Text>
      ) : null}
      <LinkButton label="Volver al inicio" onPress={() => router.replace('/')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6, padding: 18, borderRadius: 22 },
  toneSos: { backgroundColor: '#3a1220' },
  toneOk: { backgroundColor: '#07304a' },
  toneWarn: { backgroundColor: '#2a1f0c' },
  toneNeutral: { backgroundColor: color.surface },
  kicker: { color: color.sosSoft, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  title: { color: color.ink, fontFamily: font.display, fontSize: 26, lineHeight: 30 },
  text: { color: color.ink, fontFamily: font.body, fontSize: 14, lineHeight: 21 },
  unit: { color: color.ink, fontFamily: font.bodyBold, fontSize: 15, marginTop: 4 },
  call: { minHeight: 60, borderRadius: 18, backgroundColor: color.sos, alignItems: 'center', justifyContent: 'center' },
  callText: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 17 },
  cancel: {
    minHeight: 54,
    borderRadius: radius.ctl,
    borderWidth: 1,
    borderColor: '#5a1d28',
    backgroundColor: '#1a0f16',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: color.sosSoft, fontFamily: font.bodyBold, fontSize: 15 },
  note: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12, textAlign: 'center' },
});
