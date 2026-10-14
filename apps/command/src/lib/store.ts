'use client';

import { create } from 'zustand';
import {
  OPERATING_ROLES,
  type AlertDetail,
  type AlertStatus,
  type AlertSummary,
  type AlertType,
  type AreaRef,
  type Dispatch,
  type FieldAlarm,
  type OperatorPublic,
  type OperatorRole,
  type Unit,
} from '@guardia/shared';
import { PREFS_KEY } from './config';

export const ACTIVE_STATUSES: AlertStatus[] = ['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'];
export const CLOSED_STATUSES: AlertStatus[] = ['RESOLVED', 'REJECTED', 'CANCELLED'];

export type TypeFilter = 'ALL' | AlertType;
/** 'ALL' o el id de un área (0013). */
export type AreaFilter = 'ALL' | string;

/**
 * Quién mira la central y qué alcanza a ver (0013). La API y la RLS ya filtran: esto sirve para no dejar en la cola
 * una alerta que la cuenta dejó de ver (p. ej. tras pasarla a otra área) y para ocultar lo que su rol no puede hacer.
 */
export interface Viewer {
  role: OperatorRole;
  /** Puede tomar, despachar, cerrar, reclasificar, derivar… (el apoyo administrativo solo consulta y anota). */
  canOperate: boolean;
  seesAll: boolean;
  areaIds: string[];
  /** Pertenece al área que recibe los SOS: ve además los reportes con carácter de seguridad. */
  inSosArea: boolean;
}

export function viewerOf(op: OperatorPublic): Viewer {
  return {
    role: op.role,
    canOperate: (OPERATING_ROLES as readonly OperatorRole[]).includes(op.role),
    // Una sesión guardada antes de 0013 no trae áreas: ve todo hasta releer la cuenta al conectar.
    seesAll: op.seesAll ?? true,
    areaIds: (op.areas ?? []).map((a) => a.id),
    inSosArea: (op.areas ?? []).some((a) => a.receivesSos),
  };
}

/** Misma regla que las políticas de 0013: todo, sin área, de sus áreas o con carácter de seguridad si es del área de los SOS. */
export function viewerSees(v: Viewer | null, a: Pick<AlertSummary, 'area' | 'securityRelevant'>): boolean {
  if (!v || v.seesAll || !a.area) return true;
  return v.areaIds.includes(a.area.id) || (a.securityRelevant && v.inSosArea);
}
export type Connection = 'connecting' | 'online' | 'offline';
export type AnyAlert = AlertSummary | AlertDetail;

export function isDetail(a: AnyAlert): a is AlertDetail {
  return 'events' in a;
}

/**
 * Orden de la cola. Por defecto, de la más nueva a la más antigua (una situación sube cuando llega
 * un reporte nuevo de ella); también por importancia o por la que más espera. La cola nunca
 * oculta situaciones: la importancia se muestra, no filtra.
 */
export type SortMode = 'newest' | 'importance' | 'oldest';

interface Prefs {
  sound: boolean;
  sort: SortMode;
}

const DEFAULT_PREFS: Prefs = { sound: true, sort: 'newest' };
const SORT_MODES: SortMode[] = ['newest', 'importance', 'oldest'];

interface State {
  alerts: Record<string, AnyAlert>;
  units: Record<string, Unit>;
  /** Avisos de terreno abiertos (0012): pánico, apoyo, plazos vencidos. */
  fieldAlarms: Record<string, FieldAlarm>;
  selectedId: string | null;
  typeFilter: TypeFilter;
  areaFilter: AreaFilter;
  /** Áreas activas del municipio (nombres para la cola, la ficha y el filtro). */
  areaRefs: AreaRef[];
  viewer: Viewer | null;
  showClosed: boolean;
  connection: Connection;
  /** Marca del último evento WS recibido; se usa como `since` al reconectar. */
  lastEventAt: string | null;
  /** Ids con resaltado de "recién llegada" (se limpia solo). */
  fresh: Record<string, number>;
  prefs: Prefs;
  loaded: boolean;
  toast: { kind: 'ok' | 'error'; text: string; at: number } | null;

  setConnection: (c: Connection) => void;
  setLoaded: (v: boolean) => void;
  upsertAlert: (a: AnyAlert, opts?: { fresh?: boolean }) => void;
  upsertMany: (list: AnyAlert[], freshIds?: string[]) => void;
  applyDispatch: (d: Dispatch) => void;
  /** La alerta pasó a otro municipio o a un área que esta cuenta no ve: sale de la cola (ya no la puede leer). */
  removeAlert: (id: string) => void;
  setUnits: (list: Unit[]) => void;
  upsertUnit: (u: Unit) => void;
  setFieldAlarms: (list: FieldAlarm[]) => void;
  /** Uno cerrado sale de la lista. */
  upsertFieldAlarm: (a: FieldAlarm) => void;
  select: (id: string | null) => void;
  setTypeFilter: (f: TypeFilter) => void;
  setAreaFilter: (f: AreaFilter) => void;
  setAreaRefs: (list: AreaRef[]) => void;
  setViewer: (v: Viewer | null) => void;
  /** Cambió lo que ve la cuenta (sus áreas o el modo del municipio): se vacía la cola y se vuelve a cargar. */
  resetAlerts: () => void;
  setShowClosed: (v: boolean) => void;
  touchEvent: (iso: string) => void;
  clearFresh: (id: string) => void;
  setSound: (v: boolean) => void;
  setSort: (v: SortMode) => void;
  notify: (kind: 'ok' | 'error', text: string) => void;
  clearToast: () => void;
}

