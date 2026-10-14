import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AccessClaims, OperatorRole } from '@guardia/shared';
import { AppError } from '../common/app-error';
import { OperatorStatusService } from './operator-status.service';
import { TokenService } from './token.service';

export type AuthKind = AccessClaims['kind'];

const AUTH_KIND = 'auth:kind';
const AUTH_ROLES = 'auth:roles';
const AUTH_PENDING_PASSWORD = 'auth:pending-password';

/** Exige un JWT del tipo indicado. */
export const Auth = (kind: AuthKind) => SetMetadata(AUTH_KIND, kind);
/** Exige además uno de los roles (solo operador). */
export const Roles = (...roles: OperatorRole[]) => SetMetadata(AUTH_ROLES, roles);
/** Permite el endpoint a un operador que aún debe cambiar su contraseña temporal. */
export const AllowPendingPassword = () => SetMetadata(AUTH_PENDING_PASSWORD, true);

export type RequestWithAuth = Request & { auth?: AccessClaims };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly operators: OperatorStatusService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<AuthKind | undefined>(AUTH_KIND, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!kind) return true; // endpoint público

    const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError('UNAUTHORIZED', 'Falta el token');

    let claims = this.tokens.verifyAccess(token);
    if (claims.kind !== kind) throw new AppError('FORBIDDEN', 'Token de otro tipo de usuario');

    if (claims.kind === 'operator') {
      // El rol y el estado salen de la base (caché 30 s), no del token: un cambio rige de inmediato.
      const status = await this.operators.get(claims.sub);
      if (!status || !status.active || status.tenantId !== claims.tenantId) {
        throw new AppError('UNAUTHORIZED', 'La cuenta está desactivada');
      }
      claims = { ...claims, role: status.role };
      const pendingOk = this.reflector.getAllAndOverride<boolean | undefined>(AUTH_PENDING_PASSWORD, [
        ctx.getHandler(),
        ctx.getClass(),
      ]);
      if (status.mustChangePassword && !pendingOk) {
        throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Debes cambiar tu contraseña temporal antes de continuar');
      }
    }

    const roles = this.reflector.getAllAndOverride<OperatorRole[] | undefined>(AUTH_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles?.length && claims.kind === 'operator' && !roles.includes(claims.role)) {
      throw new AppError('FORBIDDEN', `Requiere rol ${roles.join(' o ')}`);
    }
    // Terreno (0012): denegado por defecto. Un funcionario de terreno solo entra donde @Roles nombra FIELD
    // (/ops/field y cambiar su contraseña); nunca a la cola, las fichas ni la administración de la central.
    if (claims.kind === 'operator' && claims.role === 'FIELD' && !roles?.includes('FIELD')) {
      throw new AppError('FORBIDDEN', 'Esta cuenta es de terreno: entra a /terreno');
    }
    req.auth = claims;
    return true;
  }
}

/** @CurrentAuth() claims — ya validado por AuthGuard. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
  if (!req.auth) throw new AppError('UNAUTHORIZED', 'Sin autenticación');
  return req.auth;
});

export type CitizenClaims = Extract<AccessClaims, { kind: 'citizen' }>;
export type OperatorClaims = Extract<AccessClaims, { kind: 'operator' }>;
