import type { OperatorPublic, TokenPair } from '@guardia/shared';
import { SESSION_KEY } from './config';

export interface Session extends TokenPair {
  operator: OperatorPublic;
  /** Epoch ms en que vence el access token (expiresIn - margen). */
  accessExpiresAt: number;
}

type Listener = (s: Session | null) => void;
const listeners = new Set<Listener>();
let cached: Session | null | undefined;
let watching = false;

function readStorage(): Session | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

/** Otra pestaña rotó los tokens o cerró sesión: adoptar su valor para no gastar un refresh viejo. */
function watchOtherTabs() {
  if (watching) return;
  watching = true;
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY && e.key !== null) return;
    cached = readStorage();
    listeners.forEach((l) => l(cached ?? null));
  });
}

export function loadSession(): Session | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined') return null;
  watchOtherTabs();
  cached = readStorage();
  return cached;
}

/** Relee el almacenamiento sin caché. El refresh la usa dentro del lock entre pestañas. */
export function reloadSession(): Session | null {
  cached = undefined;
  return loadSession();
}

export function saveSession(pair: TokenPair & { operator?: OperatorPublic }): Session {
  const prev = loadSession();
  const operator = pair.operator ?? prev?.operator;
  if (!operator) throw new Error('Sesión sin operador');
  const s: Session = {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: pair.expiresIn,
    operator,
    accessExpiresAt: Date.now() + (pair.expiresIn - 60) * 1000,
  };
  cached = s;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  listeners.forEach((l) => l(s));
  return s;
}

/** Reemplaza los datos del operador (p. ej. tras cambiar la contraseña temporal) sin tocar los tokens. */
export function updateOperator(operator: OperatorPublic) {
  const s = loadSession();
  if (!s) return;
  const next: Session = { ...s, operator };
  cached = next;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  listeners.forEach((l) => l(next));
}

export function clearSession() {
  cached = null;
  if (typeof window !== 'undefined') window.localStorage.removeItem(SESSION_KEY);
  listeners.forEach((l) => l(null));
}

export function onSessionChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
