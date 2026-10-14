'use client';

import { useMemo, useState } from 'react';
import type { Unit, UnitStatus } from '@guardia/shared';
import { api } from '@/lib/api';
import { UNIT_STATUS } from '@/lib/labels';
import { useStore } from '@/lib/store';

/** Chips de unidades sobre el mapa. Un clic alterna disponible / fuera de servicio; ocupada no se toca aquí. */
export function UnitsBar() {
  const units = useStore((s) => s.units);
  const upsertUnit = useStore((s) => s.upsertUnit);
  const notify = useStore((s) => s.notify);
  const canOperate = useStore((s) => s.viewer?.canOperate ?? true);
  const [busy, setBusy] = useState<string | null>(null);
  const list = useMemo(() => Object.values(units).sort((a, b) => a.code.localeCompare(b.code)), [units]);

  const toggle = async (u: Unit) => {
    if (u.status === 'BUSY' || !canOperate) return;
    const next: UnitStatus = u.status === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE';
    setBusy(u.id);
    try {
      upsertUnit(await api.updateUnit(u.id, next));
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (list.length === 0) return null;
  return (
    <div className="absolute left-3 bottom-3 z-[500] flex flex-wrap gap-1.5 max-w-[70%]" aria-label="Unidades">
      {list.map((u) => {
        const tone =
          u.status === 'AVAILABLE' ? 'border-accent/60 text-accent bg-bg/90' : u.status === 'BUSY' ? 'border-medium/60 text-medium bg-bg/90' : 'border-line text-ink-faint bg-bg/90';
        return (
          <button
            key={u.id}
            onClick={() => toggle(u)}
            disabled={u.status === 'BUSY' || busy === u.id || !canOperate}
            title={
              u.status === 'BUSY'
                ? 'Ocupada en un despacho'
                : !canOperate
                  ? UNIT_STATUS[u.status]
                  : u.status === 'AVAILABLE'
                    ? 'Marcar fuera de servicio'
                    : 'Marcar disponible'
            }
            className={`h-7 px-2.5 rounded-ctl border text-xs backdrop-blur-sm ${tone} disabled:cursor-default`}
          >
            {u.code} · {UNIT_STATUS[u.status]}
          </button>
        );
      })}
    </div>
  );
}
