import { Module } from '@nestjs/common';
import { AdminController, ContactsController, OperatorsController, ShiftsController } from './admin.controller';
import { ContactsService } from './contacts.service';
import { OperatorsService } from './operators.service';
import { ShiftsService } from './shifts.service';
import { StatsService } from './stats.service';

/**
 * Administración de la central (migración 0003): usuarios, turnos, directorio de contactos y panel
 * con bitácoras. AuthModule (auditoría, estado de operadores, tokens) y RealtimeModule son globales.
 */
@Module({
  controllers: [OperatorsController, ShiftsController, ContactsController, AdminController],
  providers: [OperatorsService, ShiftsService, ContactsService, StatsService],
})
export class AdminModule {}
