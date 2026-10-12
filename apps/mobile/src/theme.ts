/**
 * Tokens del prototipo "Guard-IA · App del vecino" (modo nocturno).
 * El rojo es solo para emergencias; el acento menta, para acciones normales.
 */
export const color = {
  bg: '#0a0f1c',
  surface: '#121a2b',
  surface2: '#1a2438',
  line: '#1d2638',
  lineStrong: '#2b3650',
  ink: '#f2f5fa',
  inkMuted: '#9aa6bb',
  accent: '#3ee0b5',
  accentInk: '#06231b',
  sos: '#e5243b',
  sosDeep: '#a60f25',
  sosSoft: '#ff8a94',
  warn: '#ffc35a',
  ok: '#7cf0cf',
} as const;

export const font = {
  display: 'BricolageGrotesque_700Bold',
  displaySemi: 'BricolageGrotesque_600SemiBold',
  body: 'Manrope_500Medium',
  bodyRegular: 'Manrope_400Regular',
  bodyBold: 'Manrope_700Bold',
} as const;

export const radius = { ctl: 16, card: 20, pill: 999 } as const;

/** Mínimo de toque (accesibilidad): 44 px. */
export const TOUCH = 44;
