import type { CitizenAccountDetail } from '@guardia/shared';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, errorMessage, syncAccount } from '@/lib/api';
import { accountBanner, REVIEW_STATUS, shortDate, untilText } from '@/lib/labels';
import { onAccountUpdated } from '@/lib/realtime';
import { ErrorText, Field, Kicker, LinkButton, PrimaryButton, Screen, Title } from '@/components/ui';
import { color, font, radius } from '@/theme';

type Target = { strikeId?: string; blockId?: string; label: string };

/**
 * Estado de tu cuenta (docs/plan-plataforma.md §5b, debido proceso): advertencias vigentes, bloqueo, hasta
 * cuándo y quién lo decidió, y "Pedir revisión" con un texto breve que llega a la central que sancionó.
 */
export default function AccountScreen() {
  const [data, setData] = useState<CitizenAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.account());
      setError(null);
      void syncAccount();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // Se relee cuando la central decide algo (account.updated): bloqueo levantado, revisión respondida…
    return onAccountUpdated(() => void load());
  }, [load]);

  const send = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      setData(await api.requestReview({ strikeId: target.strikeId, blockId: target.blockId, text: text.trim() }));
      setTarget(null);
      setText('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const banner = data ? accountBanner(data.account) : null;

  return (
    <Screen>
      <Kicker>Mis datos</Kicker>
      <Title>Estado de tu cuenta</Title>

      {!data ? (
        error ? <ErrorText>{error}</ErrorText> : <ActivityIndicator color={color.accent} />
      ) : (
        <>
          <View style={styles.card}>
            {data.account.level === 'OK' ? (
              <Text style={styles.cardText}>Tu cuenta está al día: no tienes advertencias vigentes.</Text>
            ) : data.account.level === 'BLOCKED' && data.account.block ? (
              <Text style={styles.cardText}>
                {data.account.block.tenantName} bloqueó tu cuenta {untilText(data.account.block.endsAt)} por avisos falsos reiterados.
                Mientras dure no puedes enviar alertas desde la app.
              </Text>
            ) : banner ? (
              <>
                <Text style={styles.cardTitle}>{banner.title}</Text>
                <Text style={styles.cardText}>{banner.body.replace(' Toca para ver el detalle o pedir revisión.', '')}</Text>
              </>
            ) : null}
            <Text style={styles.cardMeta}>Ante una emergencia real llama al 133, 131 o 132.</Text>
          </View>

          {data.block ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>{data.block.status === 'ACTIVE' ? 'Bloqueo' : 'Bloqueo en evaluación'}</Text>
              <Text style={styles.cardText}>
                {data.block.status === 'ACTIVE'
                  ? `${data.block.tenantName}, ${untilText(data.block.endsAt)}.`
                  : `${data.block.tenantName} está evaluando bloquear tu cuenta por avisos falsos reiterados.`}
              </Text>
              <ReviewLine
                status={data.block.reviewStatus}
                onRequest={() => setTarget({ blockId: data.block!.id, label: 'el bloqueo' })}
              />
            </View>
          ) : null}

          {data.strikes.length ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Advertencias vigentes</Text>
              {data.strikes.map((s) => (
                <View key={s.id} style={styles.item}>
                  <Text style={styles.cardText}>
                    Aviso falso registrado por {s.tenantName} el {shortDate(s.createdAt)}. Vence el {shortDate(s.expiresAt)}.
                  </Text>
                  <ReviewLine
                    status={s.reviewStatus}
                    onRequest={() => setTarget({ strikeId: s.id, label: `la advertencia del ${shortDate(s.createdAt)}` })}
                  />
                </View>
              ))}
            </View>
          ) : null}

          {target ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Pedir revisión de {target.label}</Text>
              <Field
                label="Cuéntanos qué pasó (mínimo 10 caracteres)"
                value={text}
                onChangeText={setText}
                multiline
                maxLength={1000}
                placeholder="Ej.: me robaron el teléfono ese día"
              />
              {error ? <ErrorText>{error}</ErrorText> : null}
              <PrimaryButton label="Enviar a la central" onPress={() => void send()} busy={busy} disabled={text.trim().length < 10} />
              <LinkButton label="Cancelar" onPress={() => setTarget(null)} />
            </View>
          ) : null}

          {data.reviews.length ? (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Tus solicitudes de revisión</Text>
              {data.reviews.map((r) => (
                <View key={r.id} style={styles.item}>
                  <Text style={styles.cardMeta}>
                    {shortDate(r.createdAt)} · {r.tenantName} · {REVIEW_STATUS[r.status]}
                  </Text>
                  <Text style={styles.cardText}>“{r.text}”</Text>
                  {r.response ? <Text style={styles.response}>Respuesta: {r.response}</Text> : null}
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}

      <LinkButton label="Volver" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
    </Screen>
  );
}

function ReviewLine({ status, onRequest }: { status: keyof typeof REVIEW_STATUS | null; onRequest: () => void }) {
  if (status === 'PENDING') return <Text style={styles.cardMeta}>{REVIEW_STATUS.PENDING}</Text>;
  return (
    <Pressable onPress={onRequest} role="button" style={({ pressed }) => [styles.reviewBtn, pressed && { opacity: 0.8 }]}>
      <Text style={styles.reviewText}>{status ? `${REVIEW_STATUS[status]} · Pedir otra revisión` : 'Pedir revisión'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, padding: 16, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.line },
  cardLabel: { color: color.inkMuted, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  cardTitle: { color: color.warn, fontFamily: font.bodyBold, fontSize: 15 },
  cardText: { color: color.ink, fontFamily: font.body, fontSize: 14, lineHeight: 20 },
  cardMeta: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12 },
  response: { color: color.ink, fontFamily: font.bodyRegular, fontSize: 13, lineHeight: 19 },
  item: { gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: color.line },
  reviewBtn: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: color.accentSoft },
  reviewText: { color: color.accent, fontFamily: font.bodyBold, fontSize: 13 },
});
