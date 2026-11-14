import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { StripeBillingService } from '../../billing/stripe-billing.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('billing')
export class StripeBillingController {
  constructor(private readonly billing: StripeBillingService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AccessTokenGuard)
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.status(user.userId);
  }

  @Post('checkout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AccessTokenGuard)
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('origin') origin: string | undefined,
    @Body() body: { acceptRecurringTerms?: boolean } | undefined,
  ) {
    return this.billing.checkout(
      user.userId,
      origin,
      body?.acceptRecurringTerms === true,
    );
  }

  @Post('portal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AccessTokenGuard)
  portal(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('origin') origin: string | undefined,
  ) {
    return this.billing.portal(user.userId, origin);
  }

  @Post('webhook')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async webhook(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<void> {
    await this.billing.webhook(request.rawBody, signature);
  }
}
