import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { WS_NAMESPACES, wsRooms, type WsHandshakeAuth } from '@guardia/shared';
import { loadOperatorScope } from '../areas/area-scope';
import { OperatorStatusService } from '../auth/operator-status.service';
import { TokenService } from '../auth/token.service';
import { DbService } from '../db/db.service';
import { RealtimeService } from './realtime.service';

/**
 * Namespace /ops: un operador se une a la room de su tenant. El JWT viaja en
 * handshake.auth.token. Si manda `since`, recibe un `sync` con lo ocurrido desde entonces.
 * Rol y estado salen de la base, como en AuthGuard: una cuenta desactivada no se conecta y una de terreno
 * (FIELD, 0012) va a /field, nunca a la room del municipio (recibiría cada alerta con los datos del vecino).
 */
@WebSocketGateway({ namespace: WS_NAMESPACES.ops })
export class OpsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(OpsGateway.name);
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeService,
    private readonly operators: OperatorStatusService,
    private readonly dbs: DbService,
  ) {}

  afterInit() {
    this.realtime.attachOps(this.server);
  }

  async handleConnection(client: Socket) {
    const auth = client.handshake.auth as Partial<WsHandshakeAuth>;
    try {
      const claims = this.tokens.verifyAccess(auth.token ?? '');
      if (claims.kind !== 'operator') throw new Error('Token no es de operador');
      const status = await this.operators.get(claims.sub);
      if (!status || !status.active || status.tenantId !== claims.tenantId) throw new Error('La cuenta está desactivada');
      if (status.role === 'FIELD') throw new Error('Cuenta de terreno: usa /field');
      await client.join(wsRooms.tenant(claims.tenantId));
      // Áreas (0013): los avisos llegan solo a las rooms de lo que puede ver (mismo criterio que la RLS).
      const scope = await this.dbs.asSystem((tx) =>
        loadOperatorScope(tx, { id: claims.sub, tenantId: claims.tenantId, role: status.role }),
      );
      if (scope.seesAll) await client.join(wsRooms.alertsAll(claims.tenantId));
      else {
        for (const a of scope.areas) await client.join(wsRooms.area(a.id));
        if (scope.inSosArea) await client.join(wsRooms.security(claims.tenantId));
      }
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

/**
 * Namespace /field (0012): el funcionario de terreno se une a su room personal y a la de la unidad con la que
 * salió. No recibe datos del caso por aquí, solo `field.refresh` (vuelve a pedir su estado con el contexto RLS
 * `field`) y la respuesta a su pánico.
 */
@WebSocketGateway({ namespace: WS_NAMESPACES.field })
export class FieldGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeService,
    private readonly operators: OperatorStatusService,
  ) {}

  afterInit() {
    this.realtime.attachField(this.server);
  }

  async handleConnection(client: Socket) {
    const auth = client.handshake.auth as Partial<WsHandshakeAuth>;
    try {
      const claims = this.tokens.verifyAccess(auth.token ?? '');
      if (claims.kind !== 'operator') throw new Error('Token no es de operador');
      const status = await this.operators.get(claims.sub);
      if (!status || !status.active || status.tenantId !== claims.tenantId) throw new Error('La cuenta está desactivada');
      if (status.role !== 'FIELD') throw new Error('Solo cuentas de terreno');
      client.data.claims = { ...claims, role: status.role };
      await client.join(wsRooms.operator(claims.sub));
      const unitId = await this.realtime.fieldUnitOf(claims.tenantId, claims.sub);
      if (unitId) await client.join(wsRooms.unit(unitId));
    } catch (e) {
      client.emit('error', { code: 'UNAUTHORIZED', message: (e as Error).message });
      client.disconnect(true);
    }
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
