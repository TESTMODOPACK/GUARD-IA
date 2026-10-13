'use client';

import type { CaseActivity, SystemActivity } from '@guardia/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  AUDIT_KIND,
  CATEGORY,
  CONTACT_CATEGORY,
  DISPATCH_STATUS,
  EVENT_KIND,
  formatDateTime,
  REJECT_REASON,
  ROLE,
  SOURCE,
  UNIT_STATUS,
} from '@/lib/labels';
import { AdminShell, Card, errText, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Button, Spinner } from '@/components/ui';

type Source = 'cases' | 'system';
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

const ACTOR: Record<CaseActivity['actorType'], string> = { CITIZEN: 'Vecino', OPERATOR: 'Operador', SYSTEM: 'Sistema', AI: 'IA' };

/** Detalle legible de un evento de caso. El contenido del vecino nunca se muestra aquí. */
function caseDetail(e: CaseActivity): string {
  const p = e.payload;
  switch (e.kind) {
    case 'CREATED':
      return `${e.alertType === 'EMERGENCY_SOS' ? 'SOS' : 'Reporte urbano'}${p.source ? ` por ${SOURCE[p.source as keyof typeof SOURCE] ?? str(p.source)}` : ''}`;
    case 'NOTE':
      return str(p.text);
    case 'REJECTED':
      return `${REJECT_REASON[p.reason as keyof typeof REJECT_REASON] ?? str(p.reason)}${p.notes ? ` · ${str(p.notes)}` : ''}`;
    case 'DISPATCHED':
      return `Unidad ${str(p.unitCode)}${p.notes ? ` · ${str(p.notes)}` : ''}`;
    case 'DISPATCH_STATUS':
      return `Unidad ${str(p.unitCode)}: ${DISPATCH_STATUS[p.status as keyof typeof DISPATCH_STATUS] ?? str(p.status)}`;
    case 'RESOLVED':
      return str(p.notes);
    case 'CANCELLED':
      return p.secondsAfterCreate !== undefined ? `a los ${str(p.secondsAfterCreate)} s` : '';
    case 'PUSH_SENT':
      return p.ok === false ? 'no se pudo entregar' : `${str(p.devices)} dispositivo(s)`;
    default:
      return '';
  }
}

function systemDetail(e: SystemActivity): string {
  const p = e.payload;
  switch (e.kind) {
    case 'LOGIN':
    case 'LOGIN_FAILED':
      return [p.email ? str(p.email) : '', p.ip ? `desde ${str(p.ip)}` : ''].filter(Boolean).join(' ');
    case 'OPERATOR_CREATED':
      return `${str(p.name)} (${str(p.email)}) · ${ROLE[p.role as keyof typeof ROLE] ?? str(p.role)}`;
    case 'OPERATOR_UPDATED': {
      const changes = (p.changes ?? {}) as Record<string, [unknown, unknown]>;
      const parts = Object.entries(changes).map(([k, [, to]]) =>
        k === 'active' ? (to ? 'activada' : 'desactivada') : k === 'role' ? `rol ${ROLE[to as keyof typeof ROLE] ?? str(to)}` : `nombre "${str(to)}"`,
      );
      return `${str(p.email)}: ${parts.join(', ')}`;
    }
    case 'PASSWORD_RESET':
      return str(p.email);
    case 'SHIFT_PLANNED':
      return `${str(p.operatorName)} · ${p.plannedStart ? formatDateTime(str(p.plannedStart)) : ''}`;
    case 'SHIFT_REMOVED':
      return `${str(p.operatorName)}${p.plannedStart ? ` · ${formatDateTime(str(p.plannedStart))}` : ''}`;
    case 'SHIFT_STARTED':
      return p.planned ? 'turno programado' : 'sin programar';
    case 'SHIFT_ENDED':
      return p.withHandover ? 'con nota de entrega' : 'sin nota de entrega';
    case 'UNIT_CREATED':
    case 'UNIT_UPDATED':
      return [str(p.code), p.status ? UNIT_STATUS[p.status as keyof typeof UNIT_STATUS] : ''].filter(Boolean).join(' · ');
    case 'CONTACT_CREATED':
    case 'CONTACT_UPDATED':
    case 'CONTACT_REMOVED':
      return `${str(p.name)} · ${CONTACT_CATEGORY[p.category as keyof typeof CONTACT_CATEGORY] ?? str(p.category)}`;
    default:
      return '';
  }
}

