import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Contact, ContactInputParsed, UpdateContactParsed } from '@guardia/shared';
import { AuditService } from '../auth/audit.service';
import type { OperatorClaims } from '../auth/auth.guard';
import { AppError } from '../common/app-error';
import { DbService } from '../db/db.service';
import { contact } from '../db/schema';

type ContactRow = typeof contact.$inferSelect;

const EDITABLE = [
  'category',
  'name',
  'organization',
  'phone',
  'phoneAlt',
  'email',
  'sector',
  'notes',
  'available24h',
  'sortOrder',
  'active',
] as const;

/**
 * Directorio de contactos del municipio (comisarías, SAMU, bomberos, servicios, juntas de vecinos).
 * Exclusivo del tenant por RLS. Todos los operadores lo leen; ADMIN y SUPERVISOR lo mantienen.
 * No se borra: se desactiva, para que la bitácora siga apuntando a algo legible.
 */
@Injectable()
export class ContactsService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
  ) {}

  list(op: OperatorClaims, includeInactive: boolean): Promise<Contact[]> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const rows = await tx
        .select()
        .from(contact)
        .where(includeInactive ? eq(contact.tenantId, op.tenantId) : and(eq(contact.tenantId, op.tenantId), eq(contact.active, true)))
        .orderBy(asc(contact.category), asc(contact.sortOrder), asc(contact.name));
      return rows.map(toContact);
    });
  }

  create(op: OperatorClaims, body: ContactInputParsed): Promise<Contact> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [r] = await tx
        .insert(contact)
        .values({
          tenantId: op.tenantId,
          category: body.category,
          name: body.name,
          organization: body.organization ?? null,
          phone: body.phone,
          phoneAlt: body.phoneAlt ?? null,
          email: body.email ?? null,
          sector: body.sector ?? null,
          notes: body.notes ?? null,
          available24h: body.available24h,
          sortOrder: body.sortOrder,
          createdBy: op.sub,
        })
        .returning();
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: 'CONTACT_CREATED',
        targetId: r.id,
        payload: { name: r.name, category: r.category },
      });
      return toContact(r);
    });
  }

  update(op: OperatorClaims, id: string, body: UpdateContactParsed): Promise<Contact> {
    return this.dbs.asOperator(op.tenantId, op.sub, async (tx) => {
      const [before] = await tx.select().from(contact).where(eq(contact.id, id)).limit(1);
      if (!before) throw new AppError('NOT_FOUND', 'Contacto no encontrado');
      const set: Record<string, unknown> = { updatedAt: new Date() };
      const changed: string[] = [];
      for (const k of EDITABLE) {
        const v = body[k];
        if (v !== undefined && v !== before[k]) {
          set[k] = v;
          changed.push(k);
        }
      }
      if (changed.length === 0) return toContact(before);
      const [r] = await tx.update(contact).set(set).where(eq(contact.id, id)).returning();
      const removed = before.active && body.active === false;
      await this.audit.record(tx, {
        tenantId: op.tenantId,
        actorId: op.sub,
        kind: removed ? 'CONTACT_REMOVED' : 'CONTACT_UPDATED',
        targetId: id,
        payload: { name: r.name, category: r.category, changed },
      });
      return toContact(r);
    });
  }

  remove(op: OperatorClaims, id: string): Promise<Contact> {
    return this.update(op, id, { active: false });
  }
}

function toContact(r: ContactRow): Contact {
  return {
    id: r.id,
    category: r.category,
    name: r.name,
    organization: r.organization,
    phone: r.phone,
    phoneAlt: r.phoneAlt,
    email: r.email,
    sector: r.sector,
    notes: r.notes,
    available24h: r.available24h,
    sortOrder: r.sortOrder,
    active: r.active,
    updatedAt: r.updatedAt.toISOString(),
  };
}
