import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  COGNITO_AUTH_URL_BUILDER,
  COGNITO_TOKEN_CLIENT,
  COGNITO_TOKEN_VERIFIER,
} from '../../../application/tokens';
import {
  CognitoAuthUrlBuilder,
  CognitoTokenClient,
  CognitoTokenVerifier,
} from '../../../application/ports/cognito-auth.port';
import { CognitoAuthTransactionService } from '../../../application/services/cognito-auth-transaction.service';
import { CognitoProfileSyncService } from '../../../application/services/cognito-profile-sync.service';
import { GetCurrentUserUseCase } from '../../../application/use-cases/get-current-user.use-case';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { GoogleMfaService } from '../auth/google-mfa.service';
import { AuthUserResponseDto } from '../dtos/auth-user-response.dto';
import { AuthUserMapper } from '../mappers/auth-user.mapper';

@Controller('auth')
@ApiTags('auth')
export class AuthController {
  constructor(
    private readonly getCurrentUserUseCase: GetCurrentUserUseCase,
    private readonly transactionService: CognitoAuthTransactionService,
    private readonly profileSyncService: CognitoProfileSyncService,
    @Inject(COGNITO_AUTH_URL_BUILDER)
    private readonly authUrlBuilder: CognitoAuthUrlBuilder,
    @Inject(COGNITO_TOKEN_CLIENT)
    private readonly tokenClient: CognitoTokenClient,
    @Inject(COGNITO_TOKEN_VERIFIER)
    private readonly tokenVerifier: CognitoTokenVerifier,
    private readonly authCookieService: AuthCookieService,
    private readonly configService: ConfigService,
    private readonly googleMfa: GoogleMfaService,
  ) {}

  @Get('cognito/login')
  @ApiOperation({ summary: 'Start Cognito Hosted UI login' })
  startCognitoLogin(
    @Query('provider') provider: string | undefined,
    @Query('redirectTo') redirectTo: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    this.ensureCognitoEnabled();
    const transaction = this.transactionService.createTransaction();
    const normalizedRedirectTo =
      this.transactionService.normalizeRedirectTo(redirectTo);
    const normalizedProvider = this.transactionService.normalizeProvider(
      provider,
      this.getAllowedProviders(),
    );

    this.authCookieService.setCognitoAuthTransactionCookies(reply, {
      state: transaction.state,
      nonce: transaction.nonce,
      codeVerifier: transaction.codeVerifier,
      redirectTo: normalizedRedirectTo,
    });

    const { url } = this.authUrlBuilder.buildAuthorizeUrl({
      state: transaction.state,
      nonce: transaction.nonce,
      codeChallenge: transaction.codeChallenge,
      codeChallengeMethod: transaction.codeChallengeMethod,
      redirectUri: this.getRedirectUri(),
      scopes: this.getScopes(),
      provider:
        normalizedProvider === 'COGNITO' ? undefined : normalizedProvider,
    });

    reply.redirect(url, 302);
  }

  @Get('cognito/providers')
  @ApiOperation({ summary: 'List enabled Cognito login providers' })
  getCognitoProviders(): { providers: string[] } {
    if (this.configService.get<string>('COGNITO_ENABLED') !== 'true') {
      return { providers: [] };
    }

    return { providers: this.getAllowedProviders() };
  }

