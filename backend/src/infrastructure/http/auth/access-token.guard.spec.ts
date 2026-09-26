import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { CognitoTokenVerifier } from '../../../application/ports/cognito-auth.port';
import { UserDao } from '../../../application/ports/daos';
import { User } from '../../../domain/entities/user.entity';
import { UserAccountStatus } from '../../../domain/enums';
import { AccessTokenGuard } from './access-token.guard';
import { AuthCookieService } from './auth-cookie.service';

describe('AccessTokenGuard', () => {
  const makeUserDao = (): jest.Mocked<UserDao> => ({
    save: jest.fn(),
    findById: jest.fn(),
    findByAuthSubject: jest.fn(),
    findByEmail: jest.fn(),
    findByUsername: jest.fn(),
    beginAccountDeletion: jest.fn(),
    findPendingAccountDeletions: jest.fn(),
    claimPendingAccountDeletion: jest.fn(),
    deferAccountDeletion: jest.fn(),
    delete: jest.fn(),
  });

  const makeTokenVerifier = (): jest.Mocked<CognitoTokenVerifier> => ({
    verifyAccessToken: jest.fn(),
    verifyIdToken: jest.fn(),
  });

  const makeAuthCookieService = (): jest.Mocked<AuthCookieService> =>
    ({
      getAccessTokenFromRequest: jest.fn(),
      ensureXsrfForRequest: jest.fn(),
    }) as unknown as jest.Mocked<AuthCookieService>;

  const makeExecutionContext = (
    request: FastifyRequest & {
      authUser?: {
        userId: string;
        authSubjectId: string;
        authenticatedAt?: Date;
      };
    },
  ): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    }) as unknown as ExecutionContext;

  const makeActiveUser = (id = 'test-subject', deletionFenceExpiresAt?: Date) =>
    User.fromPrimitives({
      id,
      email: 'chef@example.com',
      username: 'chef',
      status: UserAccountStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      deletionFenceExpiresAt,
    });

  it('rejects requests without a Cognito access token cookie', async () => {
    const tokenVerifier = makeTokenVerifier();
    const userDao = makeUserDao();
    const authCookieService = makeAuthCookieService();
    authCookieService.getAccessTokenFromRequest.mockReturnValue(undefined);
    const guard = new AccessTokenGuard(
      tokenVerifier,
      userDao,
      authCookieService,
    );

    await expect(
      guard.canActivate(makeExecutionContext({} as FastifyRequest)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokenVerifier.verifyAccessToken.mock.calls).toHaveLength(0);
  });

  it('accepts a verified Cognito access token and sets request auth user', async () => {
    const tokenVerifier = makeTokenVerifier();
    const userDao = makeUserDao();
    const authCookieService = makeAuthCookieService();
    const request = { method: 'POST' } as FastifyRequest & {
      authUser?: {
        userId: string;
        authSubjectId: string;
        authenticatedAt?: Date;
      };
    };
    authCookieService.getAccessTokenFromRequest.mockReturnValue('access-token');
    tokenVerifier.verifyAccessToken.mockResolvedValue({
      sub: 'test-subject',
      authTime: 1812499200,
    });
    userDao.findByAuthSubject.mockResolvedValue(makeActiveUser('app-user-123'));
    const guard = new AccessTokenGuard(
      tokenVerifier,
      userDao,
      authCookieService,
    );

    await expect(
      guard.canActivate(makeExecutionContext(request)),
    ).resolves.toBe(true);

    expect(tokenVerifier.verifyAccessToken.mock.calls).toEqual([
      ['access-token'],
    ]);
    expect(authCookieService.ensureXsrfForRequest.mock.calls).toEqual([
      [request],
    ]);
    expect(request.authUser).toEqual({
      userId: 'app-user-123',
      authSubjectId: 'test-subject',
      authenticatedAt: new Date(1812499200 * 1000),
    });
  });

  it('converts Cognito verification failures into unauthorized responses', async () => {
    const tokenVerifier = makeTokenVerifier();
    const userDao = makeUserDao();
    const authCookieService = makeAuthCookieService();
    authCookieService.getAccessTokenFromRequest.mockReturnValue('stale-token');
    tokenVerifier.verifyAccessToken.mockRejectedValue(
      new Error('COGNITO_ISSUER is required'),
    );
    const guard = new AccessTokenGuard(
      tokenVerifier,
      userDao,
      authCookieService,
    );

    await expect(
      guard.canActivate(makeExecutionContext({} as FastifyRequest)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(userDao.findByAuthSubject.mock.calls).toHaveLength(0);
    expect(userDao.findById.mock.calls).toHaveLength(0);
  });

  it('rejects an existing session as soon as account deletion is fenced', async () => {
    const tokenVerifier = makeTokenVerifier();
    const userDao = makeUserDao();
    const authCookieService = makeAuthCookieService();
    authCookieService.getAccessTokenFromRequest.mockReturnValue('access-token');
    tokenVerifier.verifyAccessToken.mockResolvedValue({ sub: 'test-subject' });
    userDao.findByAuthSubject.mockResolvedValue(
      makeActiveUser('app-user-123', new Date('9999-12-31T23:59:59.999Z')),
    );
    const guard = new AccessTokenGuard(
      tokenVerifier,
      userDao,
      authCookieService,
    );

    await expect(
      guard.canActivate(makeExecutionContext({} as FastifyRequest)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authCookieService.ensureXsrfForRequest).not.toHaveBeenCalled();
  });
});
