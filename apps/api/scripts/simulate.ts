/**
 * pnpm simulate [--api http://localhost:3000] [--phone +56912345678]
 *               [--audio ./grabacion.m4a] [--text "me están asaltando en la plaza"]
 *               [--type EMERGENCY_SOS|CIVIC_REPORT] [--lat -33.61 --lng -70.58]
 *               [--operator admin@demo.guardia.cl --password Demo1234!] [--no-dispatch]
 *               [--concurrency 20]   ráfaga de reportes en paralelo al final (prueba de carga mínima)
 *               [--external-dispatch --wait 180]  compuerta Fase 2: espera que la central despache
 *
 * Recorre el flujo completo sin app móvil (compuerta de la Fase 1):
 *   1. operador entra y escucha /ops por WebSocket
 *   2. vecino: OTP → consentimiento → dispositivo → POST /alerts (con audio) y mide
 *      cuánto tarda alert.created en llegar a la central
 *   3. espera alert.updated con la IA (DONE/FAILED/SKIPPED)
 *   4. central: acusa, despacha una unidad, la pone en camino; el vecino recibe alert.status
 *   5. central resuelve
 * Sale con código 1 si alert.created tarda más de 1 s o si un paso falla.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { loadEnvFiles } from '../src/cli/load-env';

loadEnvFiles();

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const API = (arg('api') ?? process.env.PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const PHONE = arg('phone') ?? `+5699${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const TYPE = arg('type', 'EMERGENCY_SOS') as 'EMERGENCY_SOS' | 'CIVIC_REPORT';
const LAT = Number(arg('lat', '-33.6117'));
const LNG = Number(arg('lng', '-70.5758'));
const TEXT = arg('text');
const AUDIO = arg('audio');
const OP_EMAIL = arg('operator', process.env.SIM_OPERATOR_EMAIL ?? 'admin@demo.guardia.cl')!;
const OP_PASS = arg('password', process.env.SIM_OPERATOR_PASSWORD ?? 'Demo1234!')!;
const DO_DISPATCH = !flag('no-dispatch') && !flag('external-dispatch');
/** --external-dispatch: no despacha por API; espera que un operador (la central) despache y mide. */
const EXTERNAL = flag('external-dispatch');
const WAIT_S = Number(arg('wait', '180'));
const CONCURRENCY = Number(arg('concurrency', '0'));
const MAX_CREATED_MS = 1000;

type Row = { paso: string; ms: number | null; detalle: string };
const rows: Row[] = [];
let failed = false;
const t = () => Date.now();

function log(step: string, ms: number | null, detail: string) {
  rows.push({ paso: step, ms, detalle: detail });
  console.log(`${ms === null ? '      ' : String(ms).padStart(5) + 'ms'}  ${step.padEnd(28)} ${detail}`);
}

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}/v1${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${body?.code ?? ''} ${body?.message ?? text}`);
  return body as T;
}

function waitFor<T>(socket: Socket, event: string, pred: (p: T) => boolean, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout esperando ${event}`));
    }, timeoutMs);
    const handler = (p: T) => {
      if (!pred(p)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });
}

function connect(ns: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(`${API}${ns}`, { auth: { token }, transports: ['websocket'] });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(new Error(`WS ${ns}: ${e.message}`)));
    s.once('error', (e: unknown) => reject(new Error(`WS ${ns}: ${JSON.stringify(e)}`)));
  });
}

/** WAV sintético (3 s, 16 kHz, mono, tono 440 Hz) para probar el camino del audio. */
function syntheticWav(seconds = 3, rate = 16_000): Buffer {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const MIME: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
};

