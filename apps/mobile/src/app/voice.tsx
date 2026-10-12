import { RecordingPresets, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { errorMessage, sendAlert } from '@/lib/api';
import { currentFix, LocationError, type Fix } from '@/lib/location';
import { audioFile, MAX_RECORDING_S, MicError, prepareMic } from '@/lib/recorder';
import { ErrorText, LinkButton, Screen } from '@/components/ui';
import { color, font } from '@/theme';

const MIN_MS = 1000;

/** Micrófono dibujado con vistas (sin emoji ni dependencias de íconos). */
function MicGlyph() {
  return (
    <View style={{ alignItems: 'center' }} aria-hidden>
      <View style={{ width: 30, height: 48, borderRadius: 15, borderWidth: 4, borderColor: '#ffffff' }} />
      <View style={{ width: 4, height: 12, backgroundColor: '#ffffff', marginTop: 4 }} />
      <View style={{ width: 28, height: 4, borderRadius: 2, backgroundColor: '#ffffff' }} />
    </View>
  );
}

/**
 * SOS por voz: mantener presionado para grabar (máx. 15 s), soltar para enviar. Ubicación y micrófono
 * se preparan al entrar, para que al soltar la alerta salga de inmediato con audio y GPS.
 */
export default function Voice() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 200);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const fix = useRef<Promise<Fix> | null>(null);
  const clientRef = useRef(Crypto.randomUUID());
  const limit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const p = currentFix();
    p.catch(() => undefined);
    fix.current = p;
    prepareMic()
      .then(() => setReady(true))
      .catch((e) => setError(e instanceof MicError ? e.message : errorMessage(e)));
    return () => clearTimeout(limit.current);
  }, []);

  useEffect(() => {
    if (!rec.isRecording) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.ease), useNativeDriver: true })).start();
  }, [rec.isRecording, pulse]);

  const send = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('No se pudo guardar la grabación');
      const loc = await (fix.current ?? currentFix());
      const res = await sendAlert(
        {
          type: 'EMERGENCY_SOS',
          source: 'VOICE',
          location: { lat: loc.lat, lng: loc.lng },
          accuracyM: loc.accuracyM,
          clientRef: clientRef.current,
        },
        { audio: audioFile(uri) },
      );
      router.replace({ pathname: '/alert/[id]', params: { id: res.alertId } });
    } catch (e) {
      setSending(false);
      setError(e instanceof LocationError ? e.message : errorMessage(e));
    }
  }, [recorder]);

  const start = async () => {
    if (!ready || sending) return;
    setHint(null);
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      limit.current = setTimeout(() => void send(), MAX_RECORDING_S * 1000);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const release = async () => {
    clearTimeout(limit.current);
    if (!rec.isRecording || sending) return;
    if (rec.durationMillis < MIN_MS) {
      await recorder.stop();
      setHint('Mantén presionado al menos 1 segundo y habla.');
      return;
    }
    void send();
  };

  const secs = Math.min(MAX_RECORDING_S, Math.floor(rec.durationMillis / 1000));
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  return (
    <Screen center>
      <View style={{ gap: 8, alignItems: 'center' }}>
        <Text style={styles.title}>{rec.isRecording ? 'Te escuchamos…' : 'Mantén presionado y habla'}</Text>
        <Text style={styles.lead}>Di qué pasa y dónde. Al soltar, la alerta sale con tu audio y tu ubicación.</Text>
      </View>

      <View style={styles.micWrap}>
        <Animated.View style={[styles.halo, { transform: [{ scale }], opacity }]} />
        <Pressable
          onPressIn={start}
          onPressOut={release}
          disabled={!ready || sending}
          role="button"
          accessibilityLabel="Mantén presionado para grabar; suelta para enviar la alerta"
          style={[styles.mic, rec.isRecording && styles.micOn, (!ready || sending) && { opacity: 0.5 }]}
        >
          {sending ? <ActivityIndicator color="#ffffff" size="large" /> : <MicGlyph />}
        </Pressable>
      </View>

      <Text style={styles.timer} accessibilityLiveRegion="polite">
        {sending ? 'Enviando a la central…' : `0:${String(secs).padStart(2, '0')} / 0:${MAX_RECORDING_S}`}
      </Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {!ready && !error ? <Text style={styles.hint}>Preparando el micrófono…</Text> : null}
      <LinkButton label="Volver" onPress={() => router.back()} disabled={sending} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink, fontFamily: font.display, fontSize: 28, textAlign: 'center' },
  lead: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 300 },
  micWrap: { alignSelf: 'center', width: 220, height: 220, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: 200, height: 200, borderRadius: 100, backgroundColor: color.sos },
  mic: {
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: color.sos,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 10,
    borderColor: 'rgba(255,59,79,0.2)',
  },
  micOn: { transform: [{ scale: 1.06 }] },
  timer: { color: color.ink, fontFamily: font.display, fontSize: 30, textAlign: 'center' },
  hint: { color: color.warn, fontFamily: font.body, fontSize: 14, textAlign: 'center' },
});
