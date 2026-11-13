import { randomBytes } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  GOOGLE_MFA_COOKIE,
  GOOGLE_MFA_COOKIE_OPTIONS,
  LEGACY_GOOGLE_MFA_COOKIE,
} from './google-mfa.constants';

export interface AuthSessionCookieTokens {
  accessToken: string;
  refreshToken?: string;
  xsrfToken: string;
}

export interface CognitoAuthTransactionCookies {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectTo: string;
}

@Injectable()
export class AuthCookieService {
  readonly accessCookieName = 'despensalista_access_token';
  readonly refreshCookieName = 'despensalista_refresh_token';
  readonly xsrfCookieName = 'XSRF-TOKEN';
  readonly xsrfHeaderName = 'x-xsrf-token';
  readonly cognitoStateCookieName = 'despensalista_cognito_state';
  readonly cognitoNonceCookieName = 'despensalista_cognito_nonce';
  readonly cognitoCodeVerifierCookieName =
    'despensalista_cognito_code_verifier';
  readonly cognitoRedirectToCookieName = 'despensalista_cognito_redirect_to';

  constructor(private readonly configService: ConfigService) {}

  setSessionCookies(
    reply: FastifyReply,
    session: AuthSessionCookieTokens,
  ): void {
    reply.setCookie(this.accessCookieName, session.accessToken, {
      ...this.getBaseCookieOptions(),
      httpOnly: true,
      maxAge: this.getAccessCookieMaxAgeSeconds(),
      path: '/',
    });

    if (session.refreshToken) {
      reply.setCookie(this.refreshCookieName, session.refreshToken, {
        ...this.getBaseCookieOptions(),
        httpOnly: true,
        maxAge: this.getRefreshCookieMaxAgeSeconds(),
        path: '/api/auth',
      });
    }

    reply.setCookie(this.xsrfCookieName, session.xsrfToken, {
      ...this.getBaseCookieOptions(),
      httpOnly: false,
      maxAge: this.getRefreshCookieMaxAgeSeconds(),
      path: '/',
    });
  }

  clearSessionCookies(reply: FastifyReply): void {
    this.clearCookieAcrossDomainModes(reply, this.accessCookieName, '/');
    this.clearCookieAcrossDomainModes(
      reply,
      this.refreshCookieName,
      '/api/auth',
    );
    this.clearCookieAcrossDomainModes(reply, this.xsrfCookieName, '/');
    this.clearGoogleMfaCookie(reply);
  }

  clearGoogleMfaCookie(reply: FastifyReply): void {
    if (this.configService.get<string>('GOOGLE_MFA_TABLE')) {
      reply.clearCookie(GOOGLE_MFA_COOKIE, GOOGLE_MFA_COOKIE_OPTIONS);
      reply.clearCookie(LEGACY_GOOGLE_MFA_COOKIE, GOOGLE_MFA_COOKIE_OPTIONS);
    }
  }

  setCognitoAuthTransactionCookies(
    reply: FastifyReply,
    transaction: CognitoAuthTransactionCookies,
  ): void {
    const options = {
      ...this.getBaseCookieOptions(),
      httpOnly: true,
      maxAge: this.getCognitoTransactionTtlSeconds(),
      path: '/api/auth/cognito',
    };

    reply.setCookie(this.cognitoStateCookieName, transaction.state, options);
    reply.setCookie(this.cognitoNonceCookieName, transaction.nonce, options);
    reply.setCookie(
      this.cognitoCodeVerifierCookieName,
      transaction.codeVerifier,
      options,
    );
    reply.setCookie(
      this.cognitoRedirectToCookieName,
      transaction.redirectTo,
      options,
    );
  }

  getCognitoAuthTransactionFromRequest(
    request: FastifyRequest,
  ): CognitoAuthTransactionCookies {
    return {
      state: request.cookies?.[this.cognitoStateCookieName] ?? '',
      nonce: request.cookies?.[this.cognitoNonceCookieName] ?? '',
      codeVerifier: request.cookies?.[this.cognitoCodeVerifierCookieName] ?? '',
      redirectTo:
        request.cookies?.[this.cognitoRedirectToCookieName] ?? '/pantry',
    };
  }

  clearCognitoAuthTransactionCookies(reply: FastifyReply): void {
    this.clearCookieAcrossDomainModes(
      reply,
      this.cognitoStateCookieName,
      '/api/auth/cognito',
    );
    this.clearCookieAcrossDomainModes(
      reply,
      this.cognitoNonceCookieName,
      '/api/auth/cognito',
    );
    this.clearCookieAcrossDomainModes(
      reply,
      this.cognitoCodeVerifierCookieName,
      '/api/auth/cognito',
    );
    this.clearCookieAcrossDomainModes(
      reply,
      this.cognitoRedirectToCookieName,
      '/api/auth/cognito',
    );
  }

  createXsrfToken(): string {
    return randomBytes(24).toString('base64url');
  }

  getRefreshTokenFromRequest(request: FastifyRequest): string | undefined {
    return request.cookies?.[this.refreshCookieName];
  }

  getAccessTokenFromRequest(request: FastifyRequest): string | undefined {
    return request.cookies?.[this.accessCookieName];
  }

  ensureXsrfForRequest(request: FastifyRequest): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      return;
    }

    const cookieValue = request.cookies?.[this.xsrfCookieName];
    const headerValue = request.headers[this.xsrfHeaderName] as
      | string
      | undefined;

    if (!cookieValue || !headerValue || cookieValue !== headerValue) {
      throw new UnauthorizedException('Invalid XSRF token');
    }
  }

  private getBaseCookieOptions(): {
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    domain?: string;
  } {
    return {
      secure: this.getCookieSecure(),
      sameSite: this.getCookieSameSite(),
      domain: this.getCookieDomain(),
    };
  }

  private getCookieSecure(): boolean {
    const configuredSecure =
      this.configService.get<string>('AUTH_COOKIE_SECURE');

    if (configuredSecure) {
      return configuredSecure === 'true';
    }

    return (
      (this.configService.get<string>('NODE_ENV') ?? 'development') ===
      'production'
    );
  }

  private getCookieSameSite(): 'lax' | 'strict' | 'none' {
    const configuredSameSite = (
      this.configService.get<string>('AUTH_COOKIE_SAME_SITE') ?? 'lax'
    ).toLowerCase();

    if (
      configuredSameSite === 'lax' ||
      configuredSameSite === 'strict' ||
      configuredSameSite === 'none'
    ) {
      return configuredSameSite;
    }

    return 'lax';
  }

  private getCookieDomain(): string | undefined {
    return this.configService.get<string>('AUTH_COOKIE_DOMAIN') || undefined;
  }

  private clearCookieAcrossDomainModes(
    reply: FastifyReply,
    name: string,
    path: string,
  ): void {
    reply.clearCookie(name, { path });

    const domain = this.getCookieDomain();
    if (domain) {
      reply.clearCookie(name, { path, domain });
    }
  }

  private getAccessCookieMaxAgeSeconds(): number {
    return Number(
      this.configService.get<string>('AUTH_ACCESS_COOKIE_TTL_SECONDS') ?? '900',
    );
  }

  private getRefreshCookieMaxAgeSeconds(): number {
    return Number(
      this.configService.get<string>('AUTH_REFRESH_COOKIE_TTL_SECONDS') ??
        '2592000',
    );
  }

  private getCognitoTransactionTtlSeconds(): number {
    return Number(
      this.configService.get<string>('COGNITO_AUTH_TRANSACTION_TTL_SECONDS') ??
        '900',
    );
  }
}
