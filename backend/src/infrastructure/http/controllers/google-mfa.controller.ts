import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { GoogleMfaService } from '../auth/google-mfa.service';

@Controller('auth/google-mfa')
export class GoogleMfaController {
  constructor(
    private readonly accessTokenGuard: AccessTokenGuard,
    private readonly googleMfa: GoogleMfaService,
  ) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(@Req() request: FastifyRequest) {
    return this.googleMfa.status(await this.getClaims(request), request);
  }

  @Post('registration/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async registrationOptions(@Req() request: FastifyRequest) {
    return this.googleMfa.options(
      'registration',
      await this.getClaims(request),
      request,
    );
  }

  @Post('registration/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async register(
    @Req() request: FastifyRequest,
    @Body() assertion: RegistrationResponseJSON,
  ) {
    return this.googleMfa.register(
      await this.getClaims(request),
      request,
      assertion,
    );
  }

  @Post('authentication/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async authenticationOptions(@Req() request: FastifyRequest) {
    return this.googleMfa.options(
      'authentication',
      await this.getClaims(request),
      request,
    );
  }

  @Post('authentication/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async authenticate(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() assertion: AuthenticationResponseJSON,
  ) {
    return this.googleMfa.authenticate(
      await this.getClaims(request),
      request,
      reply,
      assertion,
    );
  }

  @Post('recovery/code')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async issueRecoveryCode(@Req() request: FastifyRequest) {
    return this.googleMfa.issueRecoveryCode(
      await this.getClaims(request),
      request,
    );
  }

  @Post('recovery/options')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async recoveryOptions(
    @Req() request: FastifyRequest,
    @Body('code') code: unknown,
  ) {
    return this.googleMfa.recoveryOptions(
      await this.getClaims(request),
      request,
      code,
    );
  }

  @Post('recovery/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async recover(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() assertion: RegistrationResponseJSON,
  ) {
    return this.googleMfa.recover(
      await this.getClaims(request),
      request,
      reply,
      assertion,
    );
  }

  private async getClaims(request: FastifyRequest) {
    if (!this.googleMfa.enabled) {
      throw new NotFoundException('Google WebAuthn is unavailable');
    }
    const { claims } = await this.accessTokenGuard.authenticatePending(request);
    return claims;
  }
}
