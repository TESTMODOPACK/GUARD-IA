import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import type { CitizenExport } from '@guardia/shared';
import { api, errorMessage } from '@/lib/api';
import { FINAL } from '@/lib/labels';
import { formatPhone } from '@/lib/phone';
import { clearSession } from '@/lib/session';
import { ErrorText, Field, Kicker, Lead, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';
import { color, font, radius, TOUCH } from '@/theme';

const CONFIRM_WORD = 'BORRAR';

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

/** Entrega el JSON al vecino: en la web lo descarga; en el teléfono abre el menú de compartir. */
async function deliver(data: CitizenExport): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'guardia-mis-datos.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  await Share.share({ title: 'Mis datos en Guard-IA', message: text });
}

/**
 * Mis datos (Ley 21.719): acceso (GET /me/export) y supresión (DELETE /me). La supresión anonimiza:
 * los casos quedan en el registro municipal sin datos personales. Al terminar se cierra la sesión.
 */
export default function Privacy() {
  const [data, setData] = useState<CitizenExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [word, setWord] = useState('');
  const [erasing, setErasing] = useState(false);

  useEffect(() => {
    api
      .exportData()
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const openCases = data?.alerts.filter((a) => !FINAL.includes(a.status)).length ?? 0;
  const confirmed = word.trim().toUpperCase() === CONFIRM_WORD;

  async function share() {
    setSharing(true);
    setError(null);
    try {
      // Se pide de nuevo: se entrega lo que hay ahora, no lo que se cargó al abrir.
      const fresh = await api.exportData();
      setData(fresh);
      await deliver(fresh);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSharing(false);
    }
  }

  async function erase() {
    setErasing(true);
    setError(null);
    try {
      await api.eraseAccount();
      // La API ya borró las sesiones; aquí basta con olvidar los tokens. El guard lleva al ingreso.
      await clearSession();
    } catch (e) {
      setError(errorMessage(e));
      setErasing(false);
    }
  }

  return (
    <Screen>
      <View style={{ gap: 8 }}>
        <Kicker>Ley 21.719</Kicker>
        <Title>Mis datos</Title>
        <Lead>Puedes ver todo lo que Guard-IA guarda de ti y pedir que se borre.</Lead>
      </View>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {data === null && !error ? <ActivityIndicator color={color.accent} /> : null}

      {data ? (
        <View style={styles.card}>
          <Row label="Teléfono" value={formatPhone(data.citizen.phone)} />
          <Row label="En Guard-IA desde" value={day(data.citizen.createdAt)} />
          <Row label="Consentimiento" value={`${data.citizen.consentVersion ?? '—'} · ${day(data.citizen.consentAt)}`} />
          <Row label="Alertas y reportes" value={String(data.alerts.length)} />
          <Row label="Teléfonos con avisos" value={String(data.devices.length)} />
        </View>
      ) : null}

      <PrimaryButton
        label={Platform.OS === 'web' ? 'Descargar mis datos' : 'Compartir mis datos'}
        onPress={() => void share()}
        disabled={!data}
        busy={sharing}
      />
      <Text style={styles.note}>
        Un archivo con tu perfil, tus alertas (lo que escribiste, la transcripción y el resumen) y la lista de
        audios y fotos. No incluye los audios ni las fotos.
      </Text>

      <View style={styles.danger}>
        <Text style={styles.dangerTitle} role="heading">
          Borrar mi cuenta
        </Text>
        <Text style={styles.dangerText}>
          Se borran tu teléfono, tus dispositivos, lo que escribiste o dijiste, y tus audios y fotos. Tus casos
          quedan en el registro del municipio sin tus datos y con la ubicación aproximada (unos 100 m). No se
          puede deshacer.
        </Text>
        {openCases > 0 ? (
          <Text style={styles.warn} role="alert">
            {openCases === 1
              ? 'Tienes un caso abierto. La central lo seguirá atendiendo, pero ya no recibirás avisos.'
              : `Tienes ${openCases} casos abiertos. La central los seguirá atendiendo, pero ya no recibirás avisos.`}
          </Text>
        ) : null}

        {!confirming ? (
          <Pressable
            onPress={() => setConfirming(true)}
            disabled={!data}
            role="button"
            style={({ pressed }) => [styles.dangerBtn, (!data || pressed) && { opacity: 0.6 }]}
          >
            <Text style={styles.dangerBtnText}>Quiero borrar mi cuenta</Text>
          </Pressable>
        ) : (
          <View style={{ gap: 12 }}>
            <Field
              label={`Para confirmar, escribe ${CONFIRM_WORD}`}
              value={word}
              onChangeText={setWord}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!erasing}
            />
            <Pressable
              onPress={() => void erase()}
              disabled={!confirmed || erasing}
              role="button"
              aria-disabled={!confirmed || erasing}
              aria-busy={erasing}
              style={[styles.dangerBtn, styles.dangerBtnSolid, (!confirmed || erasing) && { opacity: 0.45 }]}
            >
              {erasing ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={[styles.dangerBtnText, { color: '#ffffff' }]}>Borrar definitivamente</Text>
              )}
            </Pressable>
            <LinkButton
              label="No borrar"
              disabled={erasing}
              onPress={() => {
                setConfirming(false);
                setWord('');
              }}
            />
          </View>
        )}
      </View>

      <LinkButton label="Volver al inicio" onPress={() => router.replace('/')} />
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10, padding: 16, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: color.inkMuted, fontFamily: font.body, fontSize: 13 },
  rowValue: { color: color.ink, fontFamily: font.bodyBold, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  note: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12, lineHeight: 18 },
  danger: {
    gap: 12,
    padding: 16,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'rgba(229,36,59,0.45)',
    backgroundColor: 'rgba(229,36,59,0.06)',
  },
  dangerTitle: { color: color.sosSoft, fontFamily: font.bodyBold, fontSize: 16 },
  dangerText: { color: color.ink, fontFamily: font.bodyRegular, fontSize: 13, lineHeight: 20 },
  warn: { color: color.warn, fontFamily: font.body, fontSize: 13, lineHeight: 19 },
  dangerBtn: {
    minHeight: TOUCH + 4,
    borderRadius: radius.ctl,
    borderWidth: 1,
    borderColor: color.sos,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerBtnSolid: { backgroundColor: color.sos },
  dangerBtnText: { color: color.sosSoft, fontFamily: font.bodyBold, fontSize: 15 },
});
