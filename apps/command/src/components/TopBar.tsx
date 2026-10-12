'use client';

import { Volume2, VolumeX, LogOut } from 'lucide-react';
import type { TypeFilter } from '@/lib/store';
import { useStore } from '@/lib/store';
import { Button } from './ui';

const FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'ALL', label: 'Todo' },
  { value: 'EMERGENCY_SOS', label: 'SOS' },
  { value: 'CIVIC_REPORT', label: 'Urbano' },
];

export function TopBar({ tenantName, operatorName, onLogout }: { tenantName: string; operatorName: string; onLogout: () => void }) {
  const connection = useStore((s) => s.connection);
  const typeFilter = useStore((s) => s.typeFilter);
  const setTypeFilter = useStore((s) => s.setTypeFilter);
  const showClosed = useStore((s) => s.showClosed);
  const setShowClosed = useStore((s) => s.setShowClosed);
  const sound = useStore((s) => s.prefs.sound);
  const setSound = useStore((s) => s.setSound);

  const dot = connection === 'online' ? 'bg-ok' : connection === 'connecting' ? 'bg-medium' : 'bg-high';
  const connLabel = connection === 'online' ? 'En línea' : connection === 'connecting' ? 'Conectando' : 'Sin conexión';

  return (
    <header className="h-12 shrink-0 flex items-center gap-4 px-4 border-b border-line bg-surface">
      <div className="flex items-center gap-2 min-w-0">
        <img src="/brand-mark.png" alt="" width={26} height={26} className="shrink-0" />
        <span className="font-bold tracking-wide whitespace-nowrap">
          GUARD<span className="text-accent">-IA</span>
        </span>
        <span className="text-ink-muted truncate">{tenantName}</span>
      </div>

      <div className="flex items-center gap-2 text-sm" aria-live="polite">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-ink-muted">{connLabel}</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div role="radiogroup" aria-label="Tipo de alerta" className="flex rounded-ctl border border-line overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="radio"
              aria-checked={typeFilter === f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`h-8 px-3 text-sm ${typeFilter === f.value ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-[var(--color-accent)]" />
          Cerradas
        </label>
        <Button variant="ghost" aria-label={sound ? 'Silenciar avisos' : 'Activar avisos'} onClick={() => setSound(!sound)} className="h-8 px-2">
          {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </Button>
        <span className="text-sm text-ink-muted hidden md:inline">{operatorName}</span>
        <Button variant="ghost" aria-label="Cerrar sesión" onClick={onLogout} className="h-8 px-2">
          <LogOut size={16} />
        </Button>
      </div>
    </header>
  );
}
