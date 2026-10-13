'use client';

import type { PlatformAuditEntry } from '@guardia/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Shell, usePlatformSession } from '@/components/Shell';
import { Button, Card, ErrorNote, Loading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ACTION, formatDateTime, SERVICE_STATUS } from '@/lib/labels';

/** Detalle legible del payload: cambios de estado, correos, teléfonos enmascarados. Siempre como texto. */
function describe(e: PlatformAuditEntry): string {
  const p = e.payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.from === 'string' && typeof p.to === 'string') {
    parts.push(`${SERVICE_STATUS[p.from as keyof typeof SERVICE_STATUS] ?? p.from} → ${SERVICE_STATUS[p.to as keyof typeof SERVICE_STATUS] ?? p.to}`);
  }
  for (const k of ['email', 'name', 'phone', 'label', 'step'] as const) if (typeof p[k] === 'string') parts.push(String(p[k]));
  if (Array.isArray(p.fields)) parts.push(`campos: ${p.fields.join(', ')}`);
  return parts.join(' · ');
}

/** Bitácora de plataforma (RF-8.1): solo inserción, con IP y motivo. */
export default function AuditPage() {
  const session = usePlatformSession();
  const [items, setItems] = useState<PlatformAuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    api
      .audit({ limit: 50 })
      .then((p) => {
        setItems(p.items);
        setCursor(p.nextCursor);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [session]);

  if (!session) return null;

  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const p = await api.audit({ cursor, limit: 50 });
      setItems((prev) => [...(prev ?? []), ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell session={session}>
      <h1 className="text-xl font-semibold mb-1">Bitácora de plataforma</h1>
      <p className="text-sm text-ink-muted mb-5">Todo lo que se hace en esta consola. No se puede editar ni borrar.</p>
      <ErrorNote>{error}</ErrorNote>
      <Card>
        {!items ? (
          <Loading />
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin movimientos.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-muted text-left">
                <tr>
                  <th className="py-2 pr-3 font-normal">Fecha</th>
                  <th className="py-2 pr-3 font-normal">Quién</th>
                  <th className="py-2 pr-3 font-normal">Acción</th>
                  <th className="py-2 pr-3 font-normal">Municipio</th>
                  <th className="py-2 pr-3 font-normal">Detalle</th>
                  <th className="py-2 font-normal">IP</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-ink-muted">{formatDateTime(e.createdAt)}</td>
                    <td className="py-2 pr-3">{e.actorName ?? <span className="text-ink-faint">Sistema</span>}</td>
                    <td className="py-2 pr-3">{ACTION[e.action]}</td>
                    <td className="py-2 pr-3">
                      {e.tenantId ? (
                        <Link href={`/municipio/${e.tenantId}`} className="text-accent hover:underline">
                          {e.tenantName}
                        </Link>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">
                      {describe(e)}
                      {e.reason ? <div className="text-ink">Motivo: {e.reason}</div> : null}
                    </td>
                    <td className="py-2 font-mono text-xs text-ink-faint">{e.ip ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <div className="pt-4">
            <Button onClick={() => void more()} busy={busy}>
              Cargar más
            </Button>
          </div>
        ) : null}
      </Card>
    </Shell>
  );
}
