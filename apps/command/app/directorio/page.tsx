'use client';

import { CONTACT_CATEGORIES, type Contact, type ContactCategory, type ContactInput } from '@guardia/shared';
import { Pencil, Phone, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { CONTACT_CATEGORY } from '@/lib/labels';
import { AdminShell, Card, ConfirmDialog, errText, isManager, Notice, useOperatorSession } from '@/components/admin/AdminShell';
import { Button, Dialog, Field, inputClass, Spinner, Tag, textareaClass } from '@/components/ui';

/** Para buscar sin tildes ni mayúsculas: "comisaria" encuentra "Comisaría". */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Directorio de contactos del municipio: a quién llamar para derivar un caso. Exclusivo de este
 * municipio. Todos lo consultan; administrador y supervisor lo mantienen.
 */
export default function DirectoryPage() {
  const session = useOperatorSession();
  const manager = isManager(session);
  const [list, setList] = useState<Contact[] | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ContactCategory | 'ALL'>('ALL');
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'form'; contact?: Contact } | { kind: 'remove'; contact: Contact } | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.contacts(manager && showInactive));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [manager, showInactive]);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  const groups = useMemo(() => {
    const q = norm(query.trim());
    const filtered = (list ?? []).filter(
      (c) =>
        (category === 'ALL' || c.category === category) &&
        (!q || norm([c.name, c.organization, c.sector, c.notes, c.phone].filter(Boolean).join(' ')).includes(q)),
    );
    return CONTACT_CATEGORIES.map((cat) => ({ cat, items: filtered.filter((c) => c.category === cat) })).filter((g) => g.items.length);
  }, [list, query, category]);

  if (!session) return null;

  const done = (text: string) => {
    setDialog(null);
    setNotice(text);
    void load();
  };

  return (
    <AdminShell
      session={session}
      title="Directorio de contactos"
      actions={
        manager ? (
          <Button variant="primary" onClick={() => setDialog({ kind: 'form' })}>
            <Plus size={16} /> Nuevo contacto
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-ink-muted -mt-3">
        Contactos de {session.operator.tenantName} para derivar casos. Los números de emergencia nacionales (133, 131, 132) siempre funcionan aunque no estén aquí.
      </p>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex-1 min-w-60">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input
            className={`${inputClass} pl-9`}
            placeholder="Buscar por nombre, sector o número"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar contacto"
          />
        </label>
        <select className={`${inputClass} w-auto`} value={category} onChange={(e) => setCategory(e.target.value as ContactCategory | 'ALL')} aria-label="Categoría">
          <option value="ALL">Todas las categorías</option>
          {CONTACT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CONTACT_CATEGORY[c]}
            </option>
          ))}
        </select>
        {manager ? (
          <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="accent-[var(--color-accent)]" />
            Mostrar desactivados
          </label>
        ) : null}
      </div>

      {!list ? (
        <p className="text-sm text-ink-muted flex items-center gap-2">
          <Spinner /> Cargando directorio
        </p>
      ) : groups.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            {list.length === 0
              ? manager
                ? 'El directorio está vacío. Agrega la comisaría, el SAMU, bomberos y los contactos municipales con "Nuevo contacto".'
                : 'El directorio está vacío. Pide a tu supervisor que agregue los contactos del municipio.'
              : 'Ningún contacto coincide con la búsqueda.'}
          </p>
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.cat} title={CONTACT_CATEGORY[g.cat]}>
            <ul className="divide-y divide-line/70">
              {g.items.map((c) => (
                <li key={c.id} className={`py-2.5 flex flex-wrap items-start gap-x-4 gap-y-1 ${c.active ? '' : 'opacity-60'}`}>
                  <div className="min-w-56 flex-1">
                    <div className="text-sm font-medium flex flex-wrap items-center gap-2">
                      {c.name}
                      {c.available24h ? <Tag tone="ok">24 h</Tag> : null}
                      {!c.active ? <Tag>Desactivado</Tag> : null}
                    </div>
                    <div className="text-xs text-ink-muted">{[c.organization, c.sector].filter(Boolean).join(' · ')}</div>
                    {c.notes ? <div className="text-xs text-ink-faint mt-0.5 whitespace-pre-wrap">{c.notes}</div> : null}
                  </div>
                  <div className="text-sm tabular-nums space-y-0.5">
                    <PhoneLink phone={c.phone} />
                    {c.phoneAlt ? <PhoneLink phone={c.phoneAlt} /> : null}
                    {c.email ? <div className="text-xs text-ink-muted select-all">{c.email}</div> : null}
                  </div>
                  {manager ? (
                    <div className="flex gap-1">
                      <Button variant="ghost" className="h-8 px-2" aria-label={`Editar ${c.name}`} onClick={() => setDialog({ kind: 'form', contact: c })}>
                        <Pencil size={15} />
                      </Button>
                      {c.active ? (
                        <Button variant="ghost" className="h-8 px-2 text-sm" onClick={() => setDialog({ kind: 'remove', contact: c })}>
                          Desactivar
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          className="h-8 px-2 text-sm"
                          onClick={async () => {
                            try {
                              await api.updateContact(c.id, { active: true });
                              done(`${c.name} vuelve a estar en el directorio.`);
                            } catch (e) {
                              setError(errText(e));
                            }
                          }}
                        >
                          Reactivar
                        </Button>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}

      {dialog?.kind === 'form' ? (
        <ContactForm
          contact={dialog.contact}
          onClose={() => setDialog(null)}
          onDone={(c) => done(dialog.contact ? `Se guardó ${c.name}.` : `${c.name} quedó en el directorio.`)}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <ConfirmDialog
          title={`Desactivar ${dialog.contact.name}`}
          confirmLabel="Desactivar"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.removeContact(dialog.contact.id);
            done(`${dialog.contact.name} ya no aparece en el directorio.`);
          }}
        >
          Deja de aparecer para los operadores. Puedes reactivarlo después desde &quot;Mostrar desactivados&quot;.
        </ConfirmDialog>
      ) : null}
    </AdminShell>
  );
}

/** El número se muestra siempre como texto copiable; el enlace tel: sirve si el equipo tiene telefonía. */
function PhoneLink({ phone }: { phone: string }) {
  return (
    <a href={`tel:${phone.replace(/[^+0-9]/g, '')}`} className="inline-flex items-center gap-1.5 hover:text-accent select-all">
      <Phone size={13} className="text-ink-faint" aria-hidden /> {phone}
    </a>
  );
}

function ContactForm({ contact, onClose, onDone }: { contact?: Contact; onClose: () => void; onDone: (c: Contact) => void }) {
  const [v, setV] = useState<ContactInput>({
    category: contact?.category ?? 'CARABINEROS',
    name: contact?.name ?? '',
    organization: contact?.organization ?? '',
    phone: contact?.phone ?? '',
    phoneAlt: contact?.phoneAlt ?? '',
    email: contact?.email ?? '',
    sector: contact?.sector ?? '',
    notes: contact?.notes ?? '',
    available24h: contact?.available24h ?? false,
    sortOrder: contact?.sortOrder ?? 100,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ContactInput>(k: K, val: ContactInput[K]) => setV((x) => ({ ...x, [k]: val }));
  const ready = v.name.trim().length >= 2 && v.phone.trim().length >= 3;

  return (
    <Dialog title={contact ? `Editar ${contact.name}` : 'Nuevo contacto'} onClose={onClose} busy={busy}>
      <form
        className="space-y-3 max-h-[70vh] overflow-y-auto gi-scroll pr-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          setBusy(true);
          setError(null);
          try {
            onDone(contact ? await api.updateContact(contact.id, v) : await api.createContact(v));
          } catch (err) {
            setError(errText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Categoría">
          <select className={inputClass} value={v.category} onChange={(e) => set('category', e.target.value as ContactCategory)}>
            {CONTACT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CONTACT_CATEGORY[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nombre (p. ej. 3ª Comisaría Centro)">
          <input className={inputClass} value={v.name} onChange={(e) => set('name', e.target.value)} maxLength={120} required />
        </Field>
        <Field label="Institución o persona a cargo (opcional)">
          <input className={inputClass} value={v.organization ?? ''} onChange={(e) => set('organization', e.target.value)} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Teléfono">
            <input className={inputClass} value={v.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+56 2 2922 0000" maxLength={30} required />
          </Field>
          <Field label="Otro teléfono (opcional)">
            <input className={inputClass} value={v.phoneAlt ?? ''} onChange={(e) => set('phoneAlt', e.target.value)} maxLength={30} />
          </Field>
        </div>
        <Field label="Correo (opcional)">
          <input className={inputClass} type="email" value={v.email ?? ''} onChange={(e) => set('email', e.target.value)} maxLength={160} />
        </Field>
        <Field label="Sector que cubre (opcional)">
          <input className={inputClass} value={v.sector ?? ''} onChange={(e) => set('sector', e.target.value)} placeholder="Centro, Villa Los Aromos…" maxLength={120} />
        </Field>
        <Field label="Notas (opcional)">
          <textarea className={textareaClass} value={v.notes ?? ''} onChange={(e) => set('notes', e.target.value)} maxLength={1000} placeholder="Horario, a quién pedir, anexo…" />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={!!v.available24h} onChange={(e) => set('available24h', e.target.checked)} className="accent-[var(--color-accent)]" />
            Atiende las 24 horas
          </label>
          <label className="flex items-center gap-2 text-sm">
            Orden
            <input
              className={`${inputClass} w-20`}
              type="number"
              min={0}
              max={1000}
              value={v.sortOrder}
              onChange={(e) => set('sortOrder', Number(e.target.value))}
              aria-describedby="orden-ayuda"
            />
          </label>
          <span id="orden-ayuda" className="text-xs text-ink-faint">
            Menor número, más arriba en su categoría.
          </span>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-high">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            {contact ? 'Guardar' : 'Agregar'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
