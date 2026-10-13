import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import {
  TENANT_TRANSITIONS,
  type ChangeTenantStatus,
  type CreateTenant,
  type CreateTenantAdmin,
  type ReadinessItem,
  type TenantAdmin,
  type TenantAdminPassword,
  type TenantDetail,
  type TenantListItem,
  type TenantStatus,
  type TestPhone,
  type TestPhoneInput,
  type UpdateTenant,
} from '@guardia/shared';
import { hashPassword, temporaryPassword } from '../admin/passwords';
import { OperatorStatusService } from '../auth/operator-status.service';
import { TokenService } from '../auth/token.service';
import { AppError } from '../common/app-error';
import { DbService, type Tx } from '../db/db.service';
import { comuna, operator, provincia, region, tenant, tenantTestPhone } from '../db/schema';
import { maskPhone, PlatformAuditService } from './platform-audit.service';
import type { PlatformClaims } from './platform-tokens.service';
import { TENANT_MANAGERS } from './platform.guard';
import { nameKey } from './territory.service';

type OperatorRow = typeof operator.$inferSelect;

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

function toAdmin(o: OperatorRow): TenantAdmin {
  return {
    id: o.id,
    email: o.email,
    name: o.name,
    active: o.active,
    mustChangePassword: o.mustChangePassword,
    lastLoginAt: o.lastLoginAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}

/** Campos de la ficha que la plataforma puede escribir (GRANT UPDATE de 0010). */
const PROFILE_FIELDS = [
  'name',
  'audioRetentionDays',
  'legalName',
  'rut',
  'address',
  'techContactName',
  'techContactEmail',
  'techContactPhone',
  'billingContactName',
  'billingContactEmail',
  'contractSignedAt',
  'dpaSignedAt',
] as const;

const STATUS_ORDER: Record<TenantStatus, number> = { ONBOARDING: 0, ACTIVE: 1, SUSPENDED: 2, TERMINATED: 3 };

/**
 * Municipios desde la consola (RF-3.x, RF-4.2/4.3). Todo en contexto `platform`: ve la ficha de cualquier
 * municipio y solo las cuentas de administrador. El alta y los cambios de estado pasan por funciones de la
 * base (create_tenant, set_tenant_status), que validan transiciones y la lista de puesta en marcha. Cada
 * acción queda en la bitácora de plataforma y, si toca al municipio, en la suya.
 */
@Injectable()
export class PlatformTenantsService {
  private readonly logger = new Logger(PlatformTenantsService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly audit: PlatformAuditService,
    private readonly operatorStatus: OperatorStatusService,
    private readonly operatorTokens: TokenService,
  ) {}

  private baseQuery(tx: Tx) {
    return tx
      .select({ t: tenant, comunaName: comuna.name, regionCut: region.cut, regionName: region.name, provinciaName: provincia.name })
      .from(tenant)
      .leftJoin(comuna, eq(comuna.cut, tenant.comunaCut))
      .leftJoin(region, eq(region.cut, comuna.regionCut))
      .leftJoin(provincia, eq(provincia.cut, comuna.provinciaCut));
  }

  private async activity(tx: Tx): Promise<Map<string, { alerts: number; sos: number; open: number }>> {
    const rows = (await tx.execute(sql`
      SELECT tenant_id, alerts::int AS alerts, sos::int AS sos, open_alerts::int AS open
        FROM platform_tenant_activity(now() - interval '30 days')`)) as unknown as {
      tenant_id: string;
      alerts: number;
      sos: number;
      open: number;
    }[];
    return new Map(rows.map((r) => [r.tenant_id, r]));
  }

  list(user: PlatformClaims): Promise<TenantListItem[]> {
    return this.dbs.asPlatform(user.sub, async (tx) => {
      const rows = await this.baseQuery(tx).orderBy(asc(region.cut), asc(tenant.name));
      const act = await this.activity(tx);
      return rows
        .map((r) => ({
          id: r.t.id,
          name: r.t.name,
          slug: r.t.slug,
          status: r.t.status,
          comunaCut: r.t.comunaCut,
          comunaName: r.comunaName,
          regionCut: r.regionCut,
          regionName: r.regionName,
          statusChangedAt: r.t.statusChangedAt.toISOString(),
          goLiveAt: r.t.goLiveAt?.toISOString() ?? null,
          alertsMonth: act.get(r.t.id)?.alerts ?? 0,
          openAlerts: act.get(r.t.id)?.open ?? 0,
        }))
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    });
  }

  detail(user: PlatformClaims, id: string): Promise<TenantDetail> {
    return this.dbs.asPlatform(user.sub, (tx) => this.detailInTx(tx, user, id));
  }

  private async detailInTx(tx: Tx, user: PlatformClaims, id: string): Promise<TenantDetail> {
    const [r] = await this.baseQuery(tx).where(eq(tenant.id, id)).limit(1);
    if (!r) throw new AppError('NOT_FOUND', 'Municipio no encontrado');
    const act = (await this.activity(tx)).get(id);
    const [{ readiness }] = (await tx.execute(sql`SELECT tenant_readiness(${id}::uuid) AS readiness`)) as unknown as {
      readiness: { ready: boolean; items: ReadinessItem[] };
    }[];
    const admins = await tx
      .select()
      .from(operator)
      .where(and(eq(operator.tenantId, id), eq(operator.role, 'ADMIN')))
      .orderBy(asc(operator.name));
    const phones = await tx
      .select()
      .from(tenantTestPhone)
      .where(eq(tenantTestPhone.tenantId, id))
      .orderBy(asc(tenantTestPhone.createdAt));
    const t = r.t;
    const canManage = TENANT_MANAGERS.includes(user.role);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      comunaCut: t.comunaCut,
      comunaName: r.comunaName,
      regionCut: r.regionCut,
      regionName: r.regionName,
      provinciaName: r.provinciaName,
      statusChangedAt: t.statusChangedAt.toISOString(),
      goLiveAt: t.goLiveAt?.toISOString() ?? null,
      statusReason: t.statusReason,
      legalName: t.legalName,
      rut: t.rut,
      address: t.address,
      techContactName: t.techContactName,
      techContactEmail: t.techContactEmail,
      techContactPhone: t.techContactPhone,
      billingContactName: t.billingContactName,
      billingContactEmail: t.billingContactEmail,
      contractSignedAt: t.contractSignedAt,
      dpaSignedAt: t.dpaSignedAt,
      audioRetentionDays: t.audioRetentionDays,
      createdAt: t.createdAt.toISOString(),
      alertsMonth: act?.alerts ?? 0,
      sosMonth: act?.sos ?? 0,
      openAlerts: act?.open ?? 0,
      readiness: { ready: readiness.ready, items: readiness.items ?? [] },
      // Lo que este usuario puede hacer ahora; la base vuelve a validarlo.
      transitions: canManage
        ? TENANT_TRANSITIONS[t.status].filter((s) => s !== 'TERMINATED' || user.role === 'SUPERADMIN')
        : [],
      admins: admins.map(toAdmin),
      testPhones: phones.map(
        (p): TestPhone => ({ id: p.id, phone: p.phone, label: p.label, createdAt: p.createdAt.toISOString() }),
      ),
    };
  }

  /** Alta desde una comuna (RF-3.1). Nace en implementación: solo sus teléfonos de prueba llegan a la central. */
  async create(user: PlatformClaims, body: CreateTenant, ip: string): Promise<TenantDetail> {
    try {
      return await this.dbs.asPlatform(user.sub, async (tx) => {
        const [c] = await tx.select().from(comuna).where(eq(comuna.cut, body.comunaCut)).limit(1);
        if (!c) throw new AppError('NOT_FOUND', 'Comuna no encontrada');
        const [current] = await tx
          .select({ id: tenant.id, name: tenant.name })
          .from(tenant)
          .where(and(eq(tenant.comunaCut, c.cut), ne(tenant.status, 'TERMINATED')))
          .limit(1);
        if (current) throw new AppError('CONFLICT', `${c.name} ya tiene un municipio en Guard-IA (${current.name})`);

        const base = c.nameKey.replace(/ /g, '-');
        const taken = new Set(
          (await tx.select({ slug: tenant.slug }).from(tenant).where(sql`${tenant.slug} LIKE ${base + '%'}`)).map((x) => x.slug),
        );
        let slug = base;
        for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
        const name = body.name ?? `Municipalidad de ${c.name}`;

        const [{ id }] = (await tx.execute(
          sql`SELECT create_tenant(${c.cut}, ${name}, ${slug}) AS id`,
        )) as unknown as { id: string }[];
        const { name: _name, comunaCut: _cut, ...rest } = body;
        const profile = profileSet(rest);
        if (Object.keys(profile).length) await tx.update(tenant).set(profile).where(eq(tenant.id, id));
        await this.audit.record(tx, {
          actorId: user.sub,
          action: 'TENANT_CREATED',
          tenantId: id,
          comunaCut: c.cut,
          targetId: id,
          payload: { name, slug },
          ip,
        });
        return this.detailInTx(tx, user, id);
      });
    } catch (e) {
      if (pgCode(e) === '23505') throw new AppError('CONFLICT', 'Esa comuna ya tiene un municipio en Guard-IA');
      throw e;
    }
  }

  update(user: PlatformClaims, id: string, body: UpdateTenant, ip: string): Promise<TenantDetail> {
    return this.dbs.asPlatform(user.sub, async (tx) => {
      const set = profileSet(body);
      const [r] = await tx
        .update(tenant)
        .set(set)
        .where(eq(tenant.id, id))
        .returning({ id: tenant.id, comunaCut: tenant.comunaCut });
      if (!r) throw new AppError('NOT_FOUND', 'Municipio no encontrado');
      await this.audit.record(tx, {
        actorId: user.sub,
        action: 'TENANT_UPDATED',
        tenantId: id,
        comunaCut: r.comunaCut,
        targetId: id,
        payload: { fields: Object.keys(set) },
        ip,
      });
      return this.detailInTx(tx, user, id);
    });
  }

  /**
   * Activar, suspender o dar de baja (RF-3.3, 3.5, 3.6). Confirmación con el nombre de la comuna y motivo;
   * dar de baja es solo del superadministrador. Suspender nunca corta el SOS (el ruteo sigue).
   */
  async changeStatus(user: PlatformClaims, id: string, body: ChangeTenantStatus, ip: string): Promise<TenantDetail> {
    if (body.status === 'TERMINATED' && user.role !== 'SUPERADMIN') {
      throw new AppError('FORBIDDEN', 'Solo un superadministrador puede dar de baja un municipio');
    }
    let result: { from: TenantStatus; detail: TenantDetail };
    try {
      result = await this.dbs.asPlatform(user.sub, async (tx) => {
        const [r] = await this.baseQuery(tx).where(eq(tenant.id, id)).limit(1);
        if (!r) throw new AppError('NOT_FOUND', 'Municipio no encontrado');
        const expected = r.comunaName ?? r.t.name;
        if (nameKey(body.confirmName) !== nameKey(expected)) {
          throw new AppError('VALIDATION_ERROR', `Para confirmar escribe "${expected}"`);
        }
        const [res] = (await tx.execute(
          sql`SELECT set_tenant_status(${id}::uuid, ${body.status}::tenant_status, ${body.reason}) AS from_status`,
        )) as unknown as { from_status: TenantStatus }[];
        const change = { from: res.from_status, to: body.status };
        await this.audit.record(tx, {
          actorId: user.sub,
          action: 'TENANT_STATUS_CHANGED',
          tenantId: id,
          comunaCut: r.t.comunaCut,
          targetId: id,
          reason: body.reason,
          payload: change,
          ip,
        });
        await this.audit.recordInTenant(tx, {
          tenantId: id,
          platformActorId: user.sub,
          kind: 'TENANT_STATUS_CHANGED',
          targetId: id,
          payload: { ...change, reason: body.reason },
        });
        return { from: res.from_status, detail: await this.detailInTx(tx, user, id) };
      });
    } catch (e) {
      throw await this.mapStatusError(user, id, e);
    }

    // Después del commit: las cuentas del municipio leen el estado nuevo; de baja, se cierran sus sesiones.
    this.operatorStatus.invalidateAll();
    if (body.status === 'TERMINATED') {
      await this.dbs
        .asSystem((tx) =>
          tx.execute(sql`
            UPDATE refresh_token SET revoked_at = now()
             WHERE revoked_at IS NULL AND operator_id IN (SELECT id FROM operator WHERE tenant_id = ${id}::uuid)`),
        )
        .catch((e: Error) => this.logger.warn(`municipio ${id} de baja: no se cerraron sesiones: ${e.message}`));
    }
    this.logger.log(`municipio ${id}: ${result.from} → ${body.status}`);
    return result.detail;
  }

  private async mapStatusError(user: PlatformClaims, id: string, e: unknown): Promise<unknown> {
    const code = pgCode(e);
    if (code === 'P0002') return new AppError('NOT_FOUND', 'Municipio no encontrado');
    if (code === '55000') return new AppError('INVALID_TRANSITION', 'Ese cambio de estado no está permitido');
    if (code === 'GIA02') {
      return new AppError('CONFLICT', 'No se puede dar de baja con alertas abiertas: la central debe cerrarlas primero');
    }
    if (code === 'GIA01') {
      const d = await this.detail(user, id).catch(() => null);
      return new AppError('CONFLICT', 'La lista de puesta en marcha está incompleta', {
        missing: d?.readiness.items.filter((i) => !i.ok).map((i) => i.key) ?? [],
      });
    }
    if (code === '42501') return new AppError('FORBIDDEN', 'No autorizado');
    return e;
  }

  /** Administrador municipal (RF-4.2): contraseña temporal de un solo uso, que debe cambiar al entrar. */
  async createAdmin(user: PlatformClaims, id: string, body: CreateTenantAdmin, ip: string): Promise<TenantAdminPassword> {
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    try {
      const admin = await this.dbs.asPlatform(user.sub, async (tx) => {
        const [t] = await tx
          .select({ status: tenant.status, comunaCut: tenant.comunaCut })
          .from(tenant)
          .where(eq(tenant.id, id))
          .limit(1);
        if (!t) throw new AppError('NOT_FOUND', 'Municipio no encontrado');
        if (t.status === 'TERMINATED') throw new AppError('CONFLICT', 'El municipio está de baja');
        const [o] = await tx
          .insert(operator)
          .values({ tenantId: id, email: body.email, name: body.name, role: 'ADMIN', passwordHash, mustChangePassword: true })
          .returning();
        await this.audit.record(tx, {
          actorId: user.sub,
          action: 'TENANT_ADMIN_CREATED',
          tenantId: id,
          comunaCut: t.comunaCut,
          targetId: o.id,
          payload: { email: o.email, name: o.name },
          ip,
        });
        await this.audit.recordInTenant(tx, {
          tenantId: id,
          platformActorId: user.sub,
          kind: 'OPERATOR_CREATED',
          targetId: o.id,
          payload: { email: o.email, name: o.name, role: o.role },
        });
        return o;
      });
      return { admin: toAdmin(admin), temporaryPassword: temp };
    } catch (e) {
      if (pgCode(e) === '23505') throw new AppError('CONFLICT', 'Ya existe una cuenta con ese correo');
      throw e;
    }
  }

  /** Restablecer el acceso (RF-4.3): contraseña temporal nueva, cuenta activa, sesiones anteriores cerradas. */
  async resetAdmin(user: PlatformClaims, id: string, adminId: string, ip: string): Promise<TenantAdminPassword> {
    const temp = temporaryPassword();
    const passwordHash = await hashPassword(temp);
    const admin = await this.dbs.asPlatform(user.sub, async (tx) => {
      const [o] = await tx
        .update(operator)
        .set({ passwordHash, mustChangePassword: true, active: true })
        .where(and(eq(operator.id, adminId), eq(operator.tenantId, id), eq(operator.role, 'ADMIN')))
        .returning();
      if (!o) throw new AppError('NOT_FOUND', 'Administrador no encontrado');
      await this.audit.record(tx, {
        actorId: user.sub,
        action: 'TENANT_ADMIN_RESET',
        tenantId: id,
        targetId: o.id,
        payload: { email: o.email },
        ip,
      });
      await this.audit.recordInTenant(tx, {
        tenantId: id,
        platformActorId: user.sub,
        kind: 'PASSWORD_RESET',
        targetId: o.id,
        payload: { email: o.email },
      });
      return o;
    });
    this.operatorStatus.invalidate(adminId);
    await this.dbs.asSystem((tx) => this.operatorTokens.revokeAllFor(tx, 'OPERATOR', adminId));
    return { admin: toAdmin(admin), temporaryPassword: temp };
  }

  /** Teléfonos de prueba del modo implementación (RF-3.4). */
  async addTestPhone(user: PlatformClaims, id: string, body: TestPhoneInput, ip: string): Promise<TestPhone> {
    try {
      return await this.dbs.asPlatform(user.sub, async (tx) => {
        const [t] = await tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, id)).limit(1);
        if (!t) throw new AppError('NOT_FOUND', 'Municipio no encontrado');
        if (t.status === 'TERMINATED') throw new AppError('CONFLICT', 'El municipio está de baja');
        const [p] = await tx
          .insert(tenantTestPhone)
          .values({ tenantId: id, phone: body.phone, label: body.label, createdBy: user.sub })
          .returning();
        await this.audit.record(tx, {
          actorId: user.sub,
          action: 'TEST_PHONE_ADDED',
          tenantId: id,
          targetId: p.id,
          payload: { phone: maskPhone(p.phone), label: p.label },
          ip,
        });
        return { id: p.id, phone: p.phone, label: p.label, createdAt: p.createdAt.toISOString() };
      });
    } catch (e) {
      if (pgCode(e) === '23505') throw new AppError('CONFLICT', 'Ese teléfono ya es de prueba en este municipio');
      throw e;
    }
  }

  async removeTestPhone(user: PlatformClaims, id: string, phoneId: string, ip: string): Promise<void> {
    await this.dbs.asPlatform(user.sub, async (tx) => {
      const [p] = await tx
        .delete(tenantTestPhone)
        .where(and(eq(tenantTestPhone.id, phoneId), eq(tenantTestPhone.tenantId, id)))
        .returning();
      if (!p) throw new AppError('NOT_FOUND', 'Teléfono no encontrado');
      await this.audit.record(tx, {
        actorId: user.sub,
        action: 'TEST_PHONE_REMOVED',
        tenantId: id,
        targetId: p.id,
        payload: { phone: maskPhone(p.phone), label: p.label },
        ip,
      });
    });
  }
}

function profileSet(body: Partial<Record<(typeof PROFILE_FIELDS)[number], unknown>>): Partial<typeof tenant.$inferInsert> {
  const set: Record<string, unknown> = {};
  for (const k of PROFILE_FIELDS) if (body[k] !== undefined) set[k] = body[k];
  return set as Partial<typeof tenant.$inferInsert>;
}
