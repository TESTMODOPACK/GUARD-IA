import type { AlertStatus, CitizenAlert, CivicCategory, DispatchStatus } from '@guardia/shared';

/** Vocabulario del vecino: una palabra por concepto, igual en toda la app. */
export const STATUS_TITLE: Record<AlertStatus, string> = {
  PENDING: 'Alerta enviada',
  ACKNOWLEDGED: 'Un operador revisa tu caso',
  DISPATCHED: 'Unidad en camino',
  RESOLVED: 'Caso resuelto',
  REJECTED: 'Caso cerrado por la central',
  CANCELLED: 'Alerta cancelada',
  UNROUTED: 'Estás fuera de cobertura',
};

export const STATUS_TEXT: Record<AlertStatus, string> = {
  PENDING: 'La central de tu municipio ya la ve en su mapa. Mantén el teléfono contigo.',
  ACKNOWLEDGED: 'Si puedes, aléjate del peligro. Te avisamos cuando salga una unidad.',
  DISPATCHED: 'La unidad municipal se dirige a tu ubicación.',
  RESOLVED: 'El municipio cerró tu caso. Gracias por avisar.',
  REJECTED: 'La central cerró el caso. Si sigues en peligro, llama al 133.',
  CANCELLED: 'Avisamos a la central. Cancelar a tiempo no cuenta como falsa alarma.',
  UNROUTED: 'Tu ubicación no pertenece a un municipio con Guard-IA: ninguna central puede atenderte. Llama ahora.',
};

const DISPATCH: Record<DispatchStatus, string> = {
  ASSIGNED: 'asignada',
  EN_ROUTE: 'en camino',
  ON_SITE: 'en el lugar',
  CLOSED: 'terminó',
  CANCELLED: 'cancelada',
};

/** "PATRULLA-101 en camino", o null si no hay despacho abierto. */
export function dispatchLine(a: CitizenAlert): string | null {
  if (!a.activeDispatch) return null;
  return `${a.activeDispatch.unitCode} ${DISPATCH[a.activeDispatch.status]}`;
}

/** Reportes urbanos: mismo flujo, otras palabras (no hay "unidad en camino" para un bache). */
const CIVIC_TITLE: Partial<Record<AlertStatus, string>> = {
  PENDING: 'Reporte recibido',
  ACKNOWLEDGED: 'El municipio lo está revisando',
  DISPATCHED: 'Equipo municipal asignado',
  RESOLVED: 'Reporte resuelto',
  REJECTED: 'Reporte cerrado por el municipio',
  CANCELLED: 'Reporte cancelado',
};

const CIVIC_TEXT: Partial<Record<AlertStatus, string>> = {
  PENDING: 'Llegó al municipio con tu ubicación. Te avisamos cuando lo atiendan.',
  ACKNOWLEDGED: 'Un operador revisó tu reporte y lo derivará al equipo que corresponde.',
  DISPATCHED: 'Un equipo municipal irá a revisar el lugar.',
  RESOLVED: 'El municipio marcó tu reporte como resuelto. Gracias por avisar.',
  REJECTED: 'El municipio cerró el reporte (por ejemplo, ya estaba informado).',
};

export const CIVIC_LABEL: Record<CivicCategory, string> = {
  BACHE: 'Bache',
  LUMINARIA: 'Luminaria apagada',
  BASURA_MICROBASURAL: 'Basura o microbasural',
  SEMAFORO: 'Semáforo',
  AREA_VERDE: 'Área verde',
  ANIMAL: 'Animal',
  OTRO_URBANO: 'Otro',
};

export function titleFor(a: CitizenAlert): string {
  return (a.type === 'CIVIC_REPORT' && CIVIC_TITLE[a.status]) || STATUS_TITLE[a.status];
}

export function textFor(a: CitizenAlert): string {
  // Fuera de cobertura: si se sabe la comuna, decirla (el vecino entiende por qué y a quién llamar).
  if (a.status === 'UNROUTED' && a.comunaName) {
    return `Estás en ${a.comunaName}, que todavía no usa Guard-IA: ninguna central puede atenderte. Llama ahora.`;
  }
  return (a.type === 'CIVIC_REPORT' && CIVIC_TEXT[a.status]) || STATUS_TEXT[a.status];
}

/** "SOS" o la categoría del reporte ("Bache"). */
export function kindLabel(a: CitizenAlert): string {
  if (a.type === 'EMERGENCY_SOS') return 'SOS';
  return a.category && a.category in CIVIC_LABEL ? CIVIC_LABEL[a.category as CivicCategory] : 'Reporte urbano';
}

/** Estados finales: la pantalla deja de consultar. */
export const FINAL: AlertStatus[] = ['RESOLVED', 'REJECTED', 'CANCELLED', 'UNROUTED'];
