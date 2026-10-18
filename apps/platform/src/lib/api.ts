import type {
  AuthorizeSubprocessor,
  CreateIncident,
  CreateSubprocessor,
  SecurityIncident,
  Subprocessor,
  SubprocessorAuthorization,
  UpdateIncident,
  UpdateSubprocessor,
  ApiError,
  ChangeTenantStatus,
  ComunaMap,
  ComunaRow,
  CreatePlatformUser,
  CreateTenant,
  CreateTenantAdmin,
  PlatformAuditPage,
  PlatformChangePassword,
  PlatformLoginStep,
  PlatformSession,
  PlatformUserAccount,
  PlatformUserPassword,
  PlatformUserPublic,
  RegionDetail,
  RegionSummary,
  TenantAdminPassword,
  TenantDetail,
  TenantListItem,
  TestPhone,
  TestPhoneInput,
  UpdatePlatformUser,
  UpdateTenant,
} from '@guardia/shared';
import { API_BASE } from './config';
import { clearSession, loadSession, saveSession } from './session';

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

/** Renueva el access token una sola vez aunque varias llamadas fallen a la vez. */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const s = loadSession();
    if (!s) return null;
    const res = await fetch(`${API_BASE}/platform/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      clearSession();
      return null;
    }
    if (!res.ok) throw new ApiRequestError(res.status, 'INTERNAL', `No se pudo renovar la sesión (HTTP ${res.status})`);
    const pair = (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
    return saveSession(pair).accessToken;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function getAccessToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (Date.now() < s.accessExpiresAt) return s.accessToken;
  return refreshAccessToken();
}

async function request<T>(path: string, init: RequestInit = {}, auth = true, retry = true): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (auth) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (init.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401 && auth && retry) {
    const fresh = await refreshAccessToken();
    if (fresh) return request<T>(path, init, auth, false);
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') window.location.replace('/login');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiRequestError(res.status, 'INTERNAL', 'Respuesta inválida de la API');
  }
  if (!res.ok) {
    const err = (body ?? {}) as Partial<ApiError>;
    if (err.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined' && window.location.pathname !== '/cambiar-clave') {
      window.location.replace('/cambiar-clave');
    }
    throw new ApiRequestError(res.status, err.code ?? 'INTERNAL', err.message ?? `HTTP ${res.status}`, err.details);
  }
  return res.status === 204 ? (null as T) : (body as T);
}

const json = (body: unknown) => JSON.stringify(body);

/** Cierra la sesión en la API y la borra aquí; sin red, igual se borra (el refresh vence solo). */
export async function logout(): Promise<void> {
  const s = loadSession();
  clearSession();
  if (!s) return;
  try {
    await fetch(`${API_BASE}/platform/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
      keepalive: true,
    });
  } catch {
    // Sin red: la sesión local ya se borró.
  }
}