/**
 * Lo más nuevo gana (por `updatedAt`): una respuesta REST lenta no pisa un evento WS posterior.
 * Un resumen nunca borra la ficha completa; solo actualiza sus campos comunes.
 */
function mergeAlert(prev: AnyAlert | undefined, next: AnyAlert): AnyAlert {
  if (!prev) return next;
  if (next.updatedAt < prev.updatedAt) return isDetail(next) && !isDetail(prev) ? { ...next, ...prev } : prev;
  return isDetail(prev) && !isDetail(next) ? { ...prev, ...next } : next;
}

function loadPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return {
      sound: saved.sound ?? DEFAULT_PREFS.sound,
      sort: saved.sort && SORT_MODES.includes(saved.sort) ? saved.sort : DEFAULT_PREFS.sort,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: Prefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Sin almacenamiento (modo privado): la preferencia dura la sesión.
  }
}

/**
 * Todas las alertas de un mismo incidente comparten su resumen (conteos, importancia, cuál lo
 * representa). Cuando llega uno nuevo en cualquiera de ellas, se copia al resto: así la tarjeta del
 * grupo se actualiza aunque el evento haya sido de otra alerta del grupo.
 */
function spreadIncidents(alerts: Record<string, AnyAlert>, incoming: AnyAlert[]) {
  for (const a of incoming) {
    const inc = alerts[a.id]?.incident;
    if (!inc) continue;
    for (const [id, other] of Object.entries(alerts)) {
      if (id !== a.id && other.incident?.id === inc.id && other.incident !== inc) alerts[id] = { ...other, incident: inc };
    }
  }
}

export const useStore = create<State>((set, get) => ({
  alerts: {},
  units: {},
  fieldAlarms: {},
  selectedId: null,
  typeFilter: 'ALL',
  areaFilter: 'ALL',
  areaRefs: [],
  viewer: null,
  showClosed: false,
  connection: 'connecting',
  lastEventAt: null,
  fresh: {},
  prefs: loadPrefs(),
  loaded: false,
  toast: null,

  setConnection: (connection) => set({ connection }),
  setLoaded: (loaded) => set({ loaded }),

  upsertAlert: (a, opts) =>
    set((s) => {
      const fresh = opts?.fresh ? { ...s.fresh, [a.id]: Date.now() } : s.fresh;
      const alerts = { ...s.alerts, [a.id]: mergeAlert(s.alerts[a.id], a) };
      spreadIncidents(alerts, [a]);
      return { alerts, fresh };
    }),

  upsertMany: (list, freshIds) =>
    set((s) => {
      const alerts = { ...s.alerts };
      for (const a of list) alerts[a.id] = mergeAlert(alerts[a.id], a);
      spreadIncidents(alerts, list);
      if (!freshIds?.length) return { alerts };
      const fresh = { ...s.fresh };
      for (const id of freshIds) fresh[id] = Date.now();
      return { alerts, fresh };
    }),

  applyDispatch: (d) =>
    set((s) => {
      const a = s.alerts[d.alertId];
      if (!a || !isDetail(a)) return {};
      const others = a.dispatches.filter((x) => x.id !== d.id);
      return { alerts: { ...s.alerts, [a.id]: { ...a, dispatches: [d, ...others] } } };
    }),

  removeAlert: (id) =>
    set((s) => {
      if (!s.alerts[id]) return {};
      const alerts = { ...s.alerts };
      delete alerts[id];
      const fresh = { ...s.fresh };
      delete fresh[id];
      return { alerts, fresh, selectedId: s.selectedId === id ? null : s.selectedId };
    }),

  setUnits: (list) => set({ units: Object.fromEntries(list.map((u) => [u.id, u])) }),
  upsertUnit: (u) => set((s) => ({ units: { ...s.units, [u.id]: u } })),
  setFieldAlarms: (list) => set({ fieldAlarms: Object.fromEntries(list.filter((a) => !a.closedAt).map((a) => [a.id, a])) }),
  upsertFieldAlarm: (a) =>
    set((s) => {
      const next = { ...s.fieldAlarms };
      if (a.closedAt) delete next[a.id];
      else next[a.id] = a;
      return { fieldAlarms: next };
    }),

  select: (selectedId) => set({ selectedId }),
  setTypeFilter: (typeFilter) => set({ typeFilter }),
  setAreaFilter: (areaFilter) => set({ areaFilter }),
  // Un área que ya no existe (o se desactivó) no puede seguir filtrando la cola.
  setAreaRefs: (areaRefs) => set((s) => ({ areaRefs, areaFilter: areaRefs.some((a) => a.id === s.areaFilter) ? s.areaFilter : 'ALL' })),
  setViewer: (viewer) => set({ viewer }),
  resetAlerts: () => set({ alerts: {}, fresh: {}, selectedId: null, loaded: false }),
  // Al volver a "Activas" se sueltan las cerradas cargadas (salvo la abierta en el detalle), para que
  // un turno largo no acumule cientos de alertas en memoria; se recargan si se vuelve a "Cerradas".
  setShowClosed: (showClosed) =>
    set((s) => {
      if (showClosed) return { showClosed };
      const alerts: Record<string, AnyAlert> = {};
      for (const a of Object.values(s.alerts)) {
        if (!CLOSED_STATUSES.includes(a.status) || a.id === s.selectedId) alerts[a.id] = a;
      }
      return { showClosed, alerts };
    }),
  touchEvent: (iso) => set((s) => ({ lastEventAt: !s.lastEventAt || iso > s.lastEventAt ? iso : s.lastEventAt })),
  clearFresh: (id) =>
    set((s) => {
      if (!(id in s.fresh)) return {};
      const fresh = { ...s.fresh };
      delete fresh[id];
      return { fresh };
    }),
  setSound: (sound) => {
    const prefs = { ...get().prefs, sound };
    savePrefs(prefs);
    set({ prefs });
  },
  setSort: (sort) => {
    const prefs = { ...get().prefs, sort };
    savePrefs(prefs);
    set({ prefs });
  },
  notify: (kind, text) => set({ toast: { kind, text, at: Date.now() } }),
  clearToast: () => set({ toast: null }),
}));

