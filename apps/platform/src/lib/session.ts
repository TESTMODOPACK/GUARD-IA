import type { PlatformSession, PlatformUserPublic } from '@guardia/shared';
import { SESSION_KEY } from './config';

/**
 * Sesión de la consola. A diferencia de la central (localStorage, turnos de 12 h), aquí vive en
 * sessionStorage: cerrar la pestaña cierra la sesión y otra pestaña pide ingresar de nuevo. Quien entra ve
 * todos los municipios, así que se prefiere ingresar más veces a dejar una sesión abierta.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  user: PlatformUserPublic;
  /** Epoch ms en que vence el access token (expiresIn - margen). */
  accessExpiresAt: number;
}

type Listener = (s: Session | null) => void;
const listeners = new Set<Listener>();
let cached: Session | null | undefined;

function readStorage(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function loadSession(): Session | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined') return null;
  cached = readStorage();
  return cached;
}

function store(s: Session) {
  cached = s;
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // Almacenamiento bloqueado: la sesión dura lo que la página abierta.
  }
  listeners.forEach((l) => l(s));
}

export function saveSession(p: { accessToken: string; refreshToken: string; expiresIn: number; user?: PlatformUserPublic }): Session {
  const user = p.user ?? loadSession()?.user;
  if (!user) throw new Error('Sesión sin usuario');
  const s: Session = {
    accessToken: p.accessToken,
    refreshToken: p.refreshToken,
    user,
    accessExpiresAt: Date.now() + (p.expiresIn - 30) * 1000,
  };
  store(s);
  return s;
}

export function updateUser(user: PlatformUserPublic) {
  const s = loadSession();
  if (s) store({ ...s, user });
}

export function clearSession() {
  cached = null;
  try {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // nada que borrar
  }
  listeners.forEach((l) => l(null));
}

export function onSessionChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export type { PlatformSession };
