'use client';

import { io, type Socket } from 'socket.io-client';
import type { AlertDetail, AlertSummary, Dispatch, ImportanceLevel, Unit } from '@guardia/shared';
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

/** Se sumó a una situación que ya estaba en la cola (no la abrió). */
const joinedExisting = (a: AnyAlert) => !!a.incident && a.incident.primaryAlertId !== a.id;
const LEVEL_RANK: Record<ImportanceLevel, number> = { BAJA: 0, MEDIA: 1, ALTA: 2, CRITICA: 3 };

/** SOS pendientes que la central todavía no conocía y que abren una situación nueva. */
function unseenPendingSos(list: AnyAlert[]): string[] {
  const known = useStore.getState().alerts;
  return list
    .filter((a) => !(a.id in known) && a.type === 'EMERGENCY_SOS' && a.status === 'PENDING' && !joinedExisting(a))
    .map((a) => a.id);
}

/**
 * Avisos sonoros sin saturar: un SOS nuevo suena fuerte; otro vecino que reporta el mismo SOS, un
 * tono corto; un reporte urbano solo suena cuando su situación llega a importancia alta o crítica.
 * Los reportes repetidos de un problema conocido no suenan.
 */
function announceCreated(a: AlertSummary, before: ImportanceLevel | undefined) {
  const s = useStore.getState();
  const joined = joinedExisting(a);
  if (a.type === 'EMERGENCY_SOS') {
    if (!joined) {
      if (s.prefs.sound) ping('sos');
      return;
    }
    if (s.prefs.sound) ping('high');
    s.notify('ok', `Otro vecino reporta el mismo SOS (${a.incident!.citizenCount} vecinos)`);
    return;
  }
  const level = a.incident?.level;
  if (!level || LEVEL_RANK[level] < LEVEL_RANK.ALTA) return;
  if (before && LEVEL_RANK[before] >= LEVEL_RANK[level]) return; // ya se avisó en este nivel
  if (s.prefs.sound) ping('high');
  s.notify('ok', joined ? `Reporte repetido: la situación subió a importancia ${level === 'CRITICA' ? 'crítica' : 'alta'}` : 'Reporte urbano de importancia alta');
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
    const before = a.incident ? Object.values(s.alerts).find((x) => x.incident?.id === a.incident!.id)?.incident?.level : undefined;
    s.upsertAlert(a, { fresh: !joinedExisting(a) });
    s.touchEvent(a.updatedAt);
    announceCreated(a, before);
  });
  socket.on('alert.updated', (a: AlertDetail) => {
    const s = useStore.getState();
    const prev = s.alerts[a.id];
    s.upsertAlert(a);
    s.touchEvent(a.updatedAt);
    // Primer HIGH confirmado por la IA en una situación nueva: segundo aviso corto.
    if (s.prefs.sound && a.priority === 'HIGH' && prev?.priority !== 'HIGH' && a.status === 'PENDING' && !joinedExisting(a)) ping('high');
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
