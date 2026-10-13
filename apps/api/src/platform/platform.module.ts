import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformTokensService } from './platform-tokens.service';
import { PlatformUsersService } from './platform-users.service';
import { PlatformAuthController, PlatformController } from './platform.controller';
import { PlatformGuard, PlatformUserStatusService } from './platform.guard';
import { PlatformTenantsService } from './tenants.service';
import { TerritoryService } from './territory.service';

/**
 * Consola de plataforma (migración 0010): equipo Guard-IA, regiones y comunas, municipios. Aislada de la
 * central: su propio guard, sus propios tokens y el contexto RLS `platform`. Si cae, el SOS y la central
 * siguen (no comparten nada en el camino crítico).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformAuthController, PlatformController],
  providers: [
    PlatformTokensService,
    PlatformUserStatusService,
    PlatformGuard,
    PlatformAuditService,
    PlatformAuthService,
    PlatformUsersService,
    PlatformTenantsService,
    TerritoryService,
  ],
  exports: [PlatformTokensService],
})
export class PlatformModule {}
