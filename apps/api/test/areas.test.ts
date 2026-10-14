/**
 * Áreas municipales (0013) contra base real (pnpm test:db): derivación al insertar (SOS al área de los SOS, reporte
 * urbano por categoría o subcategoría), lo que ve cada operador según sus áreas (también fichas, eventos y archivos),
 * el carácter de seguridad, el modo compartido, la reasignación (manda sobre el agente) y el traspaso entre municipios.
 */
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOperatorScope, refreshAlertArea } from '../src/areas/area-scope';
import { AreasService } from '../src/areas/areas.service';
import { AuditService } from '../src/auth/audit.service';
import type { OperatorClaims } from '../src/auth/auth.guard';
import { loadEnvFiles } from '../src/cli/load-env';
import { validateEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import type { RealtimeService } from '../src/realtime/realtime.service';

loadEnvFiles();
const enabled = process.env.RUN_DB_TESTS === '1';
const d = enabled ? describe : describe.skip;

const X = 78.5; // dentro de la caja del municipio de prueba (78 a 79 grados)
const box = (x: number) =>
  JSON.stringify({ type: 'MultiPolygon', coordinates: [[[[x, x], [x + 1, x], [x + 1, x + 1], [x, x + 1], [x, x]]]] });

d('áreas municipales: derivación y lo que ve cada operador', () => {
  let dbs: DbService;
  let admin: postgres.Sql;
  let areas: AreasService;
  let tenantId: string;
  let otherTenantId: string;
  let adminOp: OperatorClaims;
  let seguridad: OperatorClaims;
  let aseo: OperatorClaims;
  let nadie: OperatorClaims;
  let citizenId: string;
  const ids: Record<string, string> = {};
  const suffix = Date.now().toString(36);
  const reconnects: (string[] | undefined)[] = [];

  async function newAlert(type: 'EMERGENCY_SOS' | 'CIVIC_REPORT', category: string | null, subcategory: string | null = null, x = X) {
    return dbs.asCitizen(citizenId, async (tx) => {
      const rows = await tx.execute<{ id: string; area_id: string | null; area_source: string | null }>(sql`
        INSERT INTO alert (citizen_id, type, source, lat, lng, user_text, category, subcategory)
        VALUES (${citizenId}::uuid, ${type}::alert_type, ${type === 'CIVIC_REPORT' ? 'FORM' : 'BUTTON'}::alert_source,
                ${x}, ${x}, 'texto', ${category}::alert_category, ${subcategory})
        RETURNING id, area_id, area_source`);
      return rows[0];
    });
  }
  const visible = (who: OperatorClaims, table: 'alert' | 'alert_event' = 'alert') =>
    dbs.asOperator(who.tenantId, who.sub, async (tx) =>
      table === 'alert'
        ? (await tx.execute<{ id: string }>(sql`SELECT id FROM alert WHERE tenant_id = ${who.tenantId}::uuid`)).map((r) => r.id)
        : (await tx.execute<{ alert_id: string }>(sql`SELECT alert_id FROM alert_event WHERE tenant_id = ${who.tenantId}::uuid`)).map(
            (r) => r.alert_id,
          ),
    );

  beforeAll(async () => {
    const env = validateEnv(process.env);
    if (!env.DATABASE_ADMIN_URL) throw new Error('DATABASE_ADMIN_URL requerido');
    dbs = new DbService(env);
    admin = postgres(env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => undefined });
    const realtime = {
      reconnectOperators: async (_t: string, ops?: string[]) => {
        reconnects.push(ops);
      },
    } as unknown as RealtimeService;
    areas = new AreasService(dbs, new AuditService(), realtime);

    for (const [i, x] of [X, X + 2].entries()) {
      const [t] = await admin<{ id: string }[]>`
        INSERT INTO tenant (name, slug, boundary)
        VALUES (${'Municipalidad Áreas ' + i}, ${`areas-test-${i}-${suffix}`}, ST_GeomFromGeoJSON(${box(x)})::geography) RETURNING id`;
      if (i === 0) tenantId = t.id;
      else otherTenantId = t.id;
    }
    const people: OperatorClaims[] = [];
    for (const [i, role] of (['ADMIN', 'OPERATOR', 'OPERATOR', 'OPERATOR'] as const).entries()) {
      const [o] = await admin<{ id: string }[]>`
        INSERT INTO operator (tenant_id, email, password_hash, name, role)
        VALUES (${tenantId}, ${`areas-${i}-${suffix}@test.cl`}, 'x', ${`Áreas ${i}`}, ${role}::operator_role) RETURNING id`;
      people.push({ kind: 'operator', sub: o.id, tenantId, role });
    }
    [adminOp, seguridad, aseo, nadie] = people;
    const [c] = await admin<{ id: string }[]>`
      INSERT INTO citizen (phone, consent_version, consent_at) VALUES (${`+5692${String(Date.now()).slice(-7)}`}, 'v1', now()) RETURNING id`;
    citizenId = c.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, otherTenantId].filter(Boolean)) {
      await admin`DELETE FROM alert_event WHERE tenant_id = ${t}`;
      await admin`DELETE FROM alert WHERE tenant_id = ${t}`;
      await admin`DELETE FROM audit_log WHERE tenant_id = ${t}`;
      await admin`DELETE FROM operator_area WHERE tenant_id = ${t}`;
      await admin`DELETE FROM area_rule WHERE tenant_id = ${t}`;
      await admin`DELETE FROM tenant_area_mode WHERE tenant_id = ${t}`;
      await admin`DELETE FROM area WHERE tenant_id = ${t}`;
      await admin`DELETE FROM operator WHERE tenant_id = ${t}`;
      await admin`DELETE FROM tenant WHERE id = ${t}`;
    }
    if (citizenId) await admin`DELETE FROM citizen WHERE id = ${citizenId}`;
    await admin?.end({ timeout: 5 });
    await dbs?.onModuleDestroy();
  });

  it('sin áreas definidas todos ven todo, como antes', async () => {
    const a = await newAlert('CIVIC_REPORT', 'BACHE');
    expect(a.area_id).toBeNull();
    expect(await visible(aseo)).toContain(a.id);
    const scope = await dbs.asSystem((tx) => loadOperatorScope(tx, { id: aseo.sub, tenantId, role: 'OPERATOR' }));
    expect(scope.seesAll).toBe(true);
  });

  it('el administrador crea las áreas sugeridas; SOS a Seguridad y cada categoría a su área', async () => {
    const cfg = await areas.createSuggested(adminOp);
    for (const a of cfg.areas) ids[a.name] = a.id;
    expect(cfg.areas.find((a) => a.receivesSos)?.name).toBe('Seguridad');
    expect(cfg.rules).toHaveLength(7);
    await expect(areas.createSuggested(adminOp)).rejects.toMatchObject({ code: 'CONFLICT' });

    const sos = await newAlert('EMERGENCY_SOS', null);
    const bache = await newAlert('CIVIC_REPORT', 'BACHE');
    const basura = await newAlert('CIVIC_REPORT', 'BASURA_MICROBASURAL');
    expect(sos).toMatchObject({ area_id: ids['Seguridad'], area_source: 'AUTO' });
    expect(bache.area_id).toBe(ids['Obras y vialidad']);
    expect(basura.area_id).toBe(ids['Aseo y ornato']);
  });

  it('cada operador ve solo lo de sus áreas (también la línea de tiempo); el administrador ve todo', async () => {
    await admin`INSERT INTO operator_area (operator_id, area_id, tenant_id) VALUES
      (${seguridad.sub}, ${ids['Seguridad']}, ${tenantId}), (${aseo.sub}, ${ids['Aseo y ornato']}, ${tenantId})`;
    const sos = await newAlert('EMERGENCY_SOS', null);
    const basura = await newAlert('CIVIC_REPORT', 'BASURA_MICROBASURAL');
    await admin`INSERT INTO alert_event (alert_id, actor_type, kind, payload) VALUES
      (${sos.id}, 'SYSTEM', 'NOTE', '{}'::jsonb), (${basura.id}, 'SYSTEM', 'NOTE', '{}'::jsonb)`;

    const seg = await visible(seguridad);
    const ase = await visible(aseo);
    expect(seg).toContain(sos.id);
    expect(seg).not.toContain(basura.id);
    expect(ase).toContain(basura.id);
    expect(ase).not.toContain(sos.id);
    expect(await visible(aseo, 'alert_event')).not.toContain(sos.id);
    expect(await visible(nadie)).not.toContain(sos.id);
    expect(await visible(adminOp)).toEqual(expect.arrayContaining([sos.id, basura.id]));
    const scope = await dbs.asSystem((tx) => loadOperatorScope(tx, { id: seguridad.sub, tenantId, role: 'OPERATOR' }));
    expect(scope).toMatchObject({ seesAll: false, inSosArea: true });
  });

  it('un reporte urbano con carácter de seguridad lo ve también Seguridad, sin salir de su área', async () => {
    const basura = await newAlert('CIVIC_REPORT', 'BASURA_MICROBASURAL');
    expect(await visible(seguridad)).not.toContain(basura.id);
    const before = await dbs.asSystem((tx) => refreshAlertArea(tx, basura.id, 'AI', true));
    expect(before).toEqual({ areaId: ids['Aseo y ornato'], securityRelevant: false });
    expect(await visible(seguridad)).toContain(basura.id);
    expect(await visible(aseo)).toContain(basura.id);
    const [row] = await admin<{ area_id: string; security_relevant: boolean }[]>`
      SELECT area_id, security_relevant FROM alert WHERE id = ${basura.id}`;
    expect(row).toEqual({ area_id: ids['Aseo y ornato'], security_relevant: true });
    // Queda en la línea de tiempo quién lo marcó (el agente) y en qué área sigue.
    const events = await admin<{ actor_type: string; payload: Record<string, unknown> }[]>`
      SELECT actor_type, payload FROM alert_event WHERE alert_id = ${basura.id} AND kind = 'AREA_CHANGED'`;
    expect(events).toEqual([
      { actor_type: 'AI', payload: { from: ids['Aseo y ornato'], to: ids['Aseo y ornato'], by: 'AI', security: true } },
    ]);
  });

  it('una regla por subcategoría manda sobre la de su categoría', async () => {
    const cfg = await areas.config(adminOp);
    const rules = cfg.rules.map((r) => ({ ...r }));
    rules.push({ category: 'AREA_VERDE', subcategory: 'ARBOL_RIESGO', areaId: ids['Medio ambiente'] });
    await areas.setRules(adminOp, { rules });
    expect((await newAlert('CIVIC_REPORT', 'AREA_VERDE', 'ARBOL_RIESGO')).area_id).toBe(ids['Medio ambiente']);
    expect((await newAlert('CIVIC_REPORT', 'AREA_VERDE')).area_id).toBe(ids['Aseo y ornato']);
  });

  it('reasignar: lo hace una persona, queda en la bitácora y el agente ya no lo mueve', async () => {
    const bache = await newAlert('CIVIC_REPORT', 'BACHE');
    await dbs.asOperator(tenantId, adminOp.sub, (tx) =>
      tx.execute(sql`SELECT reassign_alert_area(${bache.id}::uuid, ${ids['Alumbrado']}::uuid, ${adminOp.sub}::uuid, 'Es un poste caído')`),
    );
    await dbs.asSystem((tx) => refreshAlertArea(tx, bache.id, 'AI', false));
    const [row] = await admin<{ area_id: string; area_source: string }[]>`SELECT area_id, area_source FROM alert WHERE id = ${bache.id}`;
    expect(row).toEqual({ area_id: ids['Alumbrado'], area_source: 'OPERATOR' });
    const [log] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE target_id = ${bache.id} AND kind = 'ALERT_AREA_CHANGED'`;
    expect(log.n).toBe(1);
    // El reanálisis no movió nada: un solo evento, el de la persona.
    const [ev] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM alert_event WHERE alert_id = ${bache.id} AND kind = 'AREA_CHANGED'`;
    expect(ev.n).toBe(1);
    // Un operador no mueve el aviso a otra área con un UPDATE directo (solo por la función auditada).
    const basura = await newAlert('CIVIC_REPORT', 'BASURA_MICROBASURAL');
    await expect(
      dbs.asOperator(tenantId, aseo.sub, (tx) =>
        tx.execute(sql`UPDATE alert SET area_id = ${ids['Alumbrado']}::uuid WHERE id = ${basura.id}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it('modo compartido (excepción): todas las áreas ven todo; el área de los SOS no se desactiva', async () => {
    const sos = await newAlert('EMERGENCY_SOS', null);
    expect(await visible(aseo)).not.toContain(sos.id);
    await areas.setMode(adminOp, { shared: true, reason: 'Central chica, todos atienden todo' });
    expect(await visible(aseo)).toContain(sos.id);
    expect(reconnects.at(-1)).toBeUndefined(); // se reconectan todas las cuentas del municipio
    await areas.setMode(adminOp, { shared: false, reason: 'Volvemos a separar por área' });
    expect(await visible(aseo)).not.toContain(sos.id);
    await expect(areas.update(adminOp, ids['Seguridad'], { active: false })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(areas.update(adminOp, ids['Obras y vialidad'], { active: false })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('el traspaso entre municipios deja el aviso en el área que corresponde en el destino', async () => {
    const [dest] = await admin<{ id: string }[]>`
      INSERT INTO area (tenant_id, name, receives_sos) VALUES (${otherTenantId}, 'Seguridad destino', true) RETURNING id`;
    await admin`UPDATE tenant SET status = 'ACTIVE' WHERE id = ${otherTenantId}`;
    const sos = await newAlert('EMERGENCY_SOS', null);
    await dbs.asSystem((tx) =>
      tx.execute(sql`SELECT transfer_alert(${sos.id}::uuid, ${otherTenantId}::uuid, NULL, 'prueba', true)`),
    );
    const [row] = await admin<{ tenant_id: string; area_id: string }[]>`SELECT tenant_id, area_id FROM alert WHERE id = ${sos.id}`;
    expect(row).toEqual({ tenant_id: otherTenantId, area_id: dest.id });
  });
});
