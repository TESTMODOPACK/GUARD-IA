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
import { TokenService } from './token.service';

export type AuthKind = AccessClaims['kind'];

const AUTH_KIND = 'auth:kind';
const AUTH_ROLES = 'auth:roles';

/** Exige un JWT del tipo indicado. */
export const Auth = (kind: AuthKind) => SetMetadata(AUTH_KIND, kind);
/** Exige además uno de los roles (solo operador). */
export const Roles = (...roles: OperatorRole[]) => SetMetadata(AUTH_ROLES, roles);

export type RequestWithAuth = Request & { auth?: AccessClaims };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const kind = this.reflector.getAllAndOverride<AuthKind | undefined>(AUTH_KIND, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!kind) return true; // endpoint público

    const req = ctx.switchToHttp().getRequest<RequestWithAuth>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new AppError('UNAUTHORIZED', 'Falta el token');

    const claims = this.tokens.verifyAccess(token);
    if (claims.kind !== kind) throw new AppError('FORBIDDEN', 'Token de otro tipo de usuario');

    const roles = this.reflector.getAllAndOverride<OperatorRole[] | undefined>(AUTH_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles?.length && claims.kind === 'operator' && !roles.includes(claims.role)) {
      throw new AppError('FORBIDDEN', `Requiere rol ${roles.join(' o ')}`);
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
