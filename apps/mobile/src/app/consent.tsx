import Constants from 'expo-constants';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { LegalNotice } from '@guardia/shared';
import { api, ApiError, errorMessage, logout } from '@/lib/api';
import { clearSession, updateCitizen } from '@/lib/session';
import { ErrorText, Kicker, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';
import { color, font, radius, TOUCH } from '@/theme';

const TINTS = [color.accent, color.ok, '#8fb4ea', color.warn];

/**
 * Consentimiento e información (Ley 21.719, 0014). El texto no está escrito en la app: es el aviso que arma la API con
 * la configuración vigente (GET /legal/notice), así nombra al proveedor de IA que de verdad se usa. Al aceptar se envía
 * su hash y la base guarda ese texto exacto como prueba. Sin aceptar, la app no deja pedir ayuda (los números de
 * emergencia siguen a la vista).
 */
export default function Consent() {
  const [notice, setNotice] = useState<LegalNotice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adult, setAdult] = useState<boolean | null>(null);
  const [externalAi, setExternalAi] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setNotice(await api.legalNotice());
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = async () => {
    if (!notice) return;
    setBusy(true);
    setError(null);
    try {
      await api.consent({
        version: notice.version,
        noticeHash: notice.hash,
        externalAi,
        ageConfirmed: true,
        appVersion: Constants.expoConfig?.version,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
      });
      await updateCitizen(await api.me());
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        // El aviso cambió mientras se leía (otro proveedor, nueva versión): se muestra el nuevo antes de aceptar.
        setAccepted(false);
        await load();
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** Menor de 14: no se crea la cuenta; se borra el número que ya se verificó. */
  const leaveAsMinor = async () => {
    setBusy(true);
    try {
      await api.eraseAccount();
    } catch {
      // Sin red: igual se sale; la cuenta sin consentimiento no puede enviar alertas.
    }
    await clearSession();
  };

  return (
    <Screen>
      <View style={{ gap: 6, paddingTop: 12 }}>
        <Kicker>{notice ? `Aviso ${notice.version} · Ley 21.719` : 'Ley 21.719'}</Kicker>
        <Title>Así usamos tus datos</Title>
      </View>

      {!notice && !loadError ? <ActivityIndicator color={color.accent} /> : null}
      {loadError ? (
        <View style={{ gap: 8 }}>
          <ErrorText>{loadError}</ErrorText>
          <LinkButton label="Reintentar" onPress={() => void load()} />
        </View>
      ) : null}

      {notice ? (
        <>
          <View style={{ gap: 10 }}>
            {notice.sections.map((s, i) => (
              <View key={s.key} style={styles.item}>
                <View style={[styles.mark, { backgroundColor: TINTS[i % TINTS.length] }]} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.itemTitle} role="heading">
                    {s.title}
                  </Text>
                  <Text style={styles.itemText}>{s.text}</Text>
                  {s.key === 'ai' && notice.externalAi ? (
                    <View style={styles.switchRow}>
                      <Text style={styles.switchText}>Analizar mis alertas con {notice.externalAi.name}</Text>
                      <Switch
                        value={externalAi}
                        onValueChange={setExternalAi}
                        accessibilityLabel={`Analizar mis alertas con ${notice.externalAi.name}`}
                      />
                    </View>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
          {notice.policyUrl ? (
            <LinkButton label="Leer la política de tratamiento completa" onPress={() => void Linking.openURL(notice.policyUrl!)} />
          ) : null}

          <View style={styles.ageBox}>
            <Text style={styles.itemTitle}>¿Tienes {notice.minAge} años o más?</Text>
            <View style={styles.ageRow}>
              <Choice label="Sí" selected={adult === true} onPress={() => setAdult(true)} />
              <Choice label="No" selected={adult === false} onPress={() => setAdult(false)} />
            </View>
          </View>

          {adult === false ? (
            <View style={styles.minor} role="alert">
              <Text style={styles.itemTitle}>Esta app es para personas de {notice.minAge} años o más</Text>
              <Text style={styles.itemText}>
                Si estás en peligro, llama al 133 (Carabineros), al 131 (SAMU) o al 132 (Bomberos), o pide ayuda a un adulto de
                confianza. Al salir borramos el número que ingresaste.
              </Text>
              <PrimaryButton label="Salir y borrar mi número" onPress={() => void leaveAsMinor()} busy={busy} />
            </View>
          ) : (
            <>
              <Pressable onPress={() => setAccepted((v) => !v)} role="checkbox" aria-checked={accepted} style={styles.check}>
                <View style={[styles.box, accepted && styles.boxOn]}>{accepted ? <Text style={styles.tick}>✓</Text> : null}</View>
                <Text style={styles.checkText}>Leí el aviso y acepto el uso de mis datos para atender mis alertas.</Text>
              </Pressable>
              {error ? <ErrorText>{error}</ErrorText> : null}
              <PrimaryButton label="Aceptar y continuar" onPress={() => void accept()} disabled={!accepted || adult !== true} busy={busy} />
            </>
          )}
        </>
      ) : null}
      <LinkButton label="No acepto · salir" onPress={() => void logout()} />
    </Screen>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} role="radio" aria-checked={selected} style={[styles.choice, selected && styles.choiceOn]}>
      <Text style={[styles.choiceText, selected && { color: color.accentInk }]}>{label}</Text>
    </Pressable>
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
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 },
  switchText: { flex: 1, color: color.ink, fontFamily: font.body, fontSize: 13 },
  ageBox: { gap: 10, padding: 14, borderRadius: radius.card, borderWidth: 1, borderColor: color.line },
  ageRow: { flexDirection: 'row', gap: 10 },
  choice: {
    flex: 1,
    minHeight: TOUCH,
    borderRadius: radius.ctl,
    borderWidth: 1,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceOn: { backgroundColor: color.accent, borderColor: color.accent },
  choiceText: { color: color.ink, fontFamily: font.bodyBold, fontSize: 15 },
  minor: { gap: 10, padding: 14, borderRadius: radius.card, borderWidth: 1, borderColor: color.warn },
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
