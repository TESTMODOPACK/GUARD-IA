'use client';

import type { AlertType, Contact, SuggestedAgency } from '@guardia/shared';
import { Phone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CONTACT_CATEGORY, CONTACTS_FOR_AGENCY } from '@/lib/labels';

// El directorio cambia poco: una carga por minuto para todas las fichas que se abran.
let cache: { at: number; list: Promise<Contact[]> } | null = null;
function contacts(): Promise<Contact[]> {
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = { at: Date.now(), list: api.contacts().catch(() => []) };
  }
  return cache.list;
}

/**
 * Contactos del municipio para derivar el caso, según las instituciones sugeridas o ya derivadas,
 * en ese orden (sin sugerencia: seguridad municipal para SOS y obras/servicios para reportes).
 */
export function ContactsHint({ agencies, type }: { agencies: readonly SuggestedAgency[]; type: AlertType }) {
  const [list, setList] = useState<Contact[] | null>(null);
  useEffect(() => {
    let live = true;
    void contacts().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);

  const keys: readonly SuggestedAgency[] = agencies.length ? agencies : [type === 'EMERGENCY_SOS' ? 'SEGURIDAD_MUNICIPAL' : 'OBRAS_ASEO'];
  const wanted = [...new Set(keys.flatMap((k) => CONTACTS_FOR_AGENCY[k]))];
  const matches = (list ?? [])
    .filter((c) => wanted.includes(c.category))
    .sort((a, b) => wanted.indexOf(a.category) - wanted.indexOf(b.category) || Number(b.available24h) - Number(a.available24h) || a.sortOrder - b.sortOrder)
    .slice(0, Math.max(4, keys.length * 2));

  if (!list) return null;

  return (
    <section className="rounded-ctl border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Contactos para derivar</h3>
        <Link href="/directorio" className="text-xs text-accent hover:underline">
          Ver directorio
        </Link>
      </div>
      {matches.length === 0 ? (
        <p className="mt-1.5 text-xs text-ink-muted">
          No hay contactos de {wanted.map((c) => CONTACT_CATEGORY[c]).join(' o ')} en el directorio del municipio.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {matches.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate" title={c.notes ?? undefined}>
                {c.name}
                {c.sector ? <span className="text-ink-faint"> · {c.sector}</span> : null}
              </span>
              <a href={`tel:${c.phone.replace(/[^+0-9]/g, '')}`} className="shrink-0 inline-flex items-center gap-1 tabular-nums hover:text-accent select-all">
                <Phone size={12} className="text-ink-faint" aria-hidden /> {c.phone}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
