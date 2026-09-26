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

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(COGNITO_TOKEN_VERIFIER)
    private readonly cognitoTokenVerifier: CognitoTokenVerifier,
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
    private readonly authCookieService: AuthCookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        authUser?: AuthenticatedUser;
      }
    >();
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
    request.authUser = {
      userId: user.id.toString(),
      authSubjectId: claims.sub,
      authenticatedAt: claims.authTime
        ? new Date(claims.authTime * 1000)
        : undefined,
    };

    return true;
  }

  private async verifyAccessToken(accessToken: string) {
    try {
      return await this.cognitoTokenVerifier.verifyAccessToken(accessToken);
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
