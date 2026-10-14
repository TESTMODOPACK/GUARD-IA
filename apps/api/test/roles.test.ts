/**
 * Apoyo administrativo (ASSISTANT, 0013): consulta sin operar. Lee casos, panel y bitácora, y escribe notas; no toma,
 * despacha, rechaza, cierra, reclasifica, deriva, traspasa ni cambia de área. Se verifica con los @Roles de cada
 * endpoint (los mismos que aplica AuthGuard).
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { OperatorRole } from '@guardia/shared';
import { AdminController } from '../src/admin/admin.controller';
import { AreasController } from '../src/areas/areas.controller';
import { FieldAlarmsController } from '../src/field/field.controller';
import { OpsController } from '../src/ops/ops.controller';

type Ctor = { prototype: object } & (abstract new (...args: never[]) => unknown);

/** Roles permitidos en el método (o en la clase si el método no declara). undefined = cualquier rol de la central. */
function rolesOf(ctl: Ctor, method: string): OperatorRole[] | undefined {
  const fn = (ctl.prototype as Record<string, unknown>)[method] as object;
  return (Reflect.getMetadata('auth:roles', fn) ?? Reflect.getMetadata('auth:roles', ctl)) as OperatorRole[] | undefined;
}
const allows = (ctl: Ctor, method: string, role: OperatorRole) => {
  const r = rolesOf(ctl, method);
  return !r || r.includes(role);
};

describe('apoyo administrativo: consulta sin operar', () => {
  it('no actúa sobre los casos', () => {
    for (const m of [
      'ack',
      'reject',
      'dispatch',
      'resolve',
      'reanalyze',
      'detach',
      'reclassify',
      'refer',
      'transfer',
      'reassignArea',
      'recordOutcome',
      'updateDispatch',
      'updateUnit',
    ]) {
      expect(typeof (OpsController.prototype as unknown as Record<string, unknown>)[m], m).toBe('function');
      expect(allows(OpsController, m, 'ASSISTANT'), m).toBe(false);
      expect(allows(OpsController, m, 'OPERATOR'), m).toBe(true);
    }
    expect(allows(FieldAlarmsController, 'ack', 'ASSISTANT')).toBe(false);
  });

  it('lee los casos, escribe notas y ve el panel, la bitácora y los avisos de terreno', () => {
    for (const m of ['list', 'detail', 'note']) expect(allows(OpsController, m, 'ASSISTANT'), m).toBe(true);
    expect(allows(AdminController, 'overview', 'ASSISTANT')).toBe(true);
    expect(allows(AdminController, 'activity', 'ASSISTANT')).toBe(true);
    expect(allows(FieldAlarmsController, 'open', 'ASSISTANT')).toBe(true);
    expect(allows(AreasController, 'refs', 'ASSISTANT')).toBe(true);
  });

  it('las áreas solo las define el administrador municipal', () => {
    for (const m of ['config', 'create', 'suggested', 'rules', 'mode', 'update']) {
      expect(rolesOf(AreasController, m), m).toEqual(['ADMIN']);
    }
  });
});