async function main() {
  console.log(`Guard-IA simulador → ${API}\n`);

  // 1. operador
  let t0 = t();
  const login = await api<{ accessToken: string; operator: { tenantId: string; name: string } }>('/ops/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: OP_EMAIL, password: OP_PASS }),
  });
  log('operador login', t() - t0, `${login.operator.name}`);
  t0 = t();
  const ops = await connect('/ops', login.accessToken);
  log('operador WS /ops', t() - t0, `socket ${ops.id}`);

  // 2. vecino
  t0 = t();
  await api('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone: PHONE }) });
  const { hint } = await api<{ hint: string }>(`/dev/otp/${encodeURIComponent(PHONE)}`);
  const verify = await api<{ accessToken: string; citizen: { id: string; trustScore: number } }>('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone: PHONE, code: hint }),
  });
  const cz = verify.accessToken;
  log('vecino OTP', t() - t0, `citizen ${verify.citizen.id} trust=${verify.citizen.trustScore}`);
  // El aviso vigente (0014): se acepta el texto exacto que entrega la API, por su hash.
  const notice = await api<{ version: string; hash: string }>('/legal/notice');
  await api('/me/consent', {
    method: 'POST',
    token: cz,
    body: JSON.stringify({ version: notice.version, noticeHash: notice.hash, externalAi: true, ageConfirmed: true, platform: 'android' }),
  });
  await api('/me/devices', {
    method: 'PUT',
    token: cz,
    body: JSON.stringify({ expoPushToken: `ExponentPushToken[sim-${randomUUID().slice(0, 8)}]`, platform: 'android', appVersion: 'sim' }),
  });
  const citizenWs = await connect('/citizen', cz);
  log('vecino consent+device+WS', null, 'listo');

  // 3. alerta con audio
  const form = new FormData();
  form.set(
    'meta',
    JSON.stringify({
      type: TYPE,
      source: AUDIO || !TEXT ? 'VOICE' : 'BUTTON',
      location: { lat: LAT, lng: LNG },
      accuracyM: 8,
      userText: TEXT,
      clientRef: randomUUID(),
      ...(TYPE === 'CIVIC_REPORT' ? { category: 'BACHE', source: 'FORM' } : {}),
    }),
  );
  const audioBuf = AUDIO ? readFileSync(AUDIO) : syntheticWav();
  const audioMime = AUDIO ? (MIME[extname(AUDIO).toLowerCase()] ?? 'audio/mp4') : 'audio/wav';
  form.set('audio', new Blob([new Uint8Array(audioBuf)], { type: audioMime }), AUDIO ? 'audio' + extname(AUDIO) : 'audio.wav');

  const createdP = waitFor<{ id: string; status: string }>(ops, 'alert.created', () => true, 10_000);
  const tPost = t();
  const created = await api<{ alertId: string; status: string; tenant: { name: string } | null }>('/alerts', {
    method: 'POST',
    token: cz,
    body: form,
  });
  const postMs = t() - tPost;
  log('POST /alerts respondió', postMs, `${created.status} → ${created.tenant?.name ?? 'SIN COBERTURA'} (${created.alertId})`);
  if (!created.tenant) {
    createdP.catch(() => undefined);
    log('ruteo', null, 'UNROUTED: la coordenada no cae en ningún municipio del seed; la app debe sugerir llamar al 133');
    ops.close();
    citizenWs.close();
    console.log('\nRESULTADO: UNROUTED (esperado para coordenadas fuera de cobertura)');
    process.exit(0);
  }
  const evt = await createdP;
  const createdMs = t() - tPost;
  log('alert.created en central', createdMs, createdMs <= MAX_CREATED_MS ? 'OK (< 1 s)' : `LENTO (> ${MAX_CREATED_MS} ms)`);
  if (createdMs > MAX_CREATED_MS) failed = true;
  if (evt.id !== created.alertId) {
    failed = true;
    log('alert.created', null, `id inesperado ${evt.id}`);
  }

  // 4. IA
  t0 = t();
  const ai = await waitFor<{ id: string; aiStatus: string; category: string | null; priority: string | null; aiSummary: string | null; transcription: string | null }>(
    ops,
    'alert.updated',
    (a) => a.id === created.alertId && ['DONE', 'FAILED', 'SKIPPED', 'LOCAL'].includes(a.aiStatus),
    90_000,
  );
  log('IA alert.updated', t() - t0, `${ai.aiStatus} ${ai.category ?? '-'} ${ai.priority ?? '-'} · "${ai.aiSummary ?? ''}"`);
  if (ai.transcription) log('transcripción', null, ai.transcription.slice(0, 120));
  if (ai.aiStatus === 'FAILED') log('IA', null, 'FAILED pero la alerta sigue visible con prioridad de falla segura');

  // 5b. Compuerta de la Fase 2: la central (UI) despacha; aquí solo se espera el push al vecino.
  if (EXTERNAL && created.tenant) {
    console.log(`\nALERT_ID=${created.alertId}`);
    console.log(`Esperando hasta ${WAIT_S} s a que un operador despache desde la central...`);
    t0 = t();
    const st = await waitFor<{ id: string; status: string; activeDispatch: { unitCode: string; status: string } | null }>(
      citizenWs,
      'alert.status',
      (p) => p.id === created.alertId && p.status === 'DISPATCHED',
      WAIT_S * 1000,
    );
    log('despacho desde la central', t() - t0, `vecino recibió ${st.status} · ${st.activeDispatch?.unitCode ?? '?'} (${st.activeDispatch?.status})`);
  }

  // 5. central
  if (DO_DISPATCH && created.tenant) {
    const opTok = login.accessToken;
    t0 = t();
    await api(`/ops/alerts/${created.alertId}/ack`, { method: 'POST', token: opTok });
    log('ack', t() - t0, 'ACKNOWLEDGED');

    const units = await api<Array<{ id: string; code: string; status: string; kind: string }>>('/ops/units', { token: opTok });
    const free =
      units.find((u) => u.status === 'AVAILABLE' && u.kind === 'PATRULLA') ?? units.find((u) => u.status === 'AVAILABLE');
    if (!free) throw new Error('No hay unidades AVAILABLE; ejecuta pnpm seed');

    const statusP = waitFor<{ id: string; status: string; activeDispatch: { unitCode: string; status: string } | null }>(
      citizenWs,
      'alert.status',
      (p) => p.id === created.alertId && p.status === 'DISPATCHED',
      10_000,
    );
    t0 = t();
    const d = await api<{ id: string; unitCode: string }>(`/ops/alerts/${created.alertId}/dispatch`, {
      method: 'POST',
      token: opTok,
      body: JSON.stringify({ unitId: free.id, notes: 'simulador' }),
    });
    const st = await statusP;
    log('despacho → vecino', t() - t0, `${d.unitCode} · vecino recibió ${st.status} (${st.activeDispatch?.status})`);

    const enRouteP = waitFor<{ id: string; activeDispatch: { status: string } | null }>(
      citizenWs,
      'alert.status',
      (p) => p.id === created.alertId && p.activeDispatch?.status === 'EN_ROUTE',
      10_000,
    );
    t0 = t();
    await api(`/ops/dispatches/${d.id}`, { method: 'PATCH', token: opTok, body: JSON.stringify({ status: 'EN_ROUTE' }) });
    await enRouteP;
    log('EN_ROUTE → vecino', t() - t0, 'recibido');

    t0 = t();
    const resolved = await api<{ status: string; events: unknown[] }>(`/ops/alerts/${created.alertId}/resolve`, {
      method: 'POST',
      token: opTok,
      body: JSON.stringify({ notes: 'cerrado por simulador' }),
    });
    log('resolve', t() - t0, `${resolved.status} · ${resolved.events.length} eventos en la línea de tiempo`);

    const detail = await api<{ media: Array<{ kind: string; url: string | null }> }>(`/ops/alerts/${created.alertId}`, { token: opTok });
    const audio = detail.media.find((m) => m.kind === 'AUDIO');
    if (audio?.url) {
      const r = await fetch(audio.url);
      log('audio firmado', null, r.ok ? `reproducible (${r.headers.get('content-type')})` : `HTTP ${r.status}`);
      if (!r.ok) failed = true;
    }
  }

  // 6. Opcional: ráfaga concurrente (detecta pools agotados y transacciones anidadas).
  if (CONCURRENCY > 0) {
    const mk = () => {
      const f = new FormData();
      f.set(
        'meta',
        JSON.stringify({ type: 'CIVIC_REPORT', source: 'FORM', category: 'LUMINARIA', location: { lat: LAT, lng: LNG }, clientRef: randomUUID(), userText: 'ráfaga' }),
      );
      return f;
    };
    t0 = t();
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        fetch(`${API}/v1/alerts`, { method: 'POST', headers: { Authorization: `Bearer ${cz}` }, body: mk(), signal: AbortSignal.timeout(15_000) })
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    const ok = results.filter((s) => s === 201).length;
    const limited = results.filter((s) => s === 429).length;
    const bad = results.filter((s) => s !== 201 && s !== 429);
    log(`ráfaga x${CONCURRENCY}`, t() - t0, `${ok} creadas, ${limited} limitadas (429), ${bad.length} errores ${bad.length ? JSON.stringify(bad) : ''}`);
    if (bad.length) failed = true;
    const h = await fetch(`${API}/v1/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
    log('health tras ráfaga', null, h ? 'OK' : 'SIN RESPUESTA');
    if (!h) failed = true;
  }

  ops.close();
  citizenWs.close();

  console.log('\nResumen');
  console.table(rows.map((r) => ({ paso: r.paso, ms: r.ms ?? '', detalle: r.detalle.slice(0, 60) })));
  if (failed) {
    console.error('\nRESULTADO: FALLÓ');
    process.exit(1);
  }
  console.log('\nRESULTADO: OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nERROR: ${(e as Error).message}`);
  process.exit(1);
});
