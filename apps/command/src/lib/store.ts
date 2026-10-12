'use client';

import { create } from 'zustand';
import type { AlertDetail, AlertStatus, AlertSummary, AlertType, Dispatch, Unit } from '@guardia/shared';
import { PREFS_KEY } from './config';

export const ACTIVE_STATUSES: AlertStatus[] = ['PENDING', 'ACKNOWLEDGED', 'DISPATCHED'];
export const CLOSED_STATUSES: AlertStatus[] = ['RESOLVED', 'REJECTED', 'CANCELLED'];

export type TypeFilter = 'ALL' | AlertType;
export type Connection = 'connecting' | 'online' | 'offline';
export type AnyAlert = AlertSummary | AlertDetail;

export function isDetail(a: AnyAlert): a is AlertDetail {
  return 'events' in a;
}

interface Prefs {
  sound: boolean;
}

interface State {
  alerts: Record<string, AnyAlert>;
  units: Record<string, Unit>;
  selectedId: string | null;
  typeFilter: TypeFilter;
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
  setUnits: (list: Unit[]) => void;
  upsertUnit: (u: Unit) => void;
  select: (id: string | null) => void;
  setTypeFilter: (f: TypeFilter) => void;
  setShowClosed: (v: boolean) => void;
  touchEvent: (iso: string) => void;
  clearFresh: (id: string) => void;
  setSound: (v: boolean) => void;
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
  if (typeof window === 'undefined') return { sound: true };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? { sound: true, ...(JSON.parse(raw) as Partial<Prefs>) } : { sound: true };
  } catch {
    return { sound: true };
  }
}

export const useStore = create<State>((set, get) => ({
  alerts: {},
  units: {},
  selectedId: null,
  typeFilter: 'ALL',
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
      return { alerts: { ...s.alerts, [a.id]: mergeAlert(s.alerts[a.id], a) }, fresh };
    }),

  upsertMany: (list, freshIds) =>
    set((s) => {
      const alerts = { ...s.alerts };
      for (const a of list) alerts[a.id] = mergeAlert(alerts[a.id], a);
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

  setUnits: (list) => set({ units: Object.fromEntries(list.map((u) => [u.id, u])) }),
  upsertUnit: (u) => set((s) => ({ units: { ...s.units, [u.id]: u } })),

  select: (selectedId) => set({ selectedId }),
  setTypeFilter: (typeFilter) => set({ typeFilter }),
  setShowClosed: (showClosed) => set({ showClosed }),
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
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    set({ prefs });
  },
  notify: (kind, text) => set({ toast: { kind, text, at: Date.now() } }),
  clearToast: () => set({ toast: null }),
}));

/** Orden de la cola: prioridad (HIGH, sin clasificar, MEDIUM, LOW), luego antigüedad. */
const RANK: Record<string, number> = { HIGH: 0, NONE: 1, MEDIUM: 2, LOW: 3 };

export function queueOrder(a: AnyAlert, b: AnyAlert): number {
  const ra = RANK[a.priority ?? 'NONE'];
  const rb = RANK[b.priority ?? 'NONE'];
  if (ra !== rb) return ra - rb;
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export function selectVisibleAlerts(s: Pick<State, 'alerts' | 'typeFilter' | 'showClosed'>): AnyAlert[] {
  const wanted = s.showClosed ? CLOSED_STATUSES : ACTIVE_STATUSES;
  return Object.values(s.alerts)
    .filter((a) => wanted.includes(a.status))
    .filter((a) => s.typeFilter === 'ALL' || a.type === s.typeFilter)
    .sort(s.showClosed ? (a, b) => (a.updatedAt < b.updatedAt ? 1 : -1) : queueOrder);
}
