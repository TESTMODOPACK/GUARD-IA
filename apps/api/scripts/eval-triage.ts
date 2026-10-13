/**
 * pnpm --filter @guardia/api eval:triage [--provider mock|openai] [--only vif] [--limit 20]
 *        [--concurrency 1] [--verbose] [--json resultado.json] [--cases otros-casos.json]
 *        [--gate --min-high 1 --min-category 0.85]
 *
 * Evalúa el agente de clasificación con casos conocidos (scripts/triage-cases.json): la misma
 * cadena que el worker (modelo → normalización → reglas fijas de shared). Mide categoría,
 * subcategoría, prioridad, derivación, señales y lugar, y sobre todo el recall de riesgo vital:
 * cuántos casos que DEBEN ser prioridad alta lo fueron (con y sin las reglas fijas).
 *
 * Úsalo antes y después de cambiar el prompt, el modelo o las reglas; con --gate sale con código 1
 * si se pierde un caso de riesgo vital o baja la precisión de categoría (compuerta para CI).
 * Con IA real consume cuota del proveedor (Groq gratis tiene límite por minuto; reintenta los 429).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildTriage,
  normalizeTriageText,
  type AiFlags,
  type AlertCategory,
  type AlertType,
  type Priority,
  type SuggestedAgency,
  type Triage,
} from '@guardia/shared';
import { MockAiProvider } from '../src/ai/mock.provider';
import { OpenAiProvider } from '../src/ai/openai.provider';
import type { AiProvider } from '../src/ai/ai.provider';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';

loadEnvFiles();

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

type OneOrMany<T> = T | T[];
interface Case {
  id: string;
  type: AlertType;
  via: 'audio' | 'text';
  text: string;
  chosenCategory?: AlertCategory | null;
  expect: {
    category: OneOrMany<AlertCategory>;
    subcategory?: OneOrMany<string>;
    priority: OneOrMany<Priority>;
    /** Instituciones que no pueden faltar. */
    agencies?: SuggestedAgency[];
    /** Aceptables como primera derivación. */
    primary?: OneOrMany<SuggestedAgency>;
    notAgencies?: SuggestedAgency[];
    flags?: Partial<AiFlags>;
    location?: { mentioned?: boolean; elsewhere?: boolean; comuna?: string };
    maxConfidence?: number;
  };
}
interface Check {
  metric: string;
  ok: boolean;
  detail: string;
}
interface Result {
  c: Case;
  triage: Triage | null;
  error: string | null;
  ms: number;
  checks: Check[];
}

const many = <T>(v: OneOrMany<T>): T[] => (Array.isArray(v) ? v : [v]);
let waitedMs = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera que pide el proveedor ante un 429 (cabecera retry-after o "try again in 12.3s"). */
function retryAfterMs(e: unknown): number | null {
  const err = e as { status?: number; headers?: { get?: (k: string) => string | null }; message?: string };
  if (err?.status !== 429) return null;
  const h = typeof err.headers?.get === 'function' ? err.headers.get('retry-after') : null;
  const s = Number(h);
  if (Number.isFinite(s) && s > 0) return s * 1000 + 250;
  const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(String(err.message ?? ''));
  if (m) return Number(m[1]) * (m[2] === 'ms' ? 1 : 1000) + 250;
  return 10_000;
}

