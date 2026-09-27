import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoTokenVerifierService } from './cognito-token-verifier.service';

jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: jest.fn(),
  },
}));

describe('CognitoTokenVerifierService', () => {
  const makeConfigService = () =>
    ({
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          COGNITO_ISSUER:
            'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123',
          COGNITO_CLIENT_ID: 'client-123',
        };

        return values[key];
      }),
    }) as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies access tokens against the configured Cognito user pool and client', async () => {
    const createVerifier = jest.spyOn(CognitoJwtVerifier, 'create');
    const verify = jest.fn().mockResolvedValue({
      sub: 'cognito-sub',
      username: 'cognito-access-user',
      email: 'chef@example.com',
      preferred_username: 'chef',
      auth_time: 1812499200,
    });
    createVerifier.mockReturnValue({ verify } as never);
    const service = new CognitoTokenVerifierService(makeConfigService());

    const claims = await service.verifyAccessToken('access-token');

    expect(createVerifier.mock.calls[0]?.[0]).toEqual({
      userPoolId: 'us-east-1_abc123',
      tokenUse: 'access',
      clientId: 'client-123',
    });
    expect(verify).toHaveBeenCalledWith('access-token');
    expect(claims).toEqual({
      sub: 'cognito-sub',
      cognitoUsername: 'cognito-access-user',
      email: 'chef@example.com',
      emailVerified: undefined,
      preferredUsername: 'chef',
      name: undefined,
      nonce: undefined,
      authTime: 1812499200,
    });
  });

  it('verifies id tokens separately so callback nonce can be checked', async () => {
    const createVerifier = jest.spyOn(CognitoJwtVerifier, 'create');
    const verify = jest.fn().mockResolvedValue({
      sub: 'cognito-sub',
      'cognito:username': 'Google_authoritative-user',
      username: 'ignored-access-user',
      nonce: 'nonce-value',
      name: 'Chef',
    });
    createVerifier.mockReturnValue({ verify } as never);
    const service = new CognitoTokenVerifierService(makeConfigService());

    const claims = await service.verifyIdToken('id-token');

    expect(createVerifier.mock.calls[0]?.[0]).toEqual({
      userPoolId: 'us-east-1_abc123',
      tokenUse: 'id',
      clientId: 'client-123',
    });
    expect(verify).toHaveBeenCalledWith('id-token');
    expect(claims.nonce).toBe('nonce-value');
    expect(claims.cognitoUsername).toBe('Google_authoritative-user');
  });
});
