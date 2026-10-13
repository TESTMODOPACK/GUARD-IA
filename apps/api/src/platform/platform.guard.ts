import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { PlatformRole } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { DbService } from '../db/db.service';
import { platformUser } from '../db/schema';
import { PlatformTokensService, type PlatformClaims } from './platform-tokens.service';

const PLATFORM_ROLES_KEY = 'platform:roles';
const PLATFORM_PENDING_KEY = 'platform:pending-password';

/** Roles que pueden usar el endpoint. Sin el decorador, cualquier usuario de plataforma. */
export const PlatformRoles = (...roles: PlatformRole[]) => SetMetadata(PLATFORM_ROLES_KEY, roles);
/** Permite el endpoint a quien todavía debe cambiar su contraseña temporal. */
export const AllowPendingPlatformPassword = () => SetMetadata(PLATFORM_PENDING_KEY, true);

/** Quiénes cambian municipios (alta, ficha, activar, suspender, administrador, teléfonos de prueba). */
export const TENANT_MANAGERS: PlatformRole[] = ['SUPERADMIN', 'IMPLEMENTATION'];

export interface PlatformUserStatus {
  role: PlatformRole;
  active: boolean;
  mustChangePassword: boolean;
  locked: boolean;
}

const TTL_MS = 30_000;

/** Como OperatorStatusService: rol y estado desde la base, caché de 30 s, se invalida al cambiar la cuenta. */
@Injectable()
export class PlatformUserStatusService {
  private readonly cache = new Map<string, { at: number; value: PlatformUserStatus | null }>();

  constructor(private readonly dbs: DbService) {}

  async get(userId: string): Promise<PlatformUserStatus | null> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.dbs.asSystem(async (tx) => {
      const [u] = await tx
        .select({
          role: platformUser.role,
          active: platformUser.active,
          mustChangePassword: platformUser.mustChangePassword,
          lockedUntil: platformUser.lockedUntil,
        })
        .from(platformUser)
        .where(eq(platformUser.id, userId))
        .limit(1);
      return u
        ? {
            role: u.role,
            active: u.active,
            mustChangePassword: u.mustChangePassword,
            locked: !!u.lockedUntil && u.lockedUntil > new Date(),
          }
        : null;
    });
    this.cache.set(userId, { at: Date.now(), value });
    return value;
  }

  /** Llamar DESPUÉS del commit que cambió la cuenta. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}

type RequestWithPlatform = Request & { platform?: PlatformClaims };

/**
 * Guard de la consola. No usa el AuthGuard global (que solo mira @Auth): los controladores de plataforma lo
 * declaran con @UseGuards. Un token de vecino u operador no pasa: otro secreto y otro emisor.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: PlatformTokensService,
    private readonly status: PlatformUserStatusService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    this.tokens.requireEnabled();
    const req = ctx.switchToHttp().getRequest<RequestWithPlatform>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError('UNAUTHORIZED', 'Falta el token');
    const claims = this.tokens.verifyAccess(token);

    const s = await this.status.get(claims.sub);
    if (!s || !s.active || s.locked) throw new AppError('UNAUTHORIZED', 'La cuenta no está disponible');
    const pendingOk = this.reflector.getAllAndOverride<boolean | undefined>(PLATFORM_PENDING_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (s.mustChangePassword && !pendingOk) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Debes cambiar tu contraseña temporal antes de continuar');
    }
    const roles = this.reflector.getAllAndOverride<PlatformRole[] | undefined>(PLATFORM_ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles?.length && !roles.includes(s.role)) throw new AppError('FORBIDDEN', 'Tu rol no permite esta acción');
    req.platform = { ...claims, role: s.role };
    return true;
  }
}

export const CurrentPlatformUser = createParamDecorator((_: unknown, ctx: ExecutionContext): PlatformClaims => {
  const req = ctx.switchToHttp().getRequest<RequestWithPlatform>();
  if (!req.platform) throw new AppError('UNAUTHORIZED', 'Sin autenticación');
  return req.platform;
});
