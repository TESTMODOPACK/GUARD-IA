import type { AlertDetail, AlertSummary, CitizenAlert, Dispatch } from './schemas/alert';
import type { Unit } from './schemas/ops';
import type { FieldAlarm } from './schemas/field';
import type { AccountLevel } from './enums';

/** Namespaces de Socket.io. El JWT viaja en `handshake.auth.token`. */
export const WS_NAMESPACES = {
  ops: '/ops',
  citizen: '/citizen',
  /** Funcionarios de terreno (0012): nunca reciben la cola de la central, solo lo de su unidad. */
  field: '/field',
} as const;

export const wsRooms = {
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  citizen: (citizenId: string) => `citizen:${citizenId}`,
  /** Sockets /field de quienes salieron con la unidad (el servidor los mueve al iniciar o terminar turno). */
  unit: (unitId: string) => `unit:${unitId}`,
  operator: (operatorId: string) => `operator:${operatorId}`,
};

/** Eventos servidor → central (namespace /ops, room tenant:{id}). */
export interface OpsServerEvents {
  'alert.created': (alert: AlertSummary) => void;
  'alert.updated': (alert: AlertDetail) => void;
  'dispatch.updated': (dispatch: Dispatch) => void;
  'unit.updated': (unit: Unit) => void;
  /** La alerta pasó a otro municipio: la central de origen la saca de su cola (migración 0006). */
  'alert.transferred': (payload: AlertTransferred) => void;
  /** Respuesta al `since` del handshake: alertas tocadas desde esa fecha. */
  sync: (payload: { since: string; alerts: AlertSummary[] }) => void;
  /** Aviso de terreno nuevo o cerrado (0012): pánico, apoyo, plazo vencido. */
  'field.alarm': (alarm: FieldAlarm) => void;
}

/**
 * Eventos servidor → funcionario de terreno (namespace /field, rooms unit:{id} y operator:{id}). `field.refresh`
 * no trae datos del caso: la página vuelve a pedir GET /ops/field/state, que lee con el contexto RLS `field`.
 */
export interface FieldServerEvents {
  'field.refresh': (payload: { reason: 'dispatch' | 'shift' }) => void;
  /** Su pánico fue atendido en la central. */
  'field.alarm': (alarm: FieldAlarm) => void;
}

export interface AlertTransferred {
  alertId: string;
  toTenantId: string;
  toTenantName: string;
  /** true: lo decidió el agente; false: un operador. */
  auto: boolean;
  reason: string;
}

/** Eventos servidor → vecino (namespace /citizen, room citizen:{id}). */
export interface CitizenServerEvents {
  'alert.status': (payload: CitizenAlert) => void;
  /** Cambió el estado de la cuenta (bloqueo, falta anulada, revisión resuelta; 0011): la app relee GET /me. */
  'account.updated': (payload: { level: AccountLevel }) => void;
}

export type OpsEventName = keyof OpsServerEvents;
export type CitizenEventName = keyof CitizenServerEvents;
export type FieldEventName = keyof FieldServerEvents;

/** Datos opcionales del handshake. */
export interface WsHandshakeAuth {
  token: string;
  /** ISO 8601: pide un `sync` con lo ocurrido desde esa fecha. */
  since?: string;
}
