import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { COGNITO_TOKEN_VERIFIER, USER_DAO } from '../../../application/tokens';
import { CognitoTokenVerifier } from '../../../application/ports/cognito-auth.port';
import { UserDao } from '../../../application/ports/daos';
import { AuthenticatedUser } from './authenticated-user.interface';
import { AuthCookieService } from './auth-cookie.service';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserAccountStatus } from '../../../domain/enums';
import { GoogleMfaService } from './google-mfa.service';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(COGNITO_TOKEN_VERIFIER)
    private readonly cognitoTokenVerifier: CognitoTokenVerifier,
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
    private readonly authCookieService: AuthCookieService,
    private readonly googleMfa: GoogleMfaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        authUser?: AuthenticatedUser;
      }
    >();
    const { claims, authUser } = await this.authenticatePending(request);
    await this.googleMfa.assertVerified(claims, request);
    request.authUser = authUser;

    return true;
  }

  async authenticatePending(request: FastifyRequest) {
    const accessToken =
      this.authCookieService.getAccessTokenFromRequest(request);

    if (!accessToken) {
      throw new UnauthorizedException('Access token is required');
    }

    const claims = await this.verifyAccessToken(accessToken);
    const user =
      (await this.userDao.findByAuthSubject(claims.sub)) ??
      (await this.userDao.findById(UserId.fromString(claims.sub)));

    if (
      !user ||
      user.status !== UserAccountStatus.ACTIVE ||
      user.isAccountDeletionPending()
    ) {
      throw new UnauthorizedException('Invalid authenticated user');
    }

    this.authCookieService.ensureXsrfForRequest(request);
    const authUser: AuthenticatedUser = {
      userId: user.id.toString(),
      authSubjectId: claims.sub,
      authenticatedAt: claims.authTime
        ? new Date(claims.authTime * 1000)
        : undefined,
    };

    return { claims, authUser };
  }

  private async verifyAccessToken(accessToken: string) {
    try {
      return await this.cognitoTokenVerifier.verifyAccessToken(accessToken);
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