function evaluate(c: Case, t: Triage): Check[] {
  const e = c.expect;
  const out: Check[] = [];
  const check = (metric: string, ok: boolean, detail: string) => out.push({ metric, ok, detail });
  const agencies = t.agencies.map((a) => a.agency);

  check('categoría', many(e.category).includes(t.category), `${t.category} (esperado ${many(e.category).join('|')})`);
  if (e.subcategory !== undefined) {
    check(
      'subcategoría',
      many(e.subcategory).includes(t.subcategory ?? ''),
      `${t.subcategory} (esperado ${many(e.subcategory).join('|')})`,
    );
  }
  check('prioridad', many(e.priority).includes(t.priority), `${t.priority} (esperado ${many(e.priority).join('|')})`);
  if (many(e.priority).length === 1 && many(e.priority)[0] === 'HIGH') {
    check('riesgo vital', t.priority === 'HIGH', `final ${t.priority}`);
    check('riesgo vital (solo modelo)', t.modelPriority === 'HIGH', `modelo ${t.modelPriority}`);
  }
  if (e.agencies?.length) {
    const missing = e.agencies.filter((a) => !agencies.includes(a));
    check('derivación completa', missing.length === 0, missing.length ? `faltan ${missing.join(', ')}` : agencies.join(', '));
  }
  if (e.primary) {
    check('primera derivación', many(e.primary).includes(agencies[0]), `${agencies[0]} (esperado ${many(e.primary).join('|')})`);
  }
  if (e.notAgencies?.length) {
    const extra = e.notAgencies.filter((a) => agencies.includes(a));
    check('sin derivación de más', extra.length === 0, extra.length ? `sobra ${extra.join(', ')}` : 'ok');
  }
  for (const [k, v] of Object.entries(e.flags ?? {})) {
    check('señales', t.flags[k as keyof AiFlags] === v, `${k}=${t.flags[k as keyof AiFlags]} (esperado ${v})`);
  }
  if (e.location) {
    const l = t.location;
    if (e.location.mentioned !== undefined) {
      check('lugar', !!l.mentioned === e.location.mentioned, `mencionado: ${l.mentioned ?? 'ninguno'}`);
    }
    if (e.location.elsewhere !== undefined) check('lugar', l.elsewhere === e.location.elsewhere, `en otro lugar: ${l.elsewhere}`);
    if (e.location.comuna !== undefined) {
      const ok = !!l.comuna && normalizeTriageText(l.comuna).includes(normalizeTriageText(e.location.comuna));
      check('comuna', ok, `${l.comuna ?? 'ninguna'} (esperado ${e.location.comuna})`);
    }
  }
  if (e.maxConfidence !== undefined) check('confianza', t.confidence <= e.maxConfidence, `${t.confidence}`);
  return out;
}

async function runCase(ai: AiProvider, c: Case): Promise<Result> {
  let started = Date.now();
  const input = {
    type: c.type,
    transcription: c.via === 'audio' ? c.text : null,
    userText: c.via === 'text' ? c.text : null,
    chosenCategory: c.chosenCategory ?? null,
    localTime: '13-10-2026 21:30',
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = await ai.classify(input);
      const triage = buildTriage(c.type, raw, c.text, { provider: ai.name, model: ai.model });
      return { c, triage, error: null, ms: Date.now() - started, checks: evaluate(c, triage) };
    } catch (e) {
      const wait = retryAfterMs(e);
      if (wait !== null && attempt <= 6) {
        console.log(`  · ${c.id}: límite del proveedor, espero ${Math.round(wait / 1000)} s`);
        await sleep(wait);
        waitedMs += wait;
        started = Date.now(); // la latencia mide solo el intento que respondió, no la espera
        continue;
      }
      const msg = (e as Error).message;
      return { c, triage: null, error: msg, ms: Date.now() - started, checks: [{ metric: 'respuesta', ok: false, detail: msg }] };
    }
  }
}

