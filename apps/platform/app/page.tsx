'use client';

import { COMUNA_SERVICE_STATUSES, type ComunaMap, type ComunaRow, type RegionSummary } from '@guardia/shared';
import { Search } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Shell, usePlatformSession } from '@/components/Shell';
import { Card, ErrorNote, inputClass, Legend, Loading, StatusTag } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SERVICE_COLOR } from '@/lib/labels';

const ComunaMapView = dynamic(() => import('@/components/ComunaMap'), { ssr: false, loading: () => <Loading /> });

/** CUT de la región a partir del de la comuna (13101 → 13, 1101 → 1). */
const regionOf = (cut: number) => Math.floor(cut / 1000);

function StatusBar({ byStatus, total }: { byStatus: RegionSummary['byStatus']; total: number }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg" aria-hidden>
      {COMUNA_SERVICE_STATUSES.map((s) =>
        byStatus[s] ? <span key={s} style={{ width: `${(byStatus[s] / total) * 100}%`, background: SERVICE_COLOR[s] }} /> : null,
      )}
    </div>
  );
}

function ComunaSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ComunaRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => {
      api
        .searchComunas(term)
        .then((r) => {
          setResults(r);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const shown = q.trim().length >= 2 ? results : null;
  return (
    <div className="relative">
      <Search size={16} className="absolute left-3 top-2.5 text-ink-faint" aria-hidden />
      <input
        className={`${inputClass} pl-9`}
        placeholder="Buscar comuna por nombre o CUT"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Buscar comuna"
      />
      <ErrorNote>{error}</ErrorNote>
      {shown ? (
        <ul className="absolute z-[1001] mt-1 w-full max-h-80 overflow-y-auto gi-scroll rounded-ctl border border-line-strong bg-surface shadow-xl">
          {shown.length === 0 ? <li className="px-3 py-2 text-sm text-ink-muted">Sin resultados</li> : null}
          {shown.map((c) => (
            <li key={c.cut}>
              <Link
                href={c.tenantId ? `/municipio/${c.tenantId}` : `/region/${c.regionCut}?comuna=${c.cut}`}
                className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2"
              >
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{c.name}</span>
                  <span className="block text-xs text-ink-faint truncate">
                    {c.provinciaName} · {c.regionName}
                  </span>
                </span>
                <StatusTag status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Chile de norte a sur (RF-1.1, RF-1.2): mapa coloreado por estado y resumen de cada región. */
export default function CountryPage() {
  const session = usePlatformSession();
  const router = useRouter();
  const [regions, setRegions] = useState<RegionSummary[] | null>(null);
  const [map, setMap] = useState<ComunaMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    api.regions().then(setRegions).catch((e) => setError(errorMessage(e)));
    api.countryMap().then(setMap).catch((e) => setError(errorMessage(e)));
  }, [session]);

  const totals = useMemo(() => {
    if (!regions) return null;
    const byStatus = Object.fromEntries(COMUNA_SERVICE_STATUSES.map((s) => [s, 0])) as RegionSummary['byStatus'];
    let comunas = 0;
    let alerts = 0;
    let unserved = 0;
    for (const r of regions) {
      comunas += r.comunas;
      alerts += r.alertsMonth;
      unserved += r.unservedMonth;
      for (const s of COMUNA_SERVICE_STATUSES) byStatus[s] += r.byStatus[s];
    }
    return { byStatus, comunas, alerts, unserved };
  }, [regions]);

  if (!session) return null;

  return (
    <Shell session={session}>
      <div className="flex flex-wrap items-end gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold">Chile</h1>
          <p className="text-sm text-ink-muted">
            {totals ? `${totals.comunas} comunas · ${totals.byStatus.ACTIVE} en servicio · ${totals.byStatus.ONBOARDING} en implementación` : '…'}
          </p>
        </div>
        <div className="ml-auto w-full sm:w-96">
          <ComunaSearch />
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>

      {totals ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Stat label="Alertas en comunas con servicio (30 días)" value={totals.alerts} />
          <Stat label="Demanda no atendida (30 días)" value={totals.unserved} hint="SOS y reportes desde comunas sin Guard-IA" />
          <Stat label="Suspendidos" value={totals.byStatus.SUSPENDED} />
          <Stat label="De baja" value={totals.byStatus.TERMINATED} />
        </div>
      ) : null}

      <div className="grid lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-5">
        <div>
          {map ? (
            <ComunaMapView data={map} height={720} onSelect={(cut) => router.push(`/region/${regionOf(cut)}?comuna=${cut}`)} />
          ) : (
            <Loading />
          )}
          <Legend />
        </div>
        <Card title="Regiones de norte a sur">
          {!regions ? (
            <Loading />
          ) : (
            <ul className="divide-y divide-line -my-2">
              {regions.map((r) => (
                <li key={r.cut}>
                  <Link href={`/region/${r.cut}`} className="block py-3 px-1 hover:bg-surface-2 rounded-ctl">
                    <div className="flex items-baseline gap-3">
                      <span className="w-10 text-xs text-ink-faint font-mono">{r.roman}</span>
                      <span className="flex-1 min-w-0 truncate font-medium">{r.name}</span>
                      <span className="text-xs text-ink-muted whitespace-nowrap">
                        {r.byStatus.ACTIVE + r.byStatus.SUSPENDED}/{r.comunas} con servicio
                        {r.byStatus.ONBOARDING ? ` · ${r.byStatus.ONBOARDING} en implementación` : ''}
                      </span>
                    </div>
                    <div className="mt-2 pl-[52px] flex items-center gap-3">
                      <StatusBar byStatus={r.byStatus} total={r.comunas} />
                      <span className="text-xs text-ink-faint whitespace-nowrap w-40 text-right">
                        {r.alertsMonth} alertas · {r.unservedMonth} sin atender
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3" title={hint}>
      <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString('es-CL')}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  );
}
