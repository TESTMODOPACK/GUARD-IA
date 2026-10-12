import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, font, radius } from '@/theme';

const NUMBERS = [
  { number: '133', agency: 'Carabineros' },
  { number: '131', agency: 'SAMU' },
  { number: '132', agency: 'Bomberos' },
] as const;

/**
 * Aviso permanente: Guard-IA no reemplaza a los servicios de emergencia. Llamada directa, siempre
 * visible salvo en la cuenta regresiva y el modo discreto.
 */
export function EmergencyBar() {
  return (
    <View style={styles.wrap} role="toolbar" accessibilityLabel="Números de emergencia">
      <View style={styles.dock}>
        {NUMBERS.map((n) => (
          <Pressable
            key={n.number}
            onPress={() => Linking.openURL(`tel:${n.number}`)}
            role="button"
            accessibilityLabel={`Llamar al ${n.number}, ${n.agency}`}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <Text style={styles.number}>{n.number}</Text>
            <Text style={styles.agency}>{n.agency}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  dock: {
    flexDirection: 'row',
    gap: 6,
    padding: 6,
    borderRadius: 22,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.line,
  },
  item: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.ctl,
    backgroundColor: color.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  number: { color: color.ink, fontFamily: font.bodyBold, fontSize: 17 },
  agency: { color: color.inkMuted, fontFamily: font.body, fontSize: 11 },
});
