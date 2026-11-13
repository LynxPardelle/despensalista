import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedException } from '@nestjs/common';
import {
  CognitoAuthUrlBuilder,
  CognitoTokenClient,
  CognitoTokenVerifier,
} from '../../../application/ports/cognito-auth.port';
import { CognitoAuthTransactionService } from '../../../application/services/cognito-auth-transaction.service';
import { CognitoProfileSyncService } from '../../../application/services/cognito-profile-sync.service';
import { GetCurrentUserUseCase } from '../../../application/use-cases/get-current-user.use-case';
import { User } from '../../../domain/entities/user.entity';
import { UserAccountStatus } from '../../../domain/enums';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { GoogleMfaRequiredException } from '../auth/google-mfa.constants';
import { GoogleMfaService } from '../auth/google-mfa.service';
import { AuthController } from './auth.controller';

describe('AuthController Cognito flow', () => {
  const makeUser = () =>
    User.fromPrimitives({
      id: 'cognito-sub-123',
      email: 'chef@example.com',
      username: 'chef',
      status: UserAccountStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

  const makeController = (
    googleMfa = new GoogleMfaService(new ConfigService()),
  ) => {
    const getCurrentUserUseCase = {
      execute: jest.fn().mockResolvedValue(makeUser()),
      executeByAuthSubject: jest.fn().mockResolvedValue(makeUser()),
    } as unknown as jest.Mocked<GetCurrentUserUseCase>;
    const transactionService = {
      createTransaction: jest.fn().mockReturnValue({
        state: 'state-value',
        nonce: 'nonce-value',
        codeVerifier: 'code-verifier',
        codeChallenge: 'code-challenge',
        codeChallengeMethod: 'S256',
      }),
      normalizeProvider: jest.fn().mockReturnValue('Google'),
      normalizeRedirectTo: jest.fn().mockReturnValue('/pantry'),
      assertStateMatches: jest.fn(),
    } as unknown as jest.Mocked<CognitoAuthTransactionService>;
    const profileSyncService = {
      syncFromClaims: jest.fn().mockResolvedValue(makeUser()),
    } as unknown as jest.Mocked<CognitoProfileSyncService>;
    const authUrlBuilder = {
      buildAuthorizeUrl: jest.fn().mockReturnValue({
        url: 'https://cognito.example/oauth2/authorize',
      }),
      buildLogoutUrl: jest
        .fn()
        .mockReturnValue('https://cognito.example/logout'),
    } as jest.Mocked<CognitoAuthUrlBuilder>;
    const tokenClient = {
      exchangeCode: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      }),
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'new-access-token',
        idToken: 'new-id-token',
        expiresIn: 3600,
        tokenType: 'Bearer',
      }),
      revoke: jest.fn().mockResolvedValue(undefined),
    } as jest.Mocked<CognitoTokenClient>;
    const tokenVerifier = {
      verifyAccessToken: jest
        .fn()
        .mockResolvedValue({ sub: 'cognito-sub-123' }),
      verifyIdToken: jest.fn().mockResolvedValue({
        sub: 'cognito-sub-123',
        email: 'chef@example.com',
        nonce: 'nonce-value',
      }),
    } as jest.Mocked<CognitoTokenVerifier>;
    const authCookieService = {
      setCognitoAuthTransactionCookies: jest.fn(),
      getCognitoAuthTransactionFromRequest: jest.fn().mockReturnValue({
        state: 'state-value',
        nonce: 'nonce-value',
        codeVerifier: 'code-verifier',
        redirectTo: '/pantry',
      }),
      clearCognitoAuthTransactionCookies: jest.fn(),
      setSessionCookies: jest.fn(),
      getRefreshTokenFromRequest: jest.fn().mockReturnValue('refresh-token'),
      clearSessionCookies: jest.fn(),
      clearGoogleMfaCookie: jest.fn(),
      createXsrfToken: jest.fn().mockReturnValue('xsrf-token'),
      ensureXsrfForRequest: jest.fn(),
    } as unknown as jest.Mocked<AuthCookieService>;
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          COGNITO_ENABLED: 'true',
          COGNITO_REDIRECT_URI:
            'http://localhost:48673/api/auth/cognito/callback',
          COGNITO_SCOPES: 'openid email profile',
          COGNITO_ALLOWED_PROVIDERS: 'Google,Facebook,COGNITO',
        };

        return values[key];
      }),
    } as unknown as ConfigService;

    return {
      controller: new AuthController(
        getCurrentUserUseCase,
        transactionService,
        profileSyncService,
        authUrlBuilder,
        tokenClient,
        tokenVerifier,
        authCookieService,
        configService,
        googleMfa,
      ),
      getCurrentUserUseCase,
      transactionService,
      profileSyncService,
      authUrlBuilder,
      tokenClient,
      tokenVerifier,
      authCookieService,
    };
  };

  const makeReply = () =>
    ({
      redirect: jest.fn(),
      setCookie: jest.fn(),
      clearCookie: jest.fn(),
    }) as unknown as jest.Mocked<FastifyReply>;

  it('renews Cognito cookies without exposing a profile before Google WebAuthn', async () => {
    const mfaRequired = new GoogleMfaRequiredException();
    const googleMfa = {
      assertVerified: jest.fn().mockRejectedValue(mfaRequired),
    } as unknown as GoogleMfaService;
    const { controller, authCookieService, getCurrentUserUseCase } =
      makeController(googleMfa);
    const reply = makeReply();

    await expect(controller.refresh({} as FastifyRequest, reply)).rejects.toBe(
      mfaRequired,
    );
    expect(authCookieService.setSessionCookies).toHaveBeenCalledWith(reply, {
      accessToken: 'new-access-token',
      refreshToken: 'refresh-token',
      xsrfToken: 'xsrf-token',
    });
    expect(getCurrentUserUseCase.executeByAuthSubject).not.toHaveBeenCalled();
  });

  it('starts Cognito login by storing transaction cookies and redirecting to Hosted UI', () => {
    const { controller, authCookieService, authUrlBuilder } = makeController();
    const reply = makeReply();

    controller.startCognitoLogin('Google', '/pantry', reply);

    expect(
      authCookieService.setCognitoAuthTransactionCookies.mock.calls[0],
    ).toEqual([
      reply,
      {
        state: 'state-value',
        nonce: 'nonce-value',
        codeVerifier: 'code-verifier',
        redirectTo: '/pantry',
      },
    ]);
    expect(authUrlBuilder.buildAuthorizeUrl.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: 'Google',
        scopes: ['openid', 'email', 'profile'],
      }),
    );
    expect(reply.redirect.mock.calls[0]).toEqual([
      'https://cognito.example/oauth2/authorize',
      302,
    ]);
  });

  it('starts native Cognito login without forcing an identity provider', () => {
    const { controller, transactionService, authUrlBuilder } = makeController();
    const reply = makeReply();
    transactionService.normalizeProvider.mockReturnValue('COGNITO');

    controller.startCognitoLogin('COGNITO', '/pantry', reply);

    expect(authUrlBuilder.buildAuthorizeUrl.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: undefined,
      }),
    );
  });

  it('lists the configured Cognito providers for the login screen', () => {
    const { controller } = makeController();

    expect(controller.getCognitoProviders()).toEqual({
      providers: ['Google', 'Facebook', 'COGNITO'],
    });
  });

  it('completes callback by validating state and nonce, syncing profile, setting cookies, and redirecting', async () => {
    const {
      controller,
      authCookieService,
      transactionService,
      tokenClient,
      tokenVerifier,
      profileSyncService,
    } = makeController();
    const reply = makeReply();

    await controller.completeCognitoLogin(
      'authorization-code',
      'state-value',
      {} as FastifyRequest,
      reply,
    );

    expect(transactionService.assertStateMatches.mock.calls[0]).toEqual([
      'state-value',
      'state-value',
    ]);
    expect(tokenClient.exchangeCode.mock.calls[0]?.[0]).toEqual({
      code: 'authorization-code',
      codeVerifier: 'code-verifier',
      redirectUri: 'http://localhost:48673/api/auth/cognito/callback',
    });
    expect(tokenVerifier.verifyIdToken.mock.calls[0]).toEqual(['id-token']);
    expect(profileSyncService.syncFromClaims.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sub: 'cognito-sub-123' }),
    );
    expect(authCookieService.setSessionCookies.mock.calls[0]).toEqual([
      reply,
      {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        xsrfToken: 'xsrf-token',
      },
    ]);
    expect(reply.redirect.mock.calls[0]).toEqual(['/pantry', 302]);
  });

  it('clears transaction cookies and redirects to login when callback state is invalid', async () => {
    const { controller, authCookieService, transactionService, tokenClient } =
      makeController();
    const reply = makeReply();
    transactionService.assertStateMatches.mockImplementation(() => {
      throw new UnauthorizedException('Invalid Cognito auth state');
    });

    await controller.completeCognitoLogin(
      'authorization-code',
      'stale-state',
      {} as FastifyRequest,
      reply,
    );

    expect(
      authCookieService.clearCognitoAuthTransactionCookies,
    ).toHaveBeenCalledWith(reply);
    expect(tokenClient.exchangeCode).not.toHaveBeenCalled();
    expect(reply.redirect.mock.calls[0]).toEqual([
      '/login?authError=cognito_state',
      302,
    ]);
  });

  it('refreshes Cognito tokens and returns the current user', async () => {
    const { controller, authCookieService, getCurrentUserUseCase } =
      makeController();
    const reply = makeReply();

    const response = await controller.refresh({} as FastifyRequest, reply);

    expect(authCookieService.setSessionCookies.mock.calls[0]).toEqual([
      reply,
      {
        accessToken: 'new-access-token',
        refreshToken: 'refresh-token',
        xsrfToken: 'xsrf-token',
      },
    ]);
    expect(getCurrentUserUseCase.execute.mock.calls).toHaveLength(0);
    expect(getCurrentUserUseCase.executeByAuthSubject.mock.calls[0]).toEqual([
      'cognito-sub-123',
    ]);
    expect(response.id).toBe('cognito-sub-123');
  });

  it('revokes refresh token, clears local cookies, and returns Cognito logout URL', async () => {
    const { controller, authCookieService, tokenClient } = makeController();
    const reply = makeReply();

    const response = await controller.logout({} as FastifyRequest, reply);

    expect(tokenClient.revoke.mock.calls[0]).toEqual([
      { refreshToken: 'refresh-token' },
    ]);
    expect(authCookieService.clearSessionCookies.mock.calls[0]).toEqual([
      reply,
    ]);
    expect(response).toEqual({ logoutUrl: 'https://cognito.example/logout' });
  });

  it('clears local cookies even when Cognito revocation fails', async () => {
    const { controller, authCookieService, tokenClient } = makeController();
    const reply = makeReply();
    tokenClient.revoke.mockRejectedValueOnce(new Error('revoke failed'));

    const response = await controller.logout({} as FastifyRequest, reply);

    expect(authCookieService.clearSessionCookies.mock.calls[0]).toEqual([
      reply,
    ]);
    expect(response).toEqual({ logoutUrl: 'https://cognito.example/logout' });
  });

  it('requires XSRF, revokes refresh token, clears local cookies, and redirects for browser logout forms', async () => {
    const { controller, authCookieService, tokenClient } = makeController();
    const request = { method: 'POST' } as FastifyRequest;
    const reply = makeReply();

    await controller.logoutFromBrowser(request, reply);

    expect(tokenClient.revoke.mock.calls[0]).toEqual([
      { refreshToken: 'refresh-token' },
    ]);
    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(authCookieService.clearSessionCookies.mock.calls[0]).toEqual([
      reply,
    ]);
    expect(reply.redirect.mock.calls[0]).toEqual([
      'https://cognito.example/logout',
      302,
    ]);
  });
});
