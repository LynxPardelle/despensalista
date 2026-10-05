import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CognitoAuthorizeUrlInput,
  CognitoAuthorizeUrlOutput,
  CognitoAuthUrlBuilder,
} from '../../../application/ports/cognito-auth.port';

@Injectable()
export class CognitoAuthUrlBuilderService implements CognitoAuthUrlBuilder {
  constructor(private readonly configService: ConfigService) {}

  buildAuthorizeUrl(
    input: CognitoAuthorizeUrlInput,
  ): CognitoAuthorizeUrlOutput {
    const url = new URL('/oauth2/authorize', this.getCognitoDomain());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.getClientId());
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('lang', 'es');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', input.codeChallengeMethod);

    if (input.provider) {
      url.searchParams.set('identity_provider', input.provider);
    }

    return { url: url.toString() };
  }

  buildLogoutUrl(): string {
    const url = new URL('/logout', this.getCognitoDomain());
    url.searchParams.set('client_id', this.getClientId());
    url.searchParams.set(
      'logout_uri',
      this.configService.get<string>('COGNITO_LOGOUT_REDIRECT_URI') ??
        'http://localhost:48673/login',
    );

    return url.toString();
  }

  private getCognitoDomain(): string {
    return (
      this.configService.get<string>('COGNITO_DOMAIN') ??
      'https://example.auth.us-east-1.amazoncognito.com'
    );
  }

  private getClientId(): string {
    return this.configService.get<string>('COGNITO_CLIENT_ID') ?? '';
  }
}
