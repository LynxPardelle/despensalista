import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { AccessCodeService } from '../../access/access-code.service';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthCookieService } from '../auth/auth-cookie.service';
import type { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';

export class RedeemAccessCodeDto {
  @IsString()
  @MinLength(80)
  @MaxLength(128)
  code: string;

  @IsUUID('4')
  householdId: string;
}

@Controller('household/access')
@UseGuards(AccessTokenGuard)
export class AccessCodeController {
  constructor(
    private readonly codes: AccessCodeService,
    private readonly cookies: AuthCookieService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.codes.status(user.userId);
  }

  @Post('redeem')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  redeem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RedeemAccessCodeDto,
    @Req() request: FastifyRequest,
  ) {
    this.cookies.ensureXsrfForRequest(request);
    return this.codes.redeem(user.userId, dto.code, dto.householdId);
  }
}
