import Constants from 'expo-constants';
import { API_PREFIX } from '@guardia/shared';

/**
 * URL de la API. Manda EXPO_PUBLIC_API_URL (apps/mobile/.env); si no está, se usa la IP del PC que
 * sirve Metro (la misma red wifi que el teléfono) con el puerto 3000. Nunca `localhost`: en el
 * teléfono, localhost es el propio teléfono.
 */
function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host ?? 'localhost'}:3000`;
}

export const API_URL = resolveApiUrl();
export const API_BASE = `${API_URL}/${API_PREFIX}`;
