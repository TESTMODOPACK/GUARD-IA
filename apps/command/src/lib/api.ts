import type {
  AlertDetail,
  AlertEvent,
  AlertStatus,
  AlertSummary,
  AlertType,
  ApiError,
  Dispatch,
  DispatchStatus,
  OperatorPublic,
  RejectReason,
  SignedUrl,
  TokenPair,
  Unit,
  UnitStatus,
} from '@guardia/shared';
import { API_BASE } from './config';
import { clearSession, loadSession, reloadSession, saveSession } from './session';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<string | null> | null = null;

/**
 * Serializa el refresh entre pestañas. El refresh es de un solo uso: si dos pestañas gastan
 * el mismo, la API lo toma como robo y revoca todas las sesiones del operador.
 */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return navigator.locks.request('guardia.refresh', fn) as Promise<T>;
  }
  return fn();
}

/**
 * Renueva el access token una sola vez aunque varias llamadas fallen a la vez.
 * Solo un rechazo del refresh (4xx) cierra la sesión; una caída de la API o de la red no.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing;
  const spent = loadSession()?.refreshToken;
  refreshing = withRefreshLock(async () => {
    const s = reloadSession();
    if (!s) return null;
    // Otra pestaña rotó mientras esperábamos el lock: usar su par en vez de gastar el viejo.
    if (s.refreshToken !== spent && Date.now() < s.accessExpiresAt) return s.accessToken;
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      clearSession();
      return null;
    }
    if (!res.ok) throw new ApiRequestError(res.status, 'INTERNAL', `No se pudo renovar la sesión (HTTP ${res.status})`);
    const pair = (await res.json()) as TokenPair;
    return saveSession(pair).accessToken;
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function getAccessToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (Date.now() < s.accessExpiresAt) return s.accessToken;
  return refreshAccessToken();
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401 && retry) {
    const fresh = await refreshAccessToken();
    if (fresh) return request<T>(path, init, false);
  }
  const text = await res.text();
  // Un 502 del proxy trae HTML: no confundirlo con un error de la app.
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiRequestError(res.status, 'INTERNAL', 'Respuesta inválida de la API');
  }
  if (!res.ok) {
    const err = (body ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(res.status, err.code ?? 'INTERNAL', err.message ?? `HTTP ${res.status}`, err.details);
  }
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  login: (email: string, password: string) =>
    request<TokenPair & { operator: OperatorPublic }>('/ops/auth/login', { method: 'POST', body: json({ email, password }) }, false),

  alerts: (params: { statuses?: AlertStatus[]; type?: AlertType; limit?: number; cursor?: string }) => {
    const q = new URLSearchParams();
    params.statuses?.forEach((s) => q.append('status', s));
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.cursor) q.set('cursor', params.cursor);
    return request<{ items: AlertSummary[]; nextCursor: string | null }>(`/ops/alerts?${q.toString()}`);
  },
  alert: (id: string) => request<AlertDetail>(`/ops/alerts/${id}`),
  ack: (id: string) => request<AlertDetail>(`/ops/alerts/${id}/ack`, { method: 'POST' }),
  reject: (id: string, reason: RejectReason, notes?: string) =>
    request<AlertDetail>(`/ops/alerts/${id}/reject`, { method: 'POST', body: json({ reason, notes }) }),
  dispatch: (id: string, unitId: string, notes?: string) =>
    request<Dispatch>(`/ops/alerts/${id}/dispatch`, { method: 'POST', body: json({ unitId, notes }) }),
  resolve: (id: string, notes?: string) =>
    request<AlertDetail>(`/ops/alerts/${id}/resolve`, { method: 'POST', body: json({ notes }) }),
  note: (id: string, text: string) => request<AlertEvent>(`/ops/alerts/${id}/notes`, { method: 'POST', body: json({ text }) }),
  updateDispatch: (id: string, status: DispatchStatus, notes?: string) =>
    request<Dispatch>(`/ops/dispatches/${id}`, { method: 'PATCH', body: json({ status, notes }) }),

  units: () => request<Unit[]>('/ops/units'),
  updateUnit: (id: string, status: UnitStatus) => request<Unit>(`/ops/units/${id}`, { method: 'PATCH', body: json({ status }) }),
  mediaUrl: (mediaId: string) => request<SignedUrl>(`/ops/media/${mediaId}/url`),
};

/** Todas las alertas con esos estados siguiendo el cursor (la API entrega 100 por página). Tope: 10 páginas. */
export async function fetchAllAlerts(statuses: AlertStatus[], maxPages = 10): Promise<AlertSummary[]> {
  const items: AlertSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await api.alerts({ statuses, limit: 100, cursor });
    items.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return items;
}
