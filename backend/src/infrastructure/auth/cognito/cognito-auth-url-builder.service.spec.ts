import { ConfigService } from '@nestjs/config';
import { CognitoAuthUrlBuilderService } from './cognito-auth-url-builder.service';

describe('CognitoAuthUrlBuilderService', () => {
  const makeConfigService = () =>
    ({
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          COGNITO_DOMAIN:
            'https://despensalista.auth.us-east-1.amazoncognito.com',
          COGNITO_CLIENT_ID: 'client-123',
          COGNITO_LOGOUT_REDIRECT_URI: 'http://localhost:48673/login',
        };

        return values[key];
      }),
    }) as unknown as ConfigService;

  it('builds Spanish Cognito authorization URLs with PKCE and provider routing', () => {
    const service = new CognitoAuthUrlBuilderService(makeConfigService());

    const output = service.buildAuthorizeUrl({
      state: 'state-value',
      nonce: 'nonce-value',
      codeChallenge: 'challenge-value',
      codeChallengeMethod: 'S256',
      redirectUri: 'http://localhost:48673/api/auth/cognito/callback',
      scopes: ['openid', 'email', 'profile'],
      provider: 'Google',
    });
    const url = new URL(output.url);

    expect(url.origin).toBe(
      'https://despensalista.auth.us-east-1.amazoncognito.com',
    );
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:48673/api/auth/cognito/callback',
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('nonce')).toBe('nonce-value');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    expect(url.searchParams.get('lang')).toBe('es');
  });

  it('builds Cognito logout URLs with client id and allowed logout uri', () => {
    const service = new CognitoAuthUrlBuilderService(makeConfigService());

    const url = new URL(service.buildLogoutUrl());

    expect(url.origin).toBe(
      'https://despensalista.auth.us-east-1.amazoncognito.com',
    );
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('logout_uri')).toBe(
      'http://localhost:48673/login',
    );
  });

  it('localizes email login without changing PKCE or state', () => {
    const service = new CognitoAuthUrlBuilderService(makeConfigService());

    const url = new URL(
      service.buildAuthorizeUrl({
        state: 'email-state',
        nonce: 'email-nonce',
        codeChallenge: 'email-challenge',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://localhost:48673/api/auth/cognito/callback',
        scopes: ['openid', 'email', 'profile'],
      }).url,
    );

    expect(url.searchParams.get('lang')).toBe('es');
    expect(url.searchParams.get('state')).toBe('email-state');
    expect(url.searchParams.get('code_challenge')).toBe('email-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('identity_provider')).toBe(false);
  });
});
