/**
 * Colores del logo Guard-IA (medidos sobre el original). Fuente única para la app y la central
 * (apps/command/app/globals.css repite estos valores).
 */
export const brand = {
  navy: '#061a30', // "GUARD"
  deep: '#083f80', // base del escudo
  blue: '#0082da', // escudo y "IA"
  signal: '#01cbdf', // ondas
} as const;

/**
 * Tema nocturno de la app del vecino, derivado del logo: fondos azul marino, acento azul "IA" para
 * acciones normales y cian de las ondas para "en vivo / atendido". El rojo es solo para emergencias.
 */
export const color = {
  bg: '#061426',
  surface: '#0b1e38',
  surface2: '#112849',
  line: '#16304f',
  lineStrong: '#22406a',
  ink: '#eef5fc',
  inkMuted: '#93a8c6',
  inkFaint: '#5b7396',
  accent: '#1fa8f0',
  accentInk: '#031b33',
  accentSoft: 'rgba(31,168,240,0.16)',
  sos: '#e5243b',
  sosDeep: '#a60f25',
  sosSoft: '#ff8a94',
  sosTint: 'rgba(255,59,79,0.16)',
  warn: '#ffc35a',
  ok: '#2fd3e3',
  okSoft: 'rgba(47,211,227,0.14)',
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
