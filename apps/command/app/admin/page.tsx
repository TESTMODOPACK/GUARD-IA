'use client';

import { ADMIN_RANGES, type AdminOverview, type AdminRange } from '@guardia/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { AI_STATUS, CATEGORY, formatDateTime, formatDuration, REJECT_REASON, ROLE, STATUS } from '@/lib/labels';
import { AdminShell, Card, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Spinner, Tag } from '@/components/ui';

const RANGE_LABEL: Record<AdminRange, string> = { '24h': 'Últimas 24 h', '7d': '7 días', '30d': '30 días' };
const REFRESH_MS = 30_000;

/** Panel del administrador: lo que pasa ahora y la actividad del período. Se actualiza cada 30 s. */
export default function AdminPanelPage() {
  const session = useOperatorSession(['ADMIN', 'SUPERVISOR']);
  const [range, setRange] = useState<AdminRange>('7d');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.overview(range));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : 'No se pudo cargar el panel.');
    }
  }, [range]);

  useEffect(() => {
    if (!session) return;
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [session, load]);

  if (!session) return null;

  const rangePicker = (
    <div role="radiogroup" aria-label="Período" className="flex rounded-ctl border border-line overflow-hidden">
      {ADMIN_RANGES.map((r) => (
        <button
          key={r}
          role="radio"
          aria-checked={range === r}
          onClick={() => setRange(r)}
          className={`h-8 px-3 text-sm ${range === r ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink'}`}
        >
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );

  return (
    <AdminShell session={session} title="Panel de la central" actions={rangePicker}>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {!data ? (
        <p className="text-sm text-ink-muted flex items-center gap-2">
          <Spinner /> Cargando actividad
        </p>
      ) : (
        <Overview data={data} />
      )}
    </AdminShell>
  );
}

function Overview({ data }: { data: AdminOverview }) {
  const sosResp = data.response.find((r) => r.type === 'EMERGENCY_SOS');
  const civicResp = data.response.find((r) => r.type === 'CIVIC_REPORT');
  const falseAlarms = data.rejections.find((r) => r.reason === 'FALSE_ALARM')?.count ?? 0;
  const unitsTotal = Object.values(data.now.units).reduce((a, b) => a + b, 0);
  const oldest = data.now.oldestPendingSeconds;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">Ahora</h2>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Kpi
            label="Sin acusar"
            value={data.now.open.PENDING}
            tone={data.now.open.PENDING > 0 ? 'high' : 'neutral'}
            hint={oldest !== null ? `La más antigua espera ${formatDuration(oldest)}` : 'Ninguna esperando'}
          />
          <Kpi label="En revisión" value={data.now.open.ACKNOWLEDGED} />
          <Kpi label="Con unidad despachada" value={data.now.open.DISPATCHED} tone="accent" />
          <Kpi
            label="Unidades disponibles"
            value={`${data.now.units.AVAILABLE} / ${unitsTotal}`}
            hint={`${data.now.units.BUSY} ocupadas · ${data.now.units.OFFLINE} fuera de servicio`}
          />
          <Kpi
            label="Operadores de turno"
            value={data.now.operatorsOnShift}
            tone={data.now.operatorsOnShift === 0 ? 'high' : 'neutral'}
            hint={data.now.operatorsOnShift === 0 ? 'Nadie marcó inicio de turno' : undefined}
          />
          <Kpi label="Con la central abierta" value={data.now.operatorsOnline} />
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">Período · desde {formatDateTime(data.from)}</h2>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="SOS recibidos" value={data.totals.sos} tone="high" />
          <Kpi label="Reportes urbanos" value={data.totals.civic} />
          <Kpi
            label="Acuse de SOS (mediana)"
            value={formatDuration(sosResp?.ackP50 ?? null)}
            hint={sosResp?.ackP90 != null ? `9 de cada 10 en ${formatDuration(sosResp.ackP90)} o menos` : undefined}
          />
          <Kpi label="Despacho de SOS (mediana)" value={formatDuration(sosResp?.dispatchP50 ?? null)} />
          <Kpi label="Cierre de reportes (mediana)" value={formatDuration(civicResp?.resolveP50 ?? null)} />
          <Kpi
            label="Falsas alarmas"
            value={falseAlarms}
            hint={data.totals.sos ? `${Math.round((falseAlarms / data.totals.sos) * 100)} % de los SOS` : undefined}
          />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={data.bucket === 'hour' ? 'Alertas por hora' : 'Alertas por día'}>
          <SeriesChart data={data} />
        </Card>
        <Card title="Categorías">
          <BarList items={data.byCategory.map((c) => ({ label: CATEGORY[c.category], value: c.count }))} empty="Sin alertas clasificadas en el período." />
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Cómo terminaron">
          <BarList
            items={Object.entries(data.totals.byStatus)
              .filter(([, n]) => n > 0)
              .map(([s, n]) => ({ label: STATUS[s as keyof typeof STATUS], value: n }))}
            empty="Sin alertas en el período."
          />
        </Card>
        <Card title="Motivos de rechazo">
          <BarList items={data.rejections.map((r) => ({ label: REJECT_REASON[r.reason], value: r.count }))} empty="Sin rechazos." />
        </Card>
        <Card title="Análisis de IA">
          <BarList
            items={Object.entries(data.ai)
              .filter(([, n]) => n > 0)
              .map(([s, n]) => ({ label: AI_STATUS[s as keyof typeof AI_STATUS], value: n }))}
            empty="Sin alertas en el período."
          />
        </Card>
      </div>

      <Card title="Equipo">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-xs text-ink-muted border-b border-line">
                <th className="py-2 pr-3 font-medium">Nombre</th>
                <th className="py-2 pr-3 font-medium">Rol</th>
                <th className="py-2 pr-3 font-medium">Estado</th>
                <th className="py-2 pr-3 font-medium">Último ingreso</th>
                <th className="py-2 pr-3 font-medium text-right">Acuses</th>
                <th className="py-2 pr-3 font-medium text-right">Despachos</th>
                <th className="py-2 pr-3 font-medium text-right">Resueltas</th>
                <th className="py-2 pr-3 font-medium text-right">Rechazos</th>
                <th className="py-2 font-medium text-right">Notas</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.operators.map((o) => (
                <tr key={o.id} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-3">{o.name}</td>
                  <td className="py-2 pr-3 text-ink-muted">{ROLE[o.role]}</td>
                  <td className="py-2 pr-3">
                    <span className="inline-flex gap-1.5">
                      {o.onShift ? <Tag tone="ok">De turno</Tag> : null}
                      {o.online ? <Tag tone="accent">Conectado</Tag> : null}
                      {!o.onShift && !o.online ? <span className="text-ink-faint">—</span> : null}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-ink-muted">{o.lastLoginAt ? formatDateTime(o.lastLoginAt) : 'Nunca'}</td>
                  <td className="py-2 pr-3 text-right">{o.acks}</td>
                  <td className="py-2 pr-3 text-right">{o.dispatches}</td>
                  <td className="py-2 pr-3 text-right">{o.resolves}</td>
                  <td className="py-2 pr-3 text-right">{o.rejects}</td>
                  <td className="py-2 text-right">{o.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Kpi({ label, value, hint, tone = 'neutral' }: { label: string; value: string | number; hint?: string; tone?: 'neutral' | 'high' | 'accent' }) {
  const color = tone === 'high' ? 'text-high' : tone === 'accent' ? 'text-accent' : 'text-ink';
  return (
    <div className="rounded-lg border border-line bg-surface p-3 min-w-0">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-ink-faint leading-snug">{hint}</div> : null}
    </div>
  );
}

function BarList({ items, empty }: { items: { label: string; value: number }[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <div className="flex justify-between gap-2">
            <span className="truncate">{i.label}</span>
            <span className="tabular-nums text-ink-muted">{i.value}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div className="h-full rounded-full bg-accent" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Barras apiladas SOS (rojo) + urbanos (azul) por hora o día, en la hora local del navegador. */
function SeriesChart({ data }: { data: AdminOverview }) {
  const max = Math.max(...data.series.map((s) => s.sos + s.civic), 1);
  const fmt = new Intl.DateTimeFormat('es-CL', data.bucket === 'hour' ? { hour: '2-digit', hour12: false } : { day: 'numeric', month: 'short' });
  const step = Math.ceil(data.series.length / 8);
  return (
    <div>
      <div className="flex items-center gap-4 text-xs text-ink-muted mb-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-high" /> SOS
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent" /> Reportes urbanos
        </span>
        <span className="ml-auto tabular-nums">máximo {max} por barra</span>
      </div>
      <div className="h-44 flex items-end gap-[3px] border-b border-line" role="img" aria-label="Alertas en el período">
        {data.series.map((s) => {
          const total = s.sos + s.civic;
          return (
            <div
              key={s.bucket}
              className="flex-1 min-w-0 h-full flex flex-col justify-end"
              title={`${fmt.format(new Date(s.bucket))}: ${s.sos} SOS, ${s.civic} urbanos`}
            >
              <div className="w-full flex flex-col" style={{ height: `${(total / max) * 100}%` }}>
                {s.sos ? <div className="w-full bg-high rounded-t-sm" style={{ flexGrow: s.sos }} /> : null}
                {s.civic ? <div className={`w-full bg-accent ${s.sos ? '' : 'rounded-t-sm'}`} style={{ flexGrow: s.civic }} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-[3px] mt-1">
        {data.series.map((s, i) => (
          <div key={s.bucket} className="flex-1 min-w-0 text-[10px] text-ink-faint text-center truncate">
            {i % step === 0 ? fmt.format(new Date(s.bucket)) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
