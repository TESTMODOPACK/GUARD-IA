import { z } from 'zod';
import { ALERT_CATEGORIES, type AlertCategory, type AlertType, type Priority } from '../enums';
import { UuidSchema } from './common';

/**
 * Incidentes (migración 0004): alertas sobre la misma situación agrupadas, con un nivel de
 * importancia para que la central vea primero lo que importa y no se sature de repetidos.
 */

/**
 * Cuándo dos alertas son "lo mismo": mismo municipio y tipo, a menos de `radiusM` del centro del
 * incidente y dentro de `windowMin` desde su último reporte, mientras el incidente siga abierto.
 * - Reporte urbano: el mismo bache o luminaria (radio corto), reportado durante semanas.
 * - SOS: el mismo hecho (una pelea, un incendio) visto por varios vecinos en pocos minutos.
 */
export const INCIDENT_RULES: Record<AlertType, { radiusM: number; windowMin: number }> = {
  CIVIC_REPORT: { radiusM: 75, windowMin: 30 * 24 * 60 },
  EMERGENCY_SOS: { radiusM: 200, windowMin: 15 },
};

/** Para marcar recurrencia: incidentes ya cerrados en el mismo lugar y categoría en este plazo. */
export const RECURRENCE_LOOKBACK_DAYS = 90;

export const IMPORTANCE_LEVELS = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'] as const;
export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

export const IMPORTANCE_REASONS = [
  'SOS',
  'PRIORITY_HIGH',
  'PRIORITY_MEDIUM',
  'UNCLASSIFIED_SOS',
  'MANY_CITIZENS',
  'RECURRENT',
  'DANGEROUS_CATEGORY',
  'WEAPON',
  'INJURED',
  'MINOR',
  'POSSIBLE_FALSE_ALARM',
  'LOW_TRUST',
] as const;
export type ImportanceReason = (typeof IMPORTANCE_REASONS)[number];

export function importanceLevel(score: number): ImportanceLevel {
  if (score >= 80) return 'CRITICA';
  if (score >= 60) return 'ALTA';
  if (score >= 35) return 'MEDIA';
  return 'BAJA';
}

export interface ImportanceInput {
  type: AlertType;
  category: AlertCategory | null;
  /** La prioridad más alta entre sus alertas (null: ninguna clasificada todavía). */
  maxPriority: Priority | null;
  /** Vecinos distintos: un mismo vecino que insiste no suma. */
  citizenCount: number;
  recurrenceCount: number;
  weapon: boolean;
  injured: boolean;
  minor: boolean;
  /** La IA marcó posible falsa alarma en TODAS sus alertas. */
  possibleFalseAlarm: boolean;
  /** Mejor nivel de confianza entre quienes reportaron (0–100). */
  maxTrust: number | null;
}

/** Base de un reporte urbano según el riesgo para las personas. */
const CIVIC_BASE: Partial<Record<AlertCategory, number>> = {
  SEMAFORO: 40,
  ANIMAL: 25,
  BACHE: 20,
  LUMINARIA: 20,
  BASURA_MICROBASURAL: 20,
  AREA_VERDE: 10,
  OTRO_URBANO: 15,
};

/**
 * Importancia de 0 a 100 y por qué. Reglas explícitas (no IA) para que el operador entienda el
 * número y el municipio pueda auditarlo:
 * - Un SOS nunca baja de MEDIA (piso 40): la central no lo oculta ni lo silencia.
 * - Un reporte urbano sube con cada vecino distinto que lo confirma (+10, hasta +30) y si el
 *   problema vuelve después de resuelto (+10 por vez, hasta +20).
 */
export function incidentImportance(i: ImportanceInput): {
  score: number;
  level: ImportanceLevel;
  reasons: ImportanceReason[];
} {
  const reasons: ImportanceReason[] = [];
  const add = (points: number, reason?: ImportanceReason) => {
    s += points;
    if (reason) reasons.push(reason);
  };
  const extraCitizens = Math.max(0, i.citizenCount - 1);
  const single = i.citizenCount <= 1;
  let s = 0;

  if (i.type === 'EMERGENCY_SOS') {
    add(65, 'SOS');
    if (i.maxPriority === 'HIGH') add(15, 'PRIORITY_HIGH');
    else if (i.maxPriority === 'MEDIUM') add(5, 'PRIORITY_MEDIUM');
    else if (i.maxPriority === 'LOW') add(-10);
    else add(10, 'UNCLASSIFIED_SOS'); // sin clasificar todavía: se trata como urgente
    if (extraCitizens) add(Math.min(15, extraCitizens * 5), 'MANY_CITIZENS');
    if (i.weapon) add(8, 'WEAPON');
    if (i.injured) add(8, 'INJURED');
    if (i.minor) add(8, 'MINOR');
    if (i.possibleFalseAlarm && single) add(-15, 'POSSIBLE_FALSE_ALARM');
    if (i.maxTrust !== null && i.maxTrust < 50 && single) add(-10, 'LOW_TRUST');
    s = Math.max(40, s);
  } else {
    add((i.category && CIVIC_BASE[i.category]) ?? 15);
    if (i.category === 'SEMAFORO') reasons.push('DANGEROUS_CATEGORY');
    if (i.maxPriority === 'HIGH') add(15, 'PRIORITY_HIGH');
    else if (i.maxPriority === 'MEDIUM') add(5, 'PRIORITY_MEDIUM');
    if (extraCitizens) add(Math.min(30, extraCitizens * 10), 'MANY_CITIZENS');
    if (i.recurrenceCount) add(Math.min(20, i.recurrenceCount * 10), 'RECURRENT');
    if (i.maxTrust !== null && i.maxTrust < 50 && single) add(-10, 'LOW_TRUST');
  }

  const score = Math.max(0, Math.min(100, Math.round(s)));
  return { score, level: importanceLevel(score), reasons };
}

/** Lo que la central sabe del grupo de una alerta. Viaja en AlertSummary.incident. */
export const IncidentInfoSchema = z.object({
  id: UuidSchema,
  /**
   * Clasificación de la SITUACIÓN: la más específica entre sus reportes. Un SOS por botón (sin
   * audio ni texto) queda "sin clasificar", pero si el mismo hecho llegó también por voz, la
   * situación toma la categoría y el resumen que la IA sacó del audio.
   */
  category: z.enum(ALERT_CATEGORIES).nullable(),
  summary: z.string().nullable(),
  /** Alerta que representa al grupo en la cola: la abierta más antigua. */
  primaryAlertId: UuidSchema,
  alertCount: z.number().int(),
  openCount: z.number().int(),
  citizenCount: z.number().int(),
  recurrenceCount: z.number().int(),
  importance: z.number().int().min(0).max(100),
  level: z.enum(IMPORTANCE_LEVELS),
  reasons: z.array(z.enum(IMPORTANCE_REASONS)),
  firstAlertAt: z.iso.datetime(),
  lastAlertAt: z.iso.datetime(),
});
export type IncidentInfo = z.infer<typeof IncidentInfoSchema>;
