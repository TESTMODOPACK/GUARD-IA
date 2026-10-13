'use client';

import { COMUNA_SERVICE_STATUSES, type ComunaMap, type ComunaRow, type ComunaServiceStatus, type RegionDetail } from '@guardia/shared';
import { ArrowLeft } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { CreateTenantDialog } from '@/components/TenantDialogs';
import { canManage, Shell, usePlatformSession } from '@/components/Shell';
import { Button, Card, ErrorNote, inputClass, Legend, Loading, StatusTag } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SERVICE_STATUS } from '@/lib/labels';

const ComunaMapView = dynamic(() => import('@/components/ComunaMap'), { ssr: false, loading: () => <Loading /> });

type Filter = 'ALL' | ComunaServiceStatus;

function RegionView() {
  const session = usePlatformSession();
  const router = useRouter();
  const params = useParams<{ cut: string }>();
  const search = useSearchParams();
  const cut = Number(params.cut);
  const [detail, setDetail] = useState<RegionDetail | null>(null);
  const [map, setMap] = useState<ComunaMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(() => Number(search.get('comuna')) || null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [text, setText] = useState('');
  const [creating, setCreating] = useState<ComunaRow | null>(null);

  useEffect(() => {
    if (!session || !Number.isInteger(cut)) return;
    api.region(cut).then(setDetail).catch((e) => setError(errorMessage(e)));
    api.regionMap(cut).then(setMap).catch((e) => setError(errorMessage(e)));
  }, [session, cut]);

  const comuna = useMemo(() => detail?.comunas.find((c) => c.cut === selected) ?? null, [detail, selected]);
  const byProvincia = useMemo(() => {
    if (!detail) return [];
    const t = text.trim().toLowerCase();
    const rows = detail.comunas.filter(
      (c) => (filter === 'ALL' || c.status === filter) && (!t || c.name.toLowerCase().includes(t) || String(c.cut).includes(t)),
    );
    return detail.provincias
      .map((p) => ({ ...p, comunas: rows.filter((c) => c.provinciaCut === p.cut) }))
      .filter((p) => p.comunas.length);
  }, [detail, filter, text]);

  if (!session) return null;
  const manager = canManage(session);
  const r = detail?.region;

  return (
    <Shell session={session}>
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink mb-3">
        <ArrowLeft size={16} /> Chile
      </Link>
      <div className="flex flex-wrap items-end gap-4 mb-5">
        <div>
          <h1 className="text-xl font-semibold">{r ? `${r.name} (${r.roman})` : 'Región'}</h1>
          {r ? (
            <p className="text-sm text-ink-muted">
              {r.comunas} comunas · {r.byStatus.ACTIVE} en servicio · {r.byStatus.ONBOARDING} en implementación ·{' '}
              {r.byStatus.SUSPENDED} suspendidas · {r.alertsMonth} alertas y {r.unservedMonth} sin atender en 30 días
            </p>
          ) : null}
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5 mb-5">
        <div>
          {map ? <ComunaMapView data={map} selectedCut={selected} onSelect={setSelected} height={520} /> : <Loading />}
          <Legend />
        </div>
        <Card title={comuna ? comuna.name : 'Comuna'}>
          {!comuna ? (
            <p className="text-sm text-ink-muted">Elige una comuna en el mapa o en la tabla.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusTag status={comuna.status} />
                <span className="text-ink-faint">CUT {String(comuna.cut).padStart(5, '0')}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-ink-muted">Provincia</dt>
                <dd>{comuna.provinciaName}</dd>
                <dt className="text-ink-muted">Municipio</dt>
                <dd>{comuna.tenantName ?? '—'}</dd>
                <dt className="text-ink-muted">Alertas (30 días)</dt>
                <dd className="tabular-nums">{comuna.alertsMonth}</dd>
                <dt className="text-ink-muted">Abiertas ahora</dt>
                <dd className="tabular-nums">{comuna.openAlerts}</dd>
                <dt className="text-ink-muted">Sin atender (30 días)</dt>
                <dd className="tabular-nums">
                  {comuna.unservedSos} SOS · {comuna.unservedReports} reportes
                </dd>
              </dl>
              {comuna.tenantId ? (
                <Link href={`/municipio/${comuna.tenantId}`} className="inline-flex h-9 px-3 items-center rounded-ctl bg-surface-2 border border-line hover:border-line-strong">
                  Ver municipio
                </Link>
              ) : null}
              {manager && (comuna.status === 'AVAILABLE' || comuna.status === 'TERMINATED') ? (
                <Button variant="primary" onClick={() => setCreating(comuna)}>
                  Dar de alta el municipio
                </Button>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Comunas por provincia"
        actions={
          <input className={`${inputClass} w-56 h-8`} placeholder="Filtrar por nombre o CUT" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filtrar comunas" />
        }
      >
        <div role="radiogroup" aria-label="Estado" className="flex flex-wrap gap-1 mb-4">
          {(['ALL', ...COMUNA_SERVICE_STATUSES] as Filter[]).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={`h-8 px-3 rounded-ctl text-sm border ${filter === f ? 'bg-surface-2 border-line-strong text-ink' : 'border-line text-ink-muted hover:text-ink'}`}
            >
              {f === 'ALL' ? 'Todas' : SERVICE_STATUS[f]}
              {detail ? <span className="ml-1 text-ink-faint">{f === 'ALL' ? detail.comunas.length : detail.region.byStatus[f]}</span> : null}
            </button>
          ))}
        </div>
        {!detail ? (
          <Loading />
        ) : byProvincia.length === 0 ? (
          <p className="text-sm text-ink-muted">Ninguna comuna con ese filtro.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-muted text-left">
                <tr>
                  <th className="py-2 pr-3 font-normal">Comuna</th>
                  <th className="py-2 pr-3 font-normal">CUT</th>
                  <th className="py-2 pr-3 font-normal">Estado</th>
                  <th className="py-2 pr-3 font-normal">Municipio</th>
                  <th className="py-2 pr-3 font-normal text-right">Alertas 30 d</th>
                  <th className="py-2 font-normal text-right">Sin atender 30 d</th>
                </tr>
              </thead>
              {byProvincia.map((p) => (
                <tbody key={p.cut}>
                  <tr>
                    <th colSpan={6} className="pt-4 pb-1 text-left text-xs uppercase tracking-wide text-ink-faint font-medium">
                      Provincia de {p.name}
                    </th>
                  </tr>
                  {p.comunas.map((c) => (
                    <tr
                      key={c.cut}
                      className={`border-t border-line cursor-pointer hover:bg-surface-2 ${selected === c.cut ? 'bg-surface-2' : ''}`}
                      onClick={() => setSelected(c.cut)}
                    >
                      <td className="py-2 pr-3">{c.name}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-ink-faint">{String(c.cut).padStart(5, '0')}</td>
                      <td className="py-2 pr-3">
                        <StatusTag status={c.status} />
                      </td>
                      <td className="py-2 pr-3">
                        {c.tenantId ? (
                          <Link href={`/municipio/${c.tenantId}`} className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                            {c.tenantName}
                          </Link>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.alertsMonth}</td>
                      <td className="py-2 text-right tabular-nums">{c.unservedSos + c.unservedReports}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Card>

      {creating && detail ? (
        <CreateTenantDialog
          comuna={{ cut: creating.cut, name: creating.name, regionName: detail.region.name }}
          onClose={() => setCreating(null)}
          onCreated={(t) => router.push(`/municipio/${t.id}`)}
        />
      ) : null}
    </Shell>
  );
}

export default function RegionPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RegionView />
    </Suspense>
  );
}
