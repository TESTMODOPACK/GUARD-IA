import { CIVIC_CATEGORIES, type CivicCategory } from '@guardia/shared';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { errorMessage, sendAlert, type UploadFile } from '@/lib/api';
import { CIVIC_LABEL } from '@/lib/labels';
import { currentFix, LocationError, type Fix } from '@/lib/location';
import { ErrorText, Kicker, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';
import { color, font, radius } from '@/theme';

const MAX_TEXT = 1000;

/**
 * Reporte urbano: categoría + foto (cámara o galería) + descripción opcional + ubicación.
 * Va a la misma central, con type CIVIC_REPORT y source FORM; la API limita los reportes por día.
 */
export default function Report() {
  const [category, setCategory] = useState<CivicCategory | null>(null);
  const [photo, setPhoto] = useState<UploadFile | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const fix = useRef<Promise<Fix> | null>(null);
  const clientRef = useRef(Crypto.randomUUID());

  useEffect(() => {
    const p = currentFix();
    p.then((f) => setAccuracy(f.accuracyM ?? null)).catch(() => undefined);
    fix.current = p;
  }, []);

  const pick = async (source: 'camera' | 'library') => {
    setError(null);
    const perm =
      source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError(source === 'camera' ? 'Sin permiso de cámara. Puedes elegir una foto de la galería.' : 'Sin permiso para ver tus fotos.');
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6, exif: false };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    const type = a.mimeType ?? 'image/jpeg';
    setPhoto({ uri: a.uri, type, name: `reporte.${type.split('/')[1] ?? 'jpg'}` });
  };

  const submit = async () => {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      const loc = await (fix.current ?? currentFix());
      const res = await sendAlert(
        {
          type: 'CIVIC_REPORT',
          source: 'FORM',
          category,
          userText: text.trim() || undefined,
          location: { lat: loc.lat, lng: loc.lng },
          accuracyM: loc.accuracyM,
          clientRef: clientRef.current,
        },
        photo ? { photo } : {},
      );
      router.replace({ pathname: '/alert/[id]', params: { id: res.alertId } });
    } catch (e) {
      if (e instanceof LocationError) fix.current = null;
      setError(e instanceof LocationError ? e.message : errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ gap: 6 }}>
        <Kicker>Reporte urbano</Kicker>
        <Title>¿Qué quieres reportar?</Title>
      </View>

      <View style={styles.grid} role="radiogroup" accessibilityLabel="Categoría">
        {CIVIC_CATEGORIES.map((c) => {
          const on = category === c;
          return (
            <Pressable
              key={c}
              onPress={() => setCategory(c)}
              role="radio"
              aria-checked={on}
              style={[styles.cat, on && styles.catOn]}
            >
              <Text style={[styles.catText, on && styles.catTextOn]}>{CIVIC_LABEL[c]}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ gap: 10 }}>
        <Text style={styles.label}>Foto (recomendada)</Text>
        {photo ? (
          <View style={styles.photoWrap}>
            <Image source={{ uri: photo.uri }} style={styles.photo} accessibilityLabel="Foto del reporte" />
            <Pressable onPress={() => setPhoto(null)} role="button" style={styles.photoRemove}>
              <Text style={styles.photoRemoveText}>Quitar</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable onPress={() => pick('camera')} role="button" style={styles.photoBtn}>
              <Text style={styles.photoBtnText}>Tomar foto</Text>
            </Pressable>
            <Pressable onPress={() => pick('library')} role="button" style={styles.photoBtn}>
              <Text style={styles.photoBtnText}>Elegir de la galería</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.label}>Descripción (opcional)</Text>
        <TextInput
          value={text}
          onChangeText={(t) => setText(t.slice(0, MAX_TEXT))}
          placeholder="Ej.: bache grande frente al número 1234"
          placeholderTextColor={color.inkFaint}
          multiline
          accessibilityLabel="Descripción del reporte"
          style={styles.textarea}
        />
      </View>

      <Text style={styles.loc}>
        {accuracy !== null ? `Ubicación actual · precisión ±${Math.round(accuracy)} m` : 'Obteniendo tu ubicación…'}
      </Text>

      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label={category ? 'Enviar reporte' : 'Elige una categoría'} onPress={submit} disabled={!category} busy={busy} />
      <LinkButton label="Volver" onPress={() => router.back()} disabled={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cat: {
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: 56,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catOn: { backgroundColor: color.accent, borderColor: color.accent },
  catText: { color: color.ink, fontFamily: font.bodyBold, fontSize: 13, textAlign: 'center' },
  catTextOn: { color: color.accentInk },
  label: { color: color.inkMuted, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  photoBtn: {
    flex: 1,
    minHeight: 96,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  photoBtnText: { color: color.ink, fontFamily: font.bodyBold, fontSize: 14, textAlign: 'center' },
  photoWrap: { borderRadius: radius.card, overflow: 'hidden' },
  photo: { width: '100%', height: 180 },
  photoRemove: { position: 'absolute', top: 10, right: 10, minHeight: 36, paddingHorizontal: 12, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center' },
  photoRemoveText: { color: '#ffffff', fontFamily: font.bodyBold, fontSize: 12 },
  textarea: {
    minHeight: 96,
    borderRadius: radius.ctl,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
    padding: 12,
    color: color.ink,
    fontFamily: font.body,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  loc: { color: color.inkMuted, fontFamily: font.body, fontSize: 13 },
});
