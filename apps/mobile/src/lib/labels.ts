import type { AlertStatus, CitizenAlert, DispatchStatus } from '@guardia/shared';

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

/** Estados finales: la pantalla deja de consultar. */
export const FINAL: AlertStatus[] = ['RESOLVED', 'REJECTED', 'CANCELLED', 'UNROUTED'];