export const api = {
  login: (email: string, password: string) =>
    request<PlatformLoginStep>('/platform/auth/login', { method: 'POST', body: json({ email, password }) }, false),
  totp: (challengeToken: string, code: string) =>
    request<PlatformSession>('/platform/auth/totp', { method: 'POST', body: json({ challengeToken, code }) }, false),
  me: () => request<PlatformUserPublic>('/platform/me'),
  changePassword: (body: PlatformChangePassword) =>
    request<PlatformUserPublic>('/platform/me/password', { method: 'POST', body: json(body) }),

  regions: () => request<RegionSummary[]>('/platform/regions'),
  region: (cut: number) => request<RegionDetail>(`/platform/regions/${cut}`),
  regionMap: (cut: number) => request<ComunaMap>(`/platform/regions/${cut}/map`),
  countryMap: () => request<ComunaMap>('/platform/map'),
  searchComunas: (q: string) => request<ComunaRow[]>(`/platform/comunas?q=${encodeURIComponent(q)}`),

  tenants: () => request<TenantListItem[]>('/platform/tenants'),
  tenant: (id: string) => request<TenantDetail>(`/platform/tenants/${id}`),
  createTenant: (body: CreateTenant) => request<TenantDetail>('/platform/tenants', { method: 'POST', body: json(body) }),
  updateTenant: (id: string, body: UpdateTenant) =>
    request<TenantDetail>(`/platform/tenants/${id}`, { method: 'PATCH', body: json(body) }),
  changeStatus: (id: string, body: ChangeTenantStatus) =>
    request<TenantDetail>(`/platform/tenants/${id}/status`, { method: 'POST', body: json(body) }),
  createAdmin: (id: string, body: CreateTenantAdmin) =>
    request<TenantAdminPassword>(`/platform/tenants/${id}/admins`, { method: 'POST', body: json(body) }),
  resetAdmin: (id: string, adminId: string) =>
    request<TenantAdminPassword>(`/platform/tenants/${id}/admins/${adminId}/reset`, { method: 'POST' }),
  addTestPhone: (id: string, body: TestPhoneInput) =>
    request<TestPhone>(`/platform/tenants/${id}/test-phones`, { method: 'POST', body: json(body) }),
  removeTestPhone: (id: string, phoneId: string) =>
    request<null>(`/platform/tenants/${id}/test-phones/${phoneId}`, { method: 'DELETE' }),

  // Ley 21.719 (0014): subencargados y su autorización por municipio, e incidentes de seguridad.
  subprocessors: () => request<Subprocessor[]>('/platform/subprocessors'),
  createSubprocessor: (body: CreateSubprocessor) =>
    request<Subprocessor[]>('/platform/subprocessors', { method: 'POST', body: json(body) }),
  updateSubprocessor: (id: string, body: UpdateSubprocessor) =>
    request<Subprocessor[]>(`/platform/subprocessors/${id}`, { method: 'PATCH', body: json(body) }),
  authorizeSubprocessor: (tenantId: string, body: AuthorizeSubprocessor) =>
    request<SubprocessorAuthorization[]>(`/platform/tenants/${tenantId}/subprocessors`, { method: 'POST', body: json(body) }),
  revokeSubprocessor: (tenantId: string, authorizationId: string) =>
    request<SubprocessorAuthorization[]>(`/platform/tenants/${tenantId}/subprocessors/${authorizationId}`, { method: 'DELETE' }),
  incidents: () => request<SecurityIncident[]>('/platform/incidents'),
  createIncident: (body: CreateIncident) => request<SecurityIncident>('/platform/incidents', { method: 'POST', body: json(body) }),
  updateIncident: (id: string, body: UpdateIncident) =>
    request<SecurityIncident>(`/platform/incidents/${id}`, { method: 'PATCH', body: json(body) }),
  notifyIncidentTenant: (id: string, tenantId: string) =>
    request<SecurityIncident>(`/platform/incidents/${id}/tenants`, { method: 'POST', body: json({ tenantId }) }),

  audit: (params: { tenantId?: string; cursor?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params.tenantId) q.set('tenantId', params.tenantId);
    if (params.cursor) q.set('cursor', params.cursor);
    if (params.limit) q.set('limit', String(params.limit));
    return request<PlatformAuditPage>(`/platform/audit?${q.toString()}`);
  },

  users: () => request<PlatformUserAccount[]>('/platform/users'),
  createUser: (body: CreatePlatformUser) =>
    request<PlatformUserPassword>('/platform/users', { method: 'POST', body: json(body) }),
  updateUser: (id: string, body: UpdatePlatformUser) =>
    request<PlatformUserAccount>(`/platform/users/${id}`, { method: 'PATCH', body: json(body) }),
  resetUser: (id: string) => request<PlatformUserPassword>(`/platform/users/${id}/reset`, { method: 'POST' }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof TypeError) return 'No se pudo conectar con la API';
  return (e as Error)?.message ?? 'Error inesperado';
}
