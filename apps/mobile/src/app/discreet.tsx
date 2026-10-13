import { RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { errorMessage, sendAlert } from '@/lib/api';
import { currentFix, type Fix } from '@/lib/location';
import { audioFile, MAX_RECORDING_S, prepareMic, startRecording } from '@/lib/recorder';

/** Los primeros segundos "Salir" anula sin enviar (entrada por error); después ya es una alerta. */
const GRACE_S = 3;

type Phase = 'recording' | 'sending' | 'sent' | 'failed';

/**
 * Modo discreto: parece la pantalla bloqueada (hora atenuada, sin colores ni sonido). Graba 15 s de
 * ambiente y envía el SOS con audio y ubicación sin que se note. Si algo falla, lo dice en voz baja
 * (texto gris) y ofrece salir; la barra 133/131/132 queda oculta para no delatar el modo.
 */
export default function Discreet() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>('recording');
  const [elapsed, setElapsed] = useState(0);
  const [now, setNow] = useState(new Date());
  const fix = useRef<Promise<Fix> | null>(null);
  const clientRef = useRef(Crypto.randomUUID());
  const started = useRef(false);
  const sent = useRef<Promise<string | null> | null>(null);

  /** Envía una sola vez; devuelve el id de la alerta (o null si falló). */
  const send = useCallback((): Promise<string | null> => {
    if (sent.current) return sent.current;
    setPhase('sending');
    sent.current = (async () => {
      try {
        if (started.current) await recorder.stop();
        const uri = started.current ? recorder.uri : null;
        if (started.current && !uri) console.warn('modo discreto: la grabación terminó sin archivo');
        const loc = await (fix.current ?? currentFix());
        const res = await sendAlert(
          {
            type: 'EMERGENCY_SOS',
            source: 'DISCREET',
            location: { lat: loc.lat, lng: loc.lng },
            accuracyM: loc.accuracyM,
            clientRef: clientRef.current,
          },
          uri ? { audio: audioFile(uri) } : {},
        );
        setPhase('sent');
        return res.alertId;
      } catch (e) {
        console.warn('modo discreto:', errorMessage(e));
        setPhase('failed');
        return null;
      }
    })();
    return sent.current;
  }, [recorder]);

  useEffect(() => {
    const p = currentFix();
    p.catch(() => undefined);
    fix.current = p;
    (async () => {
      try {
        await prepareMic();
        await startRecording(recorder);
        started.current = true;
      } catch (e) {
        // Sin micrófono el SOS sale igual, solo con ubicación (registro solo en consola, nunca en pantalla).
        console.warn('modo discreto: no se pudo grabar:', (e as Error)?.message ?? e);
      }
    })();
    const tick = setInterval(() => {
      setNow(new Date());
      setElapsed((s) => s + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [recorder]);

  useEffect(() => {
    if (phase === 'recording' && elapsed >= MAX_RECORDING_S) void send();
  }, [elapsed, phase, send]);

  const exit = async () => {
    if (phase === 'recording' && elapsed < GRACE_S) {
      sent.current = Promise.resolve(null); // anulado: nada se envía
      if (started.current) await recorder.stop().catch(() => undefined);
      router.back();
      return;
    }
    const id = await send();
    if (id) router.replace({ pathname: '/alert/[id]', params: { id } });
    else router.replace('/');
  };

  const status =
    phase === 'recording' ? (elapsed < GRACE_S ? '·' : String(MAX_RECORDING_S - elapsed)) : phase === 'sending' ? '…' : phase === 'sent' ? 'listo' : 'sin red';

  return (
    <View style={styles.screen}>
      <View style={{ alignItems: 'center', marginTop: 120 }}>
        <Text style={styles.clock}>{now.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</Text>
        <Text style={styles.date}>{now.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
      </View>
      <View style={{ alignItems: 'center', gap: 16 }}>
        <Text style={styles.status} accessibilityLabel={`Modo discreto: ${status}`}>
          {status}
        </Text>
        <Pressable onPress={exit} role="button" accessibilityLabel="Salir del modo discreto" style={styles.exit}>
          <Text style={styles.exitText}>Salir</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000', justifyContent: 'space-between', paddingBottom: 32 },
  clock: { color: '#2a2e35', fontFamily: 'BricolageGrotesque_600SemiBold', fontSize: 76 },
  date: { color: '#2a2e35', fontFamily: 'Manrope_500Medium', fontSize: 15 },
  status: { color: '#3a3f47', fontFamily: 'Manrope_500Medium', fontSize: 11 },
  exit: { minWidth: 120, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#1a1d22', alignItems: 'center', justifyContent: 'center' },
  exitText: { color: '#4a505a', fontFamily: 'Manrope_500Medium', fontSize: 12 },
});
