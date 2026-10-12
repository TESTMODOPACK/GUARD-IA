import { useSyncExternalStore } from 'react';
import { CONSENT_VERSION, type CitizenPublic, type TokenPair } from '@guardia/shared';
import { deleteItem, getItem, setItem } from './storage';

const KEY = 'guardia.session';

export interface Session extends TokenPair {
  citizen: CitizenPublic;
  /** Epoch ms en que vence el access token (expiresIn menos un margen de 60 s). */
  accessExpiresAt: number;
}

type Snapshot = { ready: boolean; session: Session | null };

let snapshot: Snapshot = { ready: false, session: null };
const listeners = new Set<() => void>();

function publish(session: Session | null) {
  snapshot = { ready: true, session };
  listeners.forEach((l) => l());
}

/** Carga la sesión guardada al abrir la app. */
export async function initSession(): Promise<void> {
  let session: Session | null = null;
  try {
    const raw = await getItem(KEY);
    session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    session = null;
  }
  publish(session);
}

export function getSession(): Session | null {
  return snapshot.session;
}

/** Guarda un par nuevo (login o refresh). El vecino se conserva si el par no lo trae. */
export async function saveTokens(pair: TokenPair, citizen?: CitizenPublic): Promise<Session> {
  const who = citizen ?? snapshot.session?.citizen;
  if (!who) throw new Error('Sesión sin vecino');
  const session: Session = {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: pair.expiresIn,
    accessExpiresAt: Date.now() + (pair.expiresIn - 60) * 1000,
    citizen: who,
  };
  await setItem(KEY, JSON.stringify(session));
  publish(session);
  return session;
}

export async function updateCitizen(citizen: CitizenPublic): Promise<void> {
  const s = snapshot.session;
  if (!s) return;
  const next = { ...s, citizen };
  await setItem(KEY, JSON.stringify(next));
  publish(next);
}

export async function clearSession(): Promise<void> {
  await deleteItem(KEY);
  publish(null);
}

/** Consentimiento versionado: si cambia CONSENT_VERSION, se vuelve a pedir. */
export function hasCurrentConsent(s: Session | null): boolean {
  return s?.citizen.consentVersion === CONSENT_VERSION;
}

export function useSession(): Snapshot {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}
