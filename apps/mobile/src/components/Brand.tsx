import { Image, StyleSheet, Text, View } from 'react-native';
import { color, font } from '@/theme';

const MARK = require('../../assets/brand/mark.png');

export const TAGLINE = 'Seguridad ciudadana que responde en el momento en que importa';

/** Símbolo del logo (escudo, persona y ondas), sin fondo. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return <Image source={MARK} style={{ width: size, height: size }} resizeMode="contain" accessibilityIgnoresInvertColors />;
}

/** Logo completo: símbolo, "GUARD-IA" (el "IA" en el azul del logo) y, opcional, el lema. */
export function BrandLockup({ tagline = false }: { tagline?: boolean }) {
  return (
    <View style={styles.wrap} accessible role="img" accessibilityLabel={tagline ? `Guard-IA. ${TAGLINE}` : 'Guard-IA'}>
      <BrandMark size={96} />
      <Text style={styles.word}>
        GUARD<Text style={{ color: color.accent }}>-IA</Text>
      </Text>
      {tagline ? <Text style={styles.tagline}>{TAGLINE}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 8 },
  word: { color: color.ink, fontFamily: font.display, fontSize: 40, lineHeight: 44, letterSpacing: 0.5 },
  tagline: { color: color.inkMuted, fontFamily: font.body, fontSize: 15, lineHeight: 21, textAlign: 'center', maxWidth: 280 },
});
