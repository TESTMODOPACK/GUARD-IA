import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type TextInputProps } from 'react-native';
import { TextInput } from 'react-native';
import { color, font, radius, TOUCH } from '@/theme';

/** Pantalla con scroll y teclado: el contenido no queda tapado en teléfonos chicos. */
export function Screen({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <ScrollView
      contentContainerStyle={[styles.screen, center && { flexGrow: 1, justifyContent: 'center' }]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.title} role="heading">
      {children}
    </Text>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <Text style={styles.lead}>{children}</Text>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <Text style={styles.kicker}>{children}</Text>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      role="button"
      aria-disabled={!!off} aria-busy={!!busy}
      style={({ pressed }) => [styles.primary, off && { opacity: 0.45 }, pressed && { opacity: 0.85 }]}
    >
      {busy ? <ActivityIndicator color={color.accentInk} /> : <Text style={styles.primaryText}>{label}</Text>}
    </Pressable>
  );
}

export function LinkButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      role="button"
      style={({ pressed }) => [styles.link, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, prefix, ...input }: TextInputProps & { label: string; prefix?: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputWrap}>
        {prefix ? <Text style={styles.prefix}>{prefix}</Text> : null}
        <TextInput
          {...input}
          accessibilityLabel={label}
          placeholderTextColor="#5d6a7f"
          style={[styles.input, input.style]}
        />
      </View>
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.error} role="alert" accessibilityLiveRegion="assertive">
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 24, gap: 22 },
  title: { color: color.ink, fontFamily: font.display, fontSize: 32, lineHeight: 36, letterSpacing: -0.6 },
  lead: { color: color.inkMuted, fontFamily: font.bodyRegular, fontSize: 15, lineHeight: 22 },
  kicker: { color: color.accent, fontFamily: font.bodyBold, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  primary: {
    minHeight: TOUCH + 12,
    borderRadius: radius.ctl,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: color.accentInk, fontFamily: font.bodyBold, fontSize: 16 },
  link: { minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' },
  linkText: { color: color.accent, fontFamily: font.bodyBold, fontSize: 15 },
  fieldLabel: { color: color.inkMuted, fontFamily: font.body, fontSize: 13 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 58,
    borderRadius: radius.ctl,
    borderWidth: 1,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  prefix: {
    paddingHorizontal: 14,
    color: color.inkMuted,
    fontFamily: font.bodyBold,
    fontSize: 17,
    borderRightWidth: 1,
    borderRightColor: color.lineStrong,
    alignSelf: 'stretch',
    textAlignVertical: 'center',
    lineHeight: 56,
  },
  input: { flex: 1, paddingHorizontal: 14, color: color.ink, fontFamily: font.bodyBold, fontSize: 19 },
  error: { color: color.sosSoft, fontFamily: font.body, fontSize: 14, lineHeight: 20 },
});
