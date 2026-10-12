import type { ApiError as ApiErrorBody, CitizenPublic, DeviceUpsert, TokenPair } from '@guardia/shared';
import { API_BASE } from './config';
import { clearSession, getSession, saveTokens } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
const OFFLINE = 'No pudimos conectar con Guard-IA. Revisa tu conexión a internet.';

let refreshing: Promise<string | null> | null = null;

/**
 * Renueva el access token una sola vez aunque varias llamadas fallen a la vez.
 * Solo un rechazo del refresh (4xx salvo 429) cierra la sesión; sin red o con la API caída, no.
 */
async function refreshAccess(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const s = getSession();
    if (!s) return null;
    const res = await send('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      await clearSession();
      return null;
    }
    if (!res.ok) throw new ApiError(res.status, 'INTERNAL', 'No se pudo renovar la sesión');
    return (await saveTokens((await res.json()) as TokenPair)).accessToken;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function accessToken(): Promise<string | null> {
  const s = getSession();
  if (!s) return null;
  return Date.now() < s.accessExpiresAt ? s.accessToken : refreshAccess();
}

async function send(path: string, init: RequestInit, token?: string | null): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) }, signal: ctrl.signal });
  } catch {
    throw new ApiError(0, 'NETWORK', OFFLINE);
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init: RequestInit = {}, opts: { auth?: boolean; retry?: boolean } = {}): Promise<T> {
  const { auth = true, retry = true } = opts;
  const token = auth ? await accessToken() : null;
  const res = await send(path, init, token);
  if (res.status === 401 && auth && retry) {
    const fresh = await refreshAccess();
    if (fresh) return request<T>(path, init, { auth, retry: false });
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.code ?? 'INTERNAL', err.message ?? `Error del servidor (${res.status})`);
  }
  return body as T;
}

const json = (b: unknown) => JSON.stringify(b);

export const api = {
  requestOtp: (phone: string) => request<null>('/auth/otp/request', { method: 'POST', body: json({ phone }) }, { auth: false }),
  verifyOtp: (phone: string, code: string) =>
    request<TokenPair & { citizen: CitizenPublic }>('/auth/otp/verify', { method: 'POST', body: json({ phone, code }) }, { auth: false }),
  me: () => request<CitizenPublic>('/me'),
  consent: (version: string) => request<null>('/me/consent', { method: 'POST', body: json({ version }) }),
  upsertDevice: (d: DeviceUpsert) => request<null>('/me/devices', { method: 'PUT', body: json(d) }),
};

/** Cierra la sesión aquí y en la API (revoca el refresh). Sin red, igual se cierra localmente. */
export async function logout(): Promise<void> {
  const s = getSession();
  await clearSession();
  if (!s) return;
  try {
    await send('/auth/logout', { method: 'POST', body: json({ refreshToken: s.refreshToken }) });
  } catch {
    // Sin red: el refresh vence solo.
  }
}

/** Mensaje para mostrar al vecino. Los mensajes de la API ya vienen en español. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return OFFLINE;
}
