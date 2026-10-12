import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { CitizenAlert } from '@guardia/shared';
import { api, errorMessage } from '@/lib/api';
import { dispatchLine, FINAL, kindLabel, titleFor } from '@/lib/labels';
import { onAlertStatus } from '@/lib/realtime';
import { ErrorText, LinkButton, Screen, Title } from '@/components/ui';
import { color, font, radius } from '@/theme';

function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'Hace un momento';
  if (mins < 60) return `Hace ${mins} min`;
  return d.toLocaleString('es-CL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Mis casos: últimas 20 alertas y reportes del vecino; los abiertos se actualizan en vivo. */
export default function Cases() {
  const [items, setItems] = useState<CitizenAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.mine());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onAlertStatus((a) =>
        setItems((list) => {
          if (!list) return list;
          return list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list];
        }),
      ),
    [],
  );

  return (
    <Screen>
      <Title>Mis casos</Title>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {items === null && !error ? <ActivityIndicator color={color.accent} /> : null}
      {items?.length === 0 ? <Text style={styles.empty}>Todavía no has enviado alertas ni reportes.</Text> : null}
      <View style={{ gap: 10 }}>
        {items?.map((a) => {
          const open = !FINAL.includes(a.status);
          const sos = a.type === 'EMERGENCY_SOS';
          const unit = dispatchLine(a);
          return (
            <Pressable
              key={a.id}
              onPress={() => router.push({ pathname: '/alert/[id]', params: { id: a.id } })}
              role="button"
              accessibilityLabel={`${kindLabel(a)}: ${titleFor(a)}`}
              style={({ pressed }) => [styles.item, pressed && { opacity: 0.8 }]}
            >
              <View style={[styles.dot, { backgroundColor: sos ? color.sos : color.accent }]} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.itemTitle}>{kindLabel(a)}</Text>
                <Text style={styles.itemMeta}>
                  {when(a.createdAt)}
                  {unit ? ` · ${unit}` : ''}
                </Text>
              </View>
              <Text style={[styles.badge, open ? styles.badgeLive : styles.badgeDone]}>{titleFor(a)}</Text>
            </Pressable>
          );
        })}
      </View>
      <LinkButton label="Volver al inicio" onPress={() => router.replace('/')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { color: color.inkMuted, fontFamily: font.body, fontSize: 15 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.card,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  itemTitle: { color: color.ink, fontFamily: font.bodyBold, fontSize: 15 },
  itemMeta: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 12 },
  badge: { fontFamily: font.bodyBold, fontSize: 11, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, overflow: 'hidden', maxWidth: 140, textAlign: 'center' },
  badgeLive: { color: color.sosSoft, backgroundColor: color.sosTint },
  badgeDone: { color: color.ok, backgroundColor: color.okSoft },
});
