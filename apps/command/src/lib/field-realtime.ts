'use client';

import { io, type Socket } from 'socket.io-client';
import { WS_NAMESPACES, type FieldAlarm, type FieldServerEvents } from '@guardia/shared';
import { getAccessToken, refreshAccessToken } from './api';
import { API_URL } from './config';

let socket: Socket<FieldServerEvents> | null = null;
let forceRefresh = false;

/**
 * Socket /field de la página /terreno (0012). No trae datos del caso: `field.refresh` hace que la página vuelva a
 * pedir su estado (GET /ops/field/state, contexto RLS `field`); `field.alarm` es la respuesta a su pánico.
 */
export function connectField(handlers: {
  onRefresh: () => void;
  onAlarm: (a: FieldAlarm) => void;
  onConnection: (online: boolean) => void;
}): () => void {
  socket?.close();
  const s: Socket<FieldServerEvents> = io(`${API_URL}${WS_NAMESPACES.field}`, {
    auth: (cb) => {
      const token = forceRefresh ? refreshAccessToken() : getAccessToken();
      forceRefresh = false;
      token.then(
        (t) => cb({ token: t ?? '' }),
        () => cb({ token: '' }),
      );
    },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket = s;
  s.on('connect', () => {
    handlers.onConnection(true);
    handlers.onRefresh();
  });
  s.on('disconnect', (reason) => {
    handlers.onConnection(false);
    // El servidor cerró (token vencido): reintento propio con token renovado.
    if (reason === 'io server disconnect') {
      forceRefresh = true;
      setTimeout(() => s.connect(), 3000);
    }
  });
  s.on('field.refresh', () => handlers.onRefresh());
  s.on('field.alarm', (a) => handlers.onAlarm(a));
  return () => {
    s.close();
    if (socket === s) socket = null;
  };
}
