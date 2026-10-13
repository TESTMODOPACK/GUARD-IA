'use client';

import { TENANT_STATUSES, type TenantListItem, type TenantStatus } from '@guardia/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Shell, usePlatformSession } from '@/components/Shell';
import { Card, ErrorNote, Loading, StatusTag } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, SERVICE_STATUS } from '@/lib/labels';

/** Todos los municipios de Guard-IA, primero los que están en implementación. */
export default function TenantsPage() {
  const session = usePlatformSession();
  const [items, setItems] = useState<TenantListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | TenantStatus>('ALL');

  useEffect(() => {
    if (session) api.tenants().then(setItems).catch((e) => setError(errorMessage(e)));
  }, [session]);

  const shown = useMemo(() => (items ?? []).filter((t) => filter === 'ALL' || t.status === filter), [items, filter]);

  if (!session) return null;
  return (
    <Shell session={session}>
      <h1 className="text-xl font-semibold mb-1">Municipios</h1>
      <p className="text-sm text-ink-muted mb-5">
        Para dar de alta uno nuevo, elige su comuna en el mapa de Chile o en su región.
      </p>
      <ErrorNote>{error}</ErrorNote>
      <Card>
        <div role="radiogroup" aria-label="Estado" className="flex flex-wrap gap-1 mb-4">
          {(['ALL', ...TENANT_STATUSES] as const).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={`h-8 px-3 rounded-ctl text-sm border ${filter === f ? 'bg-surface-2 border-line-strong text-ink' : 'border-line text-ink-muted hover:text-ink'}`}
            >
              {f === 'ALL' ? 'Todos' : SERVICE_STATUS[f]}
            </button>
          ))}
        </div>
        {!items ? (
          <Loading />
        ) : shown.length === 0 ? (
          <p className="text-sm text-ink-muted">Ninguno.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-muted text-left">
                <tr>
                  <th className="py-2 pr-3 font-normal">Municipio</th>
                  <th className="py-2 pr-3 font-normal">Estado</th>
                  <th className="py-2 pr-3 font-normal">Comuna</th>
                  <th className="py-2 pr-3 font-normal">Región</th>
                  <th className="py-2 pr-3 font-normal">En servicio desde</th>
                  <th className="py-2 pr-3 font-normal text-right">Alertas 30 d</th>
                  <th className="py-2 font-normal text-right">Abiertas</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id} className="border-t border-line hover:bg-surface-2">
                    <td className="py-2 pr-3">
                      <Link href={`/municipio/${t.id}`} className="text-accent hover:underline">
                        {t.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">
                      <StatusTag status={t.status} />
                    </td>
                    <td className="py-2 pr-3">{t.comunaName ?? <span className="text-ink-faint">límite propio</span>}</td>
                    <td className="py-2 pr-3 text-ink-muted">{t.regionName ?? '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{formatDate(t.goLiveAt)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{t.alertsMonth}</td>
                    <td className="py-2 text-right tabular-nums">{t.openAlerts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Shell>
  );
}
