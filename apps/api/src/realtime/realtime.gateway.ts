import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { WS_NAMESPACES, wsRooms, type WsHandshakeAuth } from '@guardia/shared';
import { TokenService } from '../auth/token.service';
import { RealtimeService } from './realtime.service';

/**
 * Namespace /ops: un operador se une a la room de su tenant. El JWT viaja en
 * handshake.auth.token. Si manda `since`, recibe un `sync` con lo ocurrido desde entonces.
 */
@WebSocketGateway({ namespace: WS_NAMESPACES.ops })
export class OpsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(OpsGateway.name);
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit() {
    this.realtime.attachOps(this.server);
  }

  async handleConnection(client: Socket) {
    const auth = client.handshake.auth as Partial<WsHandshakeAuth>;
    try {
      const claims = this.tokens.verifyAccess(auth.token ?? '');
      if (claims.kind !== 'operator') throw new Error('Token no es de operador');
      await client.join(wsRooms.tenant(claims.tenantId));
      client.data.claims = claims;
      this.logger.debug(`operador ${claims.sub} conectado a tenant ${claims.tenantId}`);
      if (auth.since) {
        const payload = await this.realtime.buildSync(claims.tenantId, claims.sub, auth.since);
        client.emit('sync', payload);
      }
    } catch (e) {
      client.emit('error', { code: 'UNAUTHORIZED', message: (e as Error).message });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const claims = client.data.claims;
    if (claims) this.logger.debug(`operador ${claims.sub} desconectado`);
  }
}

/** Namespace /citizen: el vecino solo recibe el estado de sus alertas. */
@WebSocketGateway({ namespace: WS_NAMESPACES.citizen })
export class CitizenGateway implements OnGatewayConnection {
  private readonly logger = new Logger(CitizenGateway.name);
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit() {
    this.realtime.attachCitizen(this.server);
  }

  async handleConnection(client: Socket) {
    const auth = client.handshake.auth as Partial<WsHandshakeAuth>;
    try {
      const claims = this.tokens.verifyAccess(auth.token ?? '');
      if (claims.kind !== 'citizen') throw new Error('Token no es de ciudadano');
      await client.join(wsRooms.citizen(claims.sub));
      client.data.claims = claims;
    } catch (e) {
      client.emit('error', { code: 'UNAUTHORIZED', message: (e as Error).message });
      client.disconnect(true);
    }
  }
}
