import { io, type Socket } from 'socket.io-client';
import { WS_NAMESPACES, type CitizenAlert, type CitizenServerEvents } from '@guardia/shared';
import { accessToken, refreshAccess, syncAccount } from './api';
import { API_URL } from './config';

type Listener = (a: CitizenAlert) => void;

let socket: Socket<CitizenServerEvents> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let forceRefresh = false;
let serverDrops = 0;
const listeners = new Set<Listener>();
const connListeners = new Set<(online: boolean) => void>();
const accountListeners = new Set<() => void>();

/**
 * Canal /citizen: la API emite `alert.status` a la room del vecino en cada cambio de sus alertas.
 * Mismo patrón que la central: token pedido en cada intento (auth como función) y reintento propio
 * cuando el servidor cierra la conexión (token rechazado), porque socket.io no reintenta solo.
 */
export function connectCitizen(): void {
  if (socket) return;
  socket = io(`${API_URL}${WS_NAMESPACES.citizen}`, {
    transports: ['websocket'],
    auth: (cb) => {
      const token = forceRefresh ? refreshAccess() : accessToken();
      forceRefresh = false;
      token.then(
        (t) => cb({ token: t ?? '' }),
        () => cb({ token: '' }),
      );
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  socket.on('connect', () => {
    serverDrops = 0;
    connListeners.forEach((l) => l(true));
  });
  socket.on('disconnect', (reason) => {
    connListeners.forEach((l) => l(false));
    if (reason === 'io server disconnect') scheduleReconnect();
  });
  (socket as unknown as Socket).on('error', (e: { code?: string }) => {
    if (e?.code === 'UNAUTHORIZED') forceRefresh = true;
  });
  socket.on('alert.status', (a) => listeners.forEach((l) => l(a)));
  // Bloqueo, desbloqueo, falta anulada o revisión resuelta (0011): se relee la cuenta.
  socket.on('account.updated', () => {
    void syncAccount();
    accountListeners.forEach((l) => l());
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(30_000, 1000 * 2 ** serverDrops++);
  reconnectTimer = setTimeout(() => socket?.connect(), delay);
}

export function disconnectCitizen(): void {
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
  connListeners.forEach((l) => l(false));
}

/** Suscribirse a los cambios de estado de las alertas propias. Devuelve la función para salir. */
export function onAlertStatus(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Avisa cuando la central cambia algo de la cuenta (para releer "Estado de tu cuenta"). */
export function onAccountUpdated(l: () => void): () => void {
  accountListeners.add(l);
  return () => {
    accountListeners.delete(l);
  };
}

export function onConnection(l: (online: boolean) => void): () => void {
  connListeners.add(l);
  l(!!socket?.connected);
  return () => {
    connListeners.delete(l);
  };
}
