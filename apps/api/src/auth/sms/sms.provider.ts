import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';

export const SMS_PROVIDER = 'SMS_PROVIDER' as const;

export interface SmsProvider {
  send(phone: string, text: string): Promise<void>;
}

/** Desarrollo: escribe el SMS en el log. */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('SMS');
  async send(phone: string, text: string) {
    this.logger.warn(`[console] a ${phone}: ${text}`);
  }
}

/** Twilio vía REST, sin SDK. Pendiente de confirmar proveedor para Chile (pregunta abierta). */
@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger('SMS');
  constructor(@Inject(ENV) private readonly env: Env) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
      throw new Error('SMS_PROVIDER=twilio requiere TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_FROM');
    }
  }

  async send(phone: string, text: string) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = this.env;
    const body = new URLSearchParams({ To: phone, From: from!, Body: text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      // Solo el código de error: el mensaje de Twilio suele repetir el número del vecino.
      const detail = (await res.json().catch(() => null)) as { code?: number } | null;
      this.logger.error(`Twilio ${res.status}${detail?.code ? ` (código ${detail.code})` : ''}`);
      throw new Error(`No se pudo enviar el SMS (${res.status})`);
    }
  }
}

export const smsProviderFactory = {
  provide: SMS_PROVIDER,
  useFactory: (env: Env): SmsProvider =>
    env.SMS_PROVIDER === 'twilio' ? new TwilioSmsProvider(env) : new ConsoleSmsProvider(),
  inject: [ENV],
};