async function main() {
  const env = validateEnv(process.env);
  const providerName = arg('provider', env.AI_PROVIDER === 'openai' && env.OPENAI_API_KEY ? 'openai' : 'mock');
  if (providerName === 'openai' && !env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no está definida en .env');
  const ai: AiProvider = providerName === 'openai' ? new OpenAiProvider(env) : new MockAiProvider();

  const file = arg('cases', join(__dirname, 'triage-cases.json'))!;
  let cases = (JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] }).cases;
  const only = arg('only');
  if (only) cases = cases.filter((c) => c.id.includes(only));
  const limit = Number(arg('limit', '0'));
  if (limit > 0) cases = cases.slice(0, limit);
  const concurrency = Math.max(1, Number(arg('concurrency', providerName === 'mock' ? '8' : '1')));
  const verbose = flag('verbose');

  console.log(`Agente de clasificación · ${ai.name}${ai.model ? ` (${ai.model})` : ''} · ${cases.length} casos\n`);
  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < cases.length) {
        const c = cases[next++];
        const r = await runCase(ai, c);
        results.push(r);
        const failed = r.checks.filter((x) => !x.ok);
        const t = r.triage;
        const line = t
          ? `${t.category}${t.subcategory ? `/${t.subcategory}` : ''} · ${t.priority} · ${t.agencies.map((a) => a.agency).join('+')}` +
            (t.rules.length ? ` · reglas ${t.rules.join(',')}` : '')
          : `error: ${r.error}`;
        console.log(`${failed.length ? '✗' : '✓'} ${c.id.padEnd(14)} ${String(r.ms).padStart(5)} ms  ${line}`);
        for (const f of verbose ? r.checks : failed) console.log(`      ${f.ok ? '·' : '✗'} ${f.metric}: ${f.detail}`);
      }
    }),
  );
  results.sort((a, b) => cases.indexOf(a.c) - cases.indexOf(b.c));

  // ---------------------------------------------------------------- resumen
  const byMetric = new Map<string, { ok: number; total: number }>();
  for (const r of results) {
    for (const ch of r.checks) {
      const m = byMetric.get(ch.metric) ?? { ok: 0, total: 0 };
      m.total++;
      if (ch.ok) m.ok++;
      byMetric.set(ch.metric, m);
    }
  }
  const rate = (m?: { ok: number; total: number }) => (m && m.total ? m.ok / m.total : 1);
  const passed = results.filter((r) => r.checks.every((x) => x.ok)).length;
  const errors = results.filter((r) => r.error).length;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
  const ruleCount = new Map<string, number>();
  for (const r of results) for (const id of r.triage?.rules ?? []) ruleCount.set(id, (ruleCount.get(id) ?? 0) + 1);
  const raised = results.filter((r) => r.triage && r.triage.modelPriority !== r.triage.priority).length;

  console.log('\nResumen');
  console.log(`  casos sin observaciones     ${passed}/${results.length} (${Math.round((passed / Math.max(1, results.length)) * 100)} %)`);
  for (const [k, m] of [...byMetric.entries()].sort()) {
    console.log(`  ${k.padEnd(28)}${`${m.ok}/${m.total}`.padStart(6)}  ${(rate(m) * 100).toFixed(0).padStart(3)} %`);
  }
  console.log(`  errores del proveedor       ${errors}`);
  if (waitedMs) console.log(`  espera por límite de cuota  ${Math.round(waitedMs / 1000)} s (no cuenta en la latencia)`);
  console.log(`  latencia                    p50 ${p(0.5)} ms · p95 ${p(0.95)} ms`);
  console.log(
    `  reglas fijas                subieron la prioridad en ${raised} caso(s)` +
      (ruleCount.size ? ` · ${[...ruleCount.entries()].map(([k, v]) => `${k}×${v}`).join(' ')}` : ''),
  );

  const out = arg('json');
  if (out) {
    const metrics = Object.fromEntries([...byMetric.entries()].map(([k, m]) => [k, { ...m, rate: rate(m) }]));
    const detail = results.map((r) => ({ id: r.c.id, ms: r.ms, error: r.error, triage: r.triage, failed: r.checks.filter((x) => !x.ok) }));
    writeFileSync(out, JSON.stringify({ provider: ai.name, model: ai.model, at: new Date().toISOString(), metrics, results: detail }, null, 2));
    console.log(`\nDetalle en ${out}`);
  }

  if (flag('gate')) {
    const minHigh = Number(arg('min-high', '1'));
    const minCategory = Number(arg('min-category', '0.85'));
    const high = rate(byMetric.get('riesgo vital'));
    const cat = rate(byMetric.get('categoría'));
    const ok = high >= minHigh && cat >= minCategory && errors === 0;
    console.log(
      `\nCompuerta: riesgo vital ${(high * 100).toFixed(0)} % (mín ${(minHigh * 100).toFixed(0)} %) · ` +
        `categoría ${(cat * 100).toFixed(0)} % (mín ${(minCategory * 100).toFixed(0)} %) · ${ok ? 'APROBADA' : 'NO APROBADA'}`,
    );
    if (!ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
