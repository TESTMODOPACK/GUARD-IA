import type {
  ApiError as ApiErrorBody,
  CitizenAccountDetail,
  CitizenAlert,
  CitizenEraseResult,
  CitizenExport,
  CitizenPublic,
  Consent,
  CreateAlertMeta,
  CreateAlertResponse,
  CreateReview,
  DeviceUpsert,
  LegalNotice,
  TokenPair,
} from '@guardia/shared';
import { Platform } from 'react-native';
import { API_BASE } from './config';
import { clearSession, getSession, saveTokens, updateCitizen } from './session';

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
export async function refreshAccess(): Promise<string | null> {
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

export async function accessToken(): Promise<string | null> {
  const s = getSession();
  if (!s) return null;
  return Date.now() < s.accessExpiresAt ? s.accessToken : refreshAccess();
}

/** Lo que `request` necesita de una respuesta (fetch o XHR). */
type Reply = { status: number; ok: boolean; text(): Promise<string>; json(): Promise<unknown> };

const UPLOAD_TIMEOUT_MS = 45_000;

/**
 * Subida multipart en el teléfono. Expo (SDK 57) reemplaza el `fetch` global por expo/fetch, que no
 * acepta partes `{ uri, name, type }` ("Unsupported FormDataPart implementation"). El
 * XMLHttpRequest de React Native sí: lee el archivo desde el disco en el lado nativo, sin pasar los
 * bytes por JavaScript.
 */
function sendMultipartXhr(url: string, form: FormData, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.onload = () => {
      const body = xhr.responseText ?? '';
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        text: async () => body,
        json: async () => JSON.parse(body),
      });
    };
    xhr.onerror = () => reject(new Error('error de red al subir el archivo'));
    xhr.ontimeout = () => reject(new Error('tiempo de espera agotado al subir el archivo'));
    xhr.send(form);
  });
}

async function send(path: string, init: RequestInit, token?: string | null): Promise<Reply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    if (Platform.OS !== 'web' && init.body instanceof FormData) {
      clearTimeout(timer); // la subida tiene su propio tope, más largo
      return await sendMultipartXhr(`${API_BASE}${path}`, init.body, headers);
    }
    return await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) }, signal: ctrl.signal });
  } catch (e) {
    // En desarrollo se ve la causa real (sin red, timeout, archivo ilegible…) en la pantalla.
    const detail = __DEV__ ? ` [${ctrl.signal.aborted ? 'tiempo de espera agotado' : (e as Error)?.message ?? String(e)} · ${API_BASE}${path}]` : '';
    console.warn(`fetch ${path} falló:`, e);
    throw new ApiError(0, 'NETWORK', OFFLINE + detail);
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
  /** Solo desarrollo (la API lo expone con OTP_DEBUG_ENDPOINT=true; en producción responde 404). */
  devOtp: (phone: string) => request<{ hint: string }>(`/dev/otp/${encodeURIComponent(phone)}`, {}, { auth: false }),
  me: () => request<CitizenPublic>('/me'),
  /** Primera capa del aviso (0014): pública, con el proveedor que de verdad se usa y su hash. */
  legalNotice: () => request<LegalNotice>('/legal/notice', {}, { auth: false }),
  consent: (body: Consent) => request<null>('/me/consent', { method: 'POST', body: json(body) }),
  /** Oponerse al análisis con IA externa, o volver a aceptarlo (0014). */
  setExternalAi: (enabled: boolean) =>
    request<CitizenPublic>('/me/privacy/external-ai', { method: 'PUT', body: json({ enabled }) }),
  upsertDevice: (d: DeviceUpsert) => request<null>('/me/devices', { method: 'PUT', body: json(d) }),
  cancelAlert: (id: string) => request<CitizenAlert>(`/alerts/${id}/cancel`, { method: 'POST' }),
  alert: (id: string) => request<CitizenAlert>(`/alerts/${id}`),
  mine: () => request<CitizenAlert[]>('/alerts/mine?limit=20'),
  exportData: () => request<CitizenExport>('/me/export'),
  /** Estado de tu cuenta (uso indebido, 0011) y solicitud de revisión. */
  account: () => request<CitizenAccountDetail>('/me/account'),
  requestReview: (body: CreateReview) => request<CitizenAccountDetail>('/me/reviews', { method: 'POST', body: json(body) }),
  eraseAccount: () => request<CitizenEraseResult>('/me', { method: 'DELETE' }),
};

/**
 * Envía una alerta (multipart: `meta` JSON + `audio`/`photo` opcionales). Reintenta hasta 3 veces si
 * no hay red o la API falla (5xx) con el MISMO `clientRef`: la base tiene UNIQUE (citizen_id,
 * client_ref), así que un reintento nunca duplica la alerta.
 */
export async function sendAlert(
  meta: CreateAlertMeta & { clientRef: string },
  files: { audio?: UploadFile; photo?: UploadFile } = {},
) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    if (files.audio) await appendFile(form, 'audio', files.audio);
    if (files.photo) await appendFile(form, 'photo', files.photo);
    try {
      return await request<CreateAlertResponse>('/alerts', { method: 'POST', body: form });
    } catch (e) {
      last = e;
      // Cuenta bloqueada o restringida (0011): se relee el estado y la app cambia de pantalla sola.
      if (e instanceof ApiError && (e.code === 'ACCOUNT_BLOCKED' || e.code === 'ACCOUNT_RESTRICTED')) void syncAccount();
      const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!retryable) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw last;
}

/**
 * Relee el vecino (con el estado de su cuenta) y lo guarda en la sesión: al abrir la app, al recibir
 * `account.updated` y cuando una alerta vuelve rechazada por la cuenta. Sin red no pasa nada.
 */
export async function syncAccount(): Promise<void> {
  try {
    await updateCitizen(await api.me());
  } catch {
    // Sin red o sesión vencida: se reintenta en el próximo evento.
  }
}

/** Archivo local para subir: en el teléfono, la ruta que devuelve el grabador o la cámara. */
export type UploadFile = { uri: string; name: string; type: string };

/**
 * En el teléfono, React Native sube `{ uri, name, type }` directo desde el disco. En la web la uri es
 * un blob: se lee y se normaliza el tipo ("audio/webm;codecs=opus" → "audio/webm"), porque la API
 * compara el tipo exacto contra su lista permitida.
 */
async function appendFile(form: FormData, field: string, f: UploadFile): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = await (await fetch(f.uri)).blob();
    form.append(field, new Blob([blob], { type: f.type }), f.name);
    return;
  }
  form.append(field, f as unknown as Blob);
}

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

/**
 * Mensaje para mostrar al vecino. Los de la API ya vienen en español. Un error que no es de red
 * (micrófono, grabación, archivo) no se disfraza de "sin conexión": en desarrollo se muestra tal cual.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  console.warn('error en la app:', e);
  const detail = __DEV__ && e instanceof Error ? ` [${e.name}: ${e.message}]` : '';
  return `Algo falló en el teléfono. Intenta de nuevo; si es una emergencia, llama al 133.${detail}`;
}
