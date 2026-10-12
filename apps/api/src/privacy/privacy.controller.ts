import { Controller, Delete, Get, Header } from '@nestjs/common';
import { Auth, CurrentAuth, type CitizenClaims } from '../auth/auth.guard';
import { PrivacyService } from './privacy.service';

/** Derechos ARCO del vecino. Siempre sobre sí mismo: el id sale del token, nunca de la URL. */
@Controller('me')
@Auth('citizen')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('export')
  @Header('Content-Disposition', 'attachment; filename="guardia-mis-datos.json"')
  @Header('Cache-Control', 'no-store')
  export(@CurrentAuth() auth: CitizenClaims) {
    return this.privacy.export(auth.sub);
  }

  @Delete()
  erase(@CurrentAuth() auth: CitizenClaims) {
    return this.privacy.erase(auth.sub);
  }
}
