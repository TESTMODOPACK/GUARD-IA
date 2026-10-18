import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ACCOUNT_PUSH, type AccountLevel, type CitizenAlert } from '@guardia/shared';
import { ENV, type Env } from '../config/env';
import { DbService } from '../db/db.service';
import { device } from '../db/schema';
import { EventsService } from '../events/events.service';
import { RealtimeService } from '../realtime/realtime.service';

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  priority?: 'high' | 'normal';
  channelId?: string;
}

/**
 * Estado al vecino por dos canales (ADR 004): push Expo (llega en background)
 * y WebSocket (inmediato con la app abierta). Un fallo de push nunca rompe el flujo.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly dbs: DbService,
    private readonly realtime: RealtimeService,
    private readonly events: EventsService,
  ) {}

  async notifyAlertStatus(
    citizenId: string,
    tenantId: string | null,
    view: CitizenAlert,
    text: { title: string; body: string },
  ) {
    this.realtime.citizenAlertStatus(citizenId, view);

    const tokens = await this.dbs.asSystem((tx) =>
      tx.select({ token: device.expoPushToken }).from(device).where(eq(device.citizenId, citizenId)),
    );
    if (tokens.length === 0) return;

    const messages: ExpoMessage[] = tokens.map((t) => ({
      to: t.token,
      title: text.title,
      body: text.body,
      data: { alertId: view.id, status: view.status },
      sound: 'default',
      priority: 'high',
      channelId: 'alerts',
    }));

    try {
      const res = await fetch(this.env.EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${this.env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(5000),
      });
      const ok = res.ok;
      if (!ok) this.logger.warn(`Expo push respondió ${res.status}`);
      await this.dbs.asSystem((tx) =>
        this.events.record(tx, {
          alertId: view.id,
          tenantId,
          actorType: 'SYSTEM',
          kind: 'PUSH_SENT',
          payload: { devices: tokens.length, ok, status: view.status },
        }),
      );
    } catch (e) {
      this.logger.warn(`Push no enviado: ${(e as Error).message}`);
    }
  }

  /**
   * Aviso sobre la cuenta, no sobre una alerta (bloqueo, desbloqueo, falta anulada, revisión; 0011). Con la app
   * abierta llega por WS y la app relee su estado; si no, por push. El push es siempre neutro (ACCOUNT_PUSH): en la
   * pantalla bloqueada nadie debe leer «bloqueo» ni «aviso falso» (Ley 21.719, art. 14 bis); el detalle está en
   * «Estado de tu cuenta». Un fallo de push no rompe la decisión.
   */
  async notifyAccount(citizenId: string, level: AccountLevel) {
    const text = ACCOUNT_PUSH;
    this.realtime.citizenAccountUpdated(citizenId, { level });
    const tokens = await this.dbs.asSystem((tx) =>
      tx.select({ token: device.expoPushToken }).from(device).where(eq(device.citizenId, citizenId)),
    );
    if (tokens.length === 0) return;
    const messages: ExpoMessage[] = tokens.map((t) => ({
      to: t.token,
      title: text.title,
      body: text.body,
      data: { kind: 'account', level },
      sound: 'default',
      priority: 'high',
      channelId: 'alerts',
    }));
    try {
      const res = await fetch(this.env.EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(this.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${this.env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) this.logger.warn(`Expo push (cuenta) respondió ${res.status}`);
    } catch (e) {
      this.logger.warn(`Push de cuenta no enviado: ${(e as Error).message}`);
    }
  }
}