/** Importancia de una alerta: la de su incidente; sin grupo todavía, una estimación por tipo y prioridad. */
export function importanceOf(a: AnyAlert): number {
  if (a.incident) return a.incident.importance;
  if (a.type === 'EMERGENCY_SOS') return a.priority === 'LOW' ? 55 : a.priority === 'MEDIUM' ? 70 : 75;
  return a.priority === 'HIGH' ? 35 : 20;
}

/** Último reporte de la situación (un grupo "sube" cuando alguien vuelve a reportar). */
export function lastReportAt(a: AnyAlert): string {
  const last = a.incident?.lastAlertAt;
  return last && last > a.createdAt ? last : a.createdAt;
}

const byOldest = (a: AnyAlert, b: AnyAlert) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

const ORDER: Record<SortMode, (a: AnyAlert, b: AnyAlert) => number> = {
  // SOS siempre antes que reportes urbanos; dentro de cada tipo, más importante primero y, a igual
  // importancia, la que más lleva esperando.
  importance: (a, b) =>
    (a.type === 'EMERGENCY_SOS' ? 0 : 1) - (b.type === 'EMERGENCY_SOS' ? 0 : 1) || importanceOf(b) - importanceOf(a) || byOldest(a, b),
  newest: (a, b) => (lastReportAt(a) < lastReportAt(b) ? 1 : lastReportAt(a) > lastReportAt(b) ? -1 : 0),
  oldest: byOldest,
};

/**
 * Una alerta por situación: la que representa a su incidente (la abierta más antigua). Si esa no
 * está entre las visibles (p. ej. ya cerrada), la más antigua del grupo que sí lo está.
 */
export function representatives(list: AnyAlert[]): AnyAlert[] {
  const byIncident = new Map<string, AnyAlert[]>();
  const out: AnyAlert[] = [];
  for (const a of list) {
    if (!a.incident) out.push(a);
    else byIncident.set(a.incident.id, [...(byIncident.get(a.incident.id) ?? []), a]);
  }
  for (const group of byIncident.values()) {
    const primaryId = group[0].incident!.primaryAlertId;
    out.push(group.find((a) => a.id === primaryId) ?? [...group].sort(byOldest)[0]);
  }
  return out;
}

export interface QueueView {
  items: AnyAlert[];
  /** Alertas individuales (antes de agrupar por situación). */
  reports: number;
}

/**
 * Filtro por área: las alertas de esa área y, si es la que recibe los SOS, también los reportes con carácter de
 * seguridad (los mismos que esa área ve sin filtro).
 */
function inArea(a: AnyAlert, f: AreaFilter, refs: AreaRef[]): boolean {
  if (f === 'ALL') return true;
  if (a.area?.id === f) return true;
  return a.securityRelevant && !!refs.find((r) => r.id === f)?.receivesSos;
}

export function selectQueue(s: Pick<State, 'alerts' | 'typeFilter' | 'areaFilter' | 'areaRefs' | 'showClosed' | 'prefs'>): QueueView {
  const wanted = s.showClosed ? CLOSED_STATUSES : ACTIVE_STATUSES;
  const matching = Object.values(s.alerts)
    .filter((a) => wanted.includes(a.status))
    .filter((a) => s.typeFilter === 'ALL' || a.type === s.typeFilter)
    .filter((a) => inArea(a, s.areaFilter, s.areaRefs));
  if (s.showClosed) {
    return { items: matching.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), reports: matching.length };
  }
  return { items: representatives(matching).sort(ORDER[s.prefs.sort]), reports: matching.length };
}
