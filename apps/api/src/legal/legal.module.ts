import { Global, Module } from '@nestjs/common';
import { LegalController, TenantPrivacyController } from './legal.controller';
import { LegalService } from './legal.service';
import { TenantPrivacyService } from './tenant-privacy.service';

/**
 * Ley 21.719, etapa 1 (migración 0014): aviso al vecino, prueba del consentimiento, regla de subencargados para el
 * worker de IA y «Privacidad» de la central. Global: lo usan auth, privacy, ai y la consola.
 */
@Global()
@Module({
  controllers: [LegalController, TenantPrivacyController],
  providers: [LegalService, TenantPrivacyService],
  exports: [LegalService],
})
export class LegalModule {}
