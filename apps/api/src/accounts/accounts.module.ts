import { Module } from '@nestjs/common';
import { AccountsController, CitizenAccountController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { CitizenAccountService } from './citizen-account.service';

/**
 * Uso indebido, etapa 3 (migración 0011): estado de la cuenta del vecino, revisión, y las decisiones de la
 * central sobre bloqueos y faltas. DbModule, AuthModule (auditoría, rate limit) y NotificationsModule son globales.
 */
@Module({
  controllers: [CitizenAccountController, AccountsController],
  providers: [CitizenAccountService, AccountsService],
})
export class AccountsModule {}