/** Bitácora: todo lo que pasó en los casos y en el sistema, lo más reciente primero. Solo lectura. */
export default function LogPage() {
  const session = useOperatorSession(['ADMIN', 'SUPERVISOR']);
  const [source, setSource] = useState<Source>('system');
  const [items, setItems] = useState<(CaseActivity | SystemActivity)[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback((src: Source, c?: string) => (src === 'cases' ? api.caseActivity(c) : api.systemActivity(c)), []);

  useEffect(() => {
    if (!session) return;
    let live = true;
    setItems(null);
    fetchPage(source)
      .then((p) => {
        if (!live) return;
        setItems(p.items);
        setCursor(p.nextCursor);
        setError(null);
      })
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [session, source, fetchPage]);

  if (!session) return null;

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const p = await fetchPage(source, cursor);
      setItems((x) => [...(x ?? []), ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const tabs = (
    <div role="tablist" aria-label="Bitácora" className="flex rounded-ctl border border-line overflow-hidden">
      {(
        [
          ['system', 'Sistema'],
          ['cases', 'Casos'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={source === id}
          onClick={() => setSource(id)}
          className={`h-8 px-3 text-sm ${source === id ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <AdminShell session={session} title="Bitácora" actions={tabs}>
      <p className="text-sm text-ink-muted -mt-3">
        {source === 'system'
          ? 'Ingresos, intentos fallidos, cambios de usuarios, turnos, unidades y contactos. No se puede editar ni borrar.'
          : 'Cada acción sobre las alertas: quién la hizo y cuándo. No se puede editar ni borrar.'}
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card>
        {!items ? (
          <p className="text-sm text-ink-muted flex items-center gap-2">
            <Spinner /> Cargando bitácora
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-muted">Sin registros todavía.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-xs text-ink-muted border-b border-line">
                  <th className="py-2 pr-3 font-medium w-36">Fecha</th>
                  <th className="py-2 pr-3 font-medium w-44">Quién</th>
                  <th className="py-2 pr-3 font-medium">Qué</th>
                  {source === 'cases' ? <th className="py-2 pr-3 font-medium">Caso</th> : null}
                  <th className="py-2 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) =>
                  'alertId' in e ? (
                    <tr key={e.id} className="border-b border-line/60 last:border-0 align-top">
                      <td className="py-2 pr-3 tabular-nums text-ink-muted whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                      <td className="py-2 pr-3">{e.actorName ?? ACTOR[e.actorType]}</td>
                      <td className="py-2 pr-3">{EVENT_KIND[e.kind]}</td>
                      <td className="py-2 pr-3 text-ink-muted">
                        {e.category ? CATEGORY[e.category] : e.alertType === 'EMERGENCY_SOS' ? 'SOS' : 'Reporte'}
                        <span className="text-ink-faint font-mono text-xs"> #{e.alertId.slice(0, 8)}</span>
                      </td>
                      <td className="py-2 text-ink-muted break-words">{caseDetail(e)}</td>
                    </tr>
                  ) : (
                    <tr key={e.id} className={`border-b border-line/60 last:border-0 align-top ${e.kind === 'LOGIN_FAILED' ? 'text-medium' : ''}`}>
                      <td className="py-2 pr-3 tabular-nums text-ink-muted whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                      <td className="py-2 pr-3">{e.actorName ?? '—'}</td>
                      <td className="py-2 pr-3">{AUDIT_KIND[e.kind]}</td>
                      <td className="py-2 text-ink-muted break-words">{systemDetail(e)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        {cursor ? (
          <div className="mt-4 flex justify-center">
            <Button variant="quiet" busy={loadingMore} onClick={() => void more()}>
              Cargar más
            </Button>
          </div>
        ) : null}
      </Card>
    </AdminShell>
  );
}
