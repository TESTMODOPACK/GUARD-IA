/**
 * Terreno (0012): el rol FIELD está denegado por defecto. Solo pasa donde @Roles lo nombra (/ops/field y cambiar su
 * contraseña); la cola, las fichas y la administración de la central le quedan cerradas.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { OperatorRole } from '@guardia/shared';
import { AuthGuard } from '../src/auth/auth.guard';
import type { OperatorStatusService } from '../src/auth/operator-status.service';
import type { TokenService } from '../src/auth/token.service';

const TENANT = '00000000-0000-4000-8000-000000000001';

function guardFor(role: OperatorRole, roles: OperatorRole[] | undefined) {
  const meta: Record<string, unknown> = { 'auth:kind': 'operator', 'auth:roles': roles };
  const reflector = { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
  const tokens = {
    verifyAccess: () => ({ kind: 'operator', sub: '00000000-0000-4000-8000-000000000002', tenantId: TENANT, role: 'OPERATOR' }),
  } as unknown as TokenService;
  const operators = {
    get: async () => ({ tenantId: TENANT, role, active: true, mustChangePassword: false }),
  } as unknown as OperatorStatusService;
  const req: { headers: Record<string, string>; auth?: unknown } = { headers: { authorization: 'Bearer x' } };
  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { run: () => new AuthGuard(reflector, tokens, operators).canActivate(ctx), req };
}

describe('AuthGuard y el rol de terreno', () => {
  it('niega a FIELD un endpoint de la central sin @Roles (la cola, las fichas)', async () => {
    await expect(guardFor('FIELD', undefined).run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('niega a FIELD los endpoints de la central con roles explícitos', async () => {
    await expect(guardFor('FIELD', ['ADMIN', 'SUPERVISOR', 'OPERATOR']).run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deja pasar a FIELD donde @Roles lo nombra, con el rol leído de la base', async () => {
    const g = guardFor('FIELD', ['FIELD']);
    await expect(g.run()).resolves.toBe(true);
    expect(g.req.auth).toMatchObject({ role: 'FIELD' });
  });

  it('a la central no le cambia nada', async () => {
    await expect(guardFor('OPERATOR', undefined).run()).resolves.toBe(true);
    await expect(guardFor('OPERATOR', ['FIELD']).run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
