import type {
  AccountsOverview,
  DecideBlock,
  ResolveReview,
  ActivityPage,
  AdminOverview,
  AdminRange,
  CaseActivity,
  Contact,
  ContactInput,
  CreateOperator,
  CreateShift,
  OperatorAccount,
  Shift,
  ShiftStatus,
  SystemActivity,
  TemporaryPassword,
  UpdateContact,
  UpdateOperator,
  AlertCategory,
  AlertDetail,
  CitizenStanding,
  AlertEvent,
  AlertStatus,
  AlertSummary,
  AlertType,
  ApiError,
  Dispatch,
  DispatchStatus,
  OperatorPublic,
  RecordOutcome,
  RejectReason,
  SignedUrl,
  SuggestedAgency,
  TenantOption,
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

/**
 * Cierra la sesión en la API (revoca el refresh) y la borra localmente en todas las pestañas.
 * Si la API no responde, igual se cierra aquí: el refresh vence solo en 13 h.
 */
export async function logout(): Promise<void> {
  const s = loadSession();
  clearSession();
  if (!s) return;
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
      keepalive: true,
    });
  } catch {
    // Sin red: la sesión local ya se borró.
  }
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
    // Contraseña temporal pendiente: la API no deja operar hasta cambiarla.
    if (err.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined' && window.location.pathname !== '/cambiar-clave') {
      window.location.replace('/cambiar-clave');
    }
    throw new ApiRequestError(res.status, err.code ?? 'INTERNAL', err.message ?? `HTTP ${res.status}`, err.details);
  }
  return res.status === 204 ? (null as T) : (body as T);
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
  resolve: (id: string, notes?: string, includeGrouped = false) =>
    request<AlertDetail>(`/ops/alerts/${id}/resolve`, { method: 'POST', body: json({ notes, includeGrouped }) }),
  detach: (id: string) => request<AlertDetail>(`/ops/alerts/${id}/detach`, { method: 'POST' }),
  reanalyze: (id: string) => request<AlertDetail>(`/ops/alerts/${id}/reanalyze`, { method: 'POST' }),
  reclassify: (id: string, category: AlertCategory, subcategory: string | null) =>
    request<AlertDetail>(`/ops/alerts/${id}/classification`, { method: 'POST', body: json({ category, subcategory }) }),
  transfer: (id: string, tenantId: string, reason: string) =>
    request<{ toTenantName: string }>(`/ops/alerts/${id}/transfer`, { method: 'POST', body: json({ tenantId, reason }) }),
  tenants: () => request<TenantOption[]>('/ops/tenants'),
  citizenStanding: (alertId: string) => request<CitizenStanding>(`/ops/alerts/${alertId}/citizen-standing`),
  // Cuentas de vecinos (uso indebido, 0011): SUPERVISOR y ADMIN.
  accounts: () => request<AccountsOverview>('/ops/accounts'),
  decideBlock: (id: string, body: DecideBlock) =>
    request<AccountsOverview>(`/ops/blocks/${id}/decision`, { method: 'POST', body: json(body) }),
  liftBlock: (id: string, reason: string) =>
    request<AccountsOverview>(`/ops/blocks/${id}/lift`, { method: 'POST', body: json({ reason }) }),
  annulStrike: (id: string, reason: string) =>
    request<AccountsOverview>(`/ops/strikes/${id}/annul`, { method: 'POST', body: json({ reason }) }),
  resolveReview: (id: string, body: ResolveReview) =>
    request<AccountsOverview>(`/ops/reviews/${id}/resolve`, { method: 'POST', body: json(body) }),
  recordOutcome: (dispatchId: string, body: RecordOutcome) =>
    request<Dispatch>(`/ops/dispatches/${dispatchId}/outcome`, { method: 'POST', body: json(body) }),
  refer: (id: string, agencies: SuggestedAgency[], notes?: string) =>
    request<AlertDetail>(`/ops/alerts/${id}/referral`, { method: 'POST', body: json({ agencies, notes }) }),
  note: (id: string, text: string) => request<AlertEvent>(`/ops/alerts/${id}/notes`, { method: 'POST', body: json({ text }) }),
  updateDispatch: (id: string, status: DispatchStatus, notes?: string) =>
    request<Dispatch>(`/ops/dispatches/${id}`, { method: 'PATCH', body: json({ status, notes }) }),

  units: () => request<Unit[]>('/ops/units'),
  updateUnit: (id: string, status: UnitStatus) => request<Unit>(`/ops/units/${id}`, { method: 'PATCH', body: json({ status }) }),
  mediaUrl: (mediaId: string) => request<SignedUrl>(`/ops/media/${mediaId}/url`),

  // ---- administración (migración 0003)
  changePassword: (currentPassword: string, newPassword: string) =>
    request<OperatorPublic>('/ops/me/password', { method: 'POST', body: json({ currentPassword, newPassword }) }),
  operators: () => request<OperatorAccount[]>('/ops/operators'),
  createOperator: (body: CreateOperator) => request<TemporaryPassword>('/ops/operators', { method: 'POST', body: json(body) }),
  updateOperator: (id: string, body: UpdateOperator) =>
    request<OperatorAccount>(`/ops/operators/${id}`, { method: 'PATCH', body: json(body) }),
  resetPassword: (id: string) => request<TemporaryPassword>(`/ops/operators/${id}/reset-password`, { method: 'POST' }),

  shifts: (from: string, to: string) =>
    request<Shift[]>(`/ops/shifts?${new URLSearchParams({ from, to }).toString()}`),
  shiftStatus: () => request<ShiftStatus>('/ops/shifts/status'),
  startShift: () => request<Shift>('/ops/shifts/start', { method: 'POST' }),
  endShift: (handoverNote: string) => request<Shift>('/ops/shifts/end', { method: 'POST', body: json({ handoverNote }) }),
  planShift: (body: CreateShift) => request<Shift>('/ops/shifts', { method: 'POST', body: json(body) }),
  removeShift: (id: string) => request<null>(`/ops/shifts/${id}`, { method: 'DELETE' }),

  contacts: (includeInactive = false) => request<Contact[]>(`/ops/contacts${includeInactive ? '?includeInactive=true' : ''}`),
  createContact: (body: ContactInput) => request<Contact>('/ops/contacts', { method: 'POST', body: json(body) }),
  updateContact: (id: string, body: UpdateContact) => request<Contact>(`/ops/contacts/${id}`, { method: 'PATCH', body: json(body) }),
  removeContact: (id: string) => request<Contact>(`/ops/contacts/${id}`, { method: 'DELETE' }),

  overview: (range: AdminRange) => request<AdminOverview>(`/ops/admin/overview?range=${range}`),
  caseActivity: (cursor?: string) =>
    request<ActivityPage<CaseActivity>>(`/ops/admin/activity?source=cases&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  systemActivity: (cursor?: string) =>
    request<ActivityPage<SystemActivity>>(`/ops/admin/activity?source=system&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
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