  @Get('cognito/callback')
  @ApiOperation({ summary: 'Complete Cognito Hosted UI login callback' })
  async completeCognitoLogin(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.ensureCognitoEnabled();

    if (!code || !state) {
      this.authCookieService.clearCognitoAuthTransactionCookies(reply);
      reply.redirect('/login?authError=cognito_callback', 302);
      return;
    }

    const transaction =
      this.authCookieService.getCognitoAuthTransactionFromRequest(request);
    try {
      this.transactionService.assertStateMatches(state, transaction.state);
    } catch {
      this.authCookieService.clearCognitoAuthTransactionCookies(reply);
      reply.redirect('/login?authError=cognito_state', 302);
      return;
    }

    const tokenSet = await this.tokenClient.exchangeCode({
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri: this.getRedirectUri(),
    });
    const idClaims = await this.tokenVerifier.verifyIdToken(tokenSet.idToken);

    if (idClaims.nonce !== transaction.nonce) {
      throw new UnauthorizedException('Invalid Cognito auth nonce');
    }

    let redirectTo = transaction.redirectTo;
    if (this.googleMfa.enabled) {
      const accessClaims = await this.tokenVerifier.verifyAccessToken(
        tokenSet.accessToken,
      );
      if (
        accessClaims.sub !== idClaims.sub ||
        accessClaims.cognitoUsername !== idClaims.cognitoUsername
      ) {
        throw new UnauthorizedException('Invalid Cognito login identity');
      }
      if (this.googleMfa.requiresProof(accessClaims)) {
        if (!idClaims.emailVerified) {
          throw new UnauthorizedException('Verified Google email is required');
        }
        const destination =
          this.transactionService.normalizeRedirectTo(redirectTo);
        redirectTo = `/mfa-google?redirectTo=${encodeURIComponent(destination)}`;
      }
      this.authCookieService.clearGoogleMfaCookie(reply);
    }

    await this.profileSyncService.syncFromClaims(idClaims);
    this.authCookieService.setSessionCookies(reply, {
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      xsrfToken: this.authCookieService.createXsrfToken(),
    });
    this.authCookieService.clearCognitoAuthTransactionCookies(reply);
    reply.redirect(redirectTo, 302);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiOperation({
    summary: 'Get the current authenticated Despensa Lista user',
  })
  async me(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<AuthUserResponseDto> {
    return AuthUserMapper.toResponse(
      await this.getCurrentUserUseCase.execute(currentUser.userId),
    );
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh the current Cognito-backed session' })
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthUserResponseDto> {
    this.ensureCognitoEnabled();
    this.authCookieService.ensureXsrfForRequest(request);
    const refreshToken =
      this.authCookieService.getRefreshTokenFromRequest(request);

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenSet = await this.tokenClient.refresh({ refreshToken });
    const claims = await this.tokenVerifier.verifyAccessToken(
      tokenSet.accessToken,
    );
    this.authCookieService.setSessionCookies(reply, {
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken ?? refreshToken,
      xsrfToken: this.authCookieService.createXsrfToken(),
    });

    await this.googleMfa.assertVerified(claims, request);

    return AuthUserMapper.toResponse(
      await this.getCurrentUserUseCase.executeByAuthSubject(claims.sub),
    );
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout the current Cognito-backed session' })
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ logoutUrl: string }> {
    this.ensureCognitoEnabled();
    this.authCookieService.ensureXsrfForRequest(request);
    await this.revokeRefreshTokenIfPresent(request);
    this.authCookieService.clearSessionCookies(reply);
    await this.googleMfa.revokeProof(request);

    return { logoutUrl: this.authUrlBuilder.buildLogoutUrl() };
  }

  @Post('logout/browser')
  @ApiOperation({ summary: 'Logout from a browser form and redirect' })
  async logoutFromBrowser(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    this.ensureCognitoEnabled();
    this.authCookieService.ensureXsrfForRequest(request);
    await this.revokeRefreshTokenIfPresent(request);
    this.authCookieService.clearSessionCookies(reply);
    await this.googleMfa.revokeProof(request);
    reply.redirect(this.authUrlBuilder.buildLogoutUrl(), 302);
  }

  private async revokeRefreshTokenIfPresent(
    request: FastifyRequest,
  ): Promise<void> {
    const refreshToken =
      this.authCookieService.getRefreshTokenFromRequest(request);

    if (!refreshToken) {
      return;
    }

    try {
      await this.tokenClient.revoke({ refreshToken });
    } catch {
      // Local logout must still clear cookies if Cognito revocation is degraded.
    }
  }

  private ensureCognitoEnabled(): void {
    if (this.configService.get<string>('COGNITO_ENABLED') !== 'true') {
      throw new ServiceUnavailableException(
        'Cognito authentication is not configured',
      );
    }
  }

  private getRedirectUri(): string {
    return (
      this.configService.get<string>('COGNITO_REDIRECT_URI') ??
      'http://localhost:48673/api/auth/cognito/callback'
    );
  }

  private getScopes(): string[] {
    return (
      this.configService.get<string>('COGNITO_SCOPES') ?? 'openid email profile'
    )
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  private getAllowedProviders(): string[] {
    return (
      this.configService.get<string>('COGNITO_ALLOWED_PROVIDERS') ??
      'Google,Facebook,COGNITO'
    )
      .split(',')
      .map((provider) => provider.trim())
      .filter(Boolean);
  }
}
