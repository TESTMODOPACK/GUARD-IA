'use client';

import { io, type Socket } from 'socket.io-client';
import type { AlertDetail, AlertSummary, Dispatch, Unit } from '@guardia/shared';
import { WS_NAMESPACES } from '@guardia/shared';
import { api, fetchAllAlerts, getAccessToken, refreshAccessToken } from './api';
import { API_URL } from './config';
import { ACTIVE_STATUSES, useStore, type AnyAlert } from './store';
import { ping } from './sound';

let socket: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let resyncTimer: ReturnType<typeof setTimeout> | undefined;
/** El servidor rechazó el token: el próximo intento renueva antes de conectar. */
let forceRefresh = false;
/** Cierres seguidos hechos por el servidor; define la espera del reintento manual. */
let serverDrops = 0;
/** Invalida cargas en vuelo de una conexión anterior. */
let resyncSeq = 0;

/** SOS pendientes que la central todavía no conocía. */
function unseenPendingSos(list: AnyAlert[]): string[] {
  const known = useStore.getState().alerts;
  return list.filter((a) => !(a.id in known) && a.type === 'EMERGENCY_SOS' && a.status === 'PENDING').map((a) => a.id);
}

/** Incorpora alertas al store. Con `announce`, los SOS nuevos se resaltan y suenan una vez. */
function ingest(list: AnyAlert[], announce: boolean) {
  const s = useStore.getState();
  const fresh = announce ? unseenPendingSos(list) : [];
  s.upsertMany(list, fresh);
  for (const a of list) s.touchEvent(a.updatedAt);
  if (fresh.length > 0 && s.prefs.sound) ping('sos');
}

/**
 * Al conectar y en cada reconexión: alertas activas (todas las páginas) y unidades por REST.
 * Cubre el hueco entre la carga y el socket, y lo que el `sync` no trae (unidades, despachos).
 * Si falla, reintenta cada 5 s mientras el socket siga vivo.
 */
async function resync() {
  clearTimeout(resyncTimer);
  const seq = ++resyncSeq;
  try {
    const [active, units] = await Promise.all([fetchAllAlerts(ACTIVE_STATUSES), api.units()]);
    if (seq !== resyncSeq || !socket) return;
    const s = useStore.getState();
    ingest(active, s.loaded);
    s.setUnits(units);
    s.setLoaded(true);
  } catch (e) {
    if (seq !== resyncSeq || !socket) return;
    useStore.getState().notify('error', `No se pudo cargar la central: ${(e as Error).message}. Reintentando…`);
    resyncTimer = setTimeout(() => void resync(), 5000);
  }
}

/** Cuando el servidor cierra la conexión, socket.io no reintenta solo: lo hacemos con espera creciente. */
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30_000, 1000 * 2 ** serverDrops++);
  reconnectTimer = setTimeout(() => {
    useStore.getState().setConnection('connecting');
    socket?.connect();
  }, delay);
}

/**
 * Conexión única al namespace /ops. En cada intento manda token y `since` (último evento visto)
 * frescos; la API responde `sync` con lo ocurrido mientras tanto.
 */
export function connectRealtime(): void {
  if (socket) return;

  socket = io(`${API_URL}${WS_NAMESPACES.ops}`, {
    // Función y no objeto: socket.io la evalúa en cada intento y espera el token renovado.
    auth: (cb) => {
      const since = useStore.getState().lastEventAt ?? undefined;
      const token = forceRefresh ? refreshAccessToken() : getAccessToken();
      forceRefresh = false;
      token.then(
        (t) => cb({ token: t ?? '', since }),
        () => cb({ token: '', since }),
      );
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  socket.on('connect', () => {
    serverDrops = 0;
    useStore.getState().setConnection('online');
    void resync();
  });
  socket.on('disconnect', (reason) => {
    useStore.getState().setConnection('offline');
    if (reason === 'io server disconnect') scheduleReconnect();
  });
  socket.io.on('reconnect_attempt', () => useStore.getState().setConnection('connecting'));
  socket.on('error', (e: { code?: string }) => {
    if (e?.code === 'UNAUTHORIZED') forceRefresh = true;
  });

  socket.on('alert.created', (a: AlertSummary) => {
    const s = useStore.getState();
    s.upsertAlert(a, { fresh: true });
    s.touchEvent(a.updatedAt);
    if (s.prefs.sound && a.type === 'EMERGENCY_SOS') ping('sos');
  });
  socket.on('alert.updated', (a: AlertDetail) => {
    const s = useStore.getState();
    const prev = s.alerts[a.id];
    s.upsertAlert(a);
    s.touchEvent(a.updatedAt);
    // Primer HIGH confirmado por la IA: segundo aviso corto.
    if (s.prefs.sound && a.priority === 'HIGH' && prev?.priority !== 'HIGH' && a.status === 'PENDING') ping('high');
  });
  socket.on('dispatch.updated', (d: Dispatch) => {
    const s = useStore.getState();
    s.applyDispatch(d);
    s.touchEvent(d.updatedAt);
  });
  socket.on('unit.updated', (u: Unit) => useStore.getState().upsertUnit(u));
  socket.on('sync', (p: { since: string; alerts: AlertSummary[] }) => ingest(p.alerts, true));
}

export function disconnectRealtime() {
  clearTimeout(reconnectTimer);
  clearTimeout(resyncTimer);
  resyncSeq++;
  socket?.close();
  socket = null;
}
