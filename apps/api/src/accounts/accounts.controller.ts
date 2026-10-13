import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  AnnulStrikeSchema,
  CreateReviewSchema,
  DecideBlockSchema,
  LiftBlockSchema,
  ResolveReviewSchema,
  UuidSchema,
  type AnnulStrike,
  type CreateReview,
  type DecideBlock,
  type LiftBlock,
  type ResolveReview,
} from '@guardia/shared';
import { Auth, CurrentAuth, Roles, type CitizenClaims, type OperatorClaims } from '../auth/auth.guard';
import { zod } from '../common/zod-validation.pipe';
import { AccountsService } from './accounts.service';
import { CitizenAccountService } from './citizen-account.service';

/** Estado de la cuenta y revisión, desde la app del vecino. */
@Controller('me')
@Auth('citizen')
export class CitizenAccountController {
  constructor(private readonly accounts: CitizenAccountService) {}

  @Get('account')
  detail(@CurrentAuth() c: CitizenClaims) {
    return this.accounts.detail(c.sub);
  }

  @Post('reviews')
  @HttpCode(200)
  review(@CurrentAuth() c: CitizenClaims, @Body(zod(CreateReviewSchema)) body: CreateReview) {
    return this.accounts.createReview(c.sub, body);
  }
}

/** Página "Cuentas" de la central: decidir bloqueos, levantarlos, anular faltas y resolver revisiones. */
@Controller('ops')
@Auth('operator')
@Roles('ADMIN', 'SUPERVISOR')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('accounts')
  overview(@CurrentAuth() op: OperatorClaims) {
    return this.accounts.overview(op);
  }

  @Post('blocks/:id/decision')
  @HttpCode(200)
  decide(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string, @Body(zod(DecideBlockSchema)) body: DecideBlock) {
    return this.accounts.decideBlock(op, id, body);
  }

  @Post('blocks/:id/lift')
  @HttpCode(200)
  lift(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string, @Body(zod(LiftBlockSchema)) body: LiftBlock) {
    return this.accounts.liftBlock(op, id, body);
  }

  @Post('strikes/:id/annul')
  @HttpCode(200)
  annul(@CurrentAuth() op: OperatorClaims, @Param('id', zod(UuidSchema)) id: string, @Body(zod(AnnulStrikeSchema)) body: AnnulStrike) {
    return this.accounts.annulStrike(op, id, body);
  }

  @Post('reviews/:id/resolve')
  @HttpCode(200)
  resolve(
    @CurrentAuth() op: OperatorClaims,
    @Param('id', zod(UuidSchema)) id: string,
    @Body(zod(ResolveReviewSchema)) body: ResolveReview,
  ) {
    return this.accounts.resolveReview(op, id, body);
  }
}
