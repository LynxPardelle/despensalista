type LambdaModule = typeof import('./lambda');
import { ResumeAccountDeletionsUseCase } from './application/use-cases/resume-account-deletions.use-case';
import { CognitoTokenClientService } from './infrastructure/auth/cognito/cognito-token-client.service';
import { CognitoTokenVerifierService } from './infrastructure/auth/cognito/cognito-token-verifier.service';

describe('lambda handler', () => {
  let lambda: LambdaModule;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PERSISTENCE_PROVIDER = 'dynamodb';
    process.env.DYNAMODB_USERS_TABLE = 'test-users';
    process.env.DYNAMODB_PRODUCTS_TABLE = 'test-products';
    process.env.DYNAMODB_PRODUCT_TYPES_TABLE = 'test-product-types';
    process.env.DYNAMODB_INVENTORY_LOTS_TABLE = 'test-inventory-lots';
    process.env.CORS_ORIGIN = 'https://despensalista.test';
    process.env.COGNITO_ENABLED = 'false';
    lambda = await import('./lambda');
  });

  afterAll(async () => {
    await lambda.closeCachedAppForTest();
  });

  it('serves the existing API through API Gateway events', async () => {
    const response = await lambda.handler({
      rawPath: '/api/healthz',
      headers: { host: 'api.despensalista.test' },
      requestContext: {
        http: {
          method: 'GET',
          path: '/api/healthz',
          sourceIp: '127.0.0.1',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      service: 'despensalista-backend',
    });
  });

  it('routes only the private scheduled event to the deletion worker', async () => {
    const resume = jest
      .spyOn(ResumeAccountDeletionsUseCase.prototype, 'execute')
      .mockResolvedValue({ processed: 1 });

    await expect(
      lambda.handler({
        source: 'despensalista.account-deletion-worker',
        'detail-type': 'resume',
      }),
    ).resolves.toEqual({ processed: 1 });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('returns fresh session cookies with the Google WebAuthn 403 response', async () => {
    await lambda.closeCachedAppForTest();
    const origin = 'https://dev.despensalista.lynxpardelle.com';
    const previousEnv = process.env;
    process.env = {
      ...previousEnv,
      COGNITO_ENABLED: 'true',
      COGNITO_ISSUER:
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_7MDhLOulC',
      COGNITO_DOMAIN: 'https://cognito.example.invalid',
      COGNITO_CLIENT_ID: 'test-client',
      COGNITO_REDIRECT_URI: `${origin}/api/auth/cognito/callback`,
      COGNITO_LOGOUT_REDIRECT_URI: `${origin}/login`,
      COGNITO_ALLOWED_PROVIDERS: 'COGNITO,Google',
      AUTH_COOKIE_SECURE: 'true',
      GOOGLE_MFA_TABLE: 'despensalista-dev-google-mfa',
      GOOGLE_MFA_ORIGIN: origin,
    };
    const refresh = jest
      .spyOn(CognitoTokenClientService.prototype, 'refresh')
      .mockResolvedValue({
        accessToken: 'new-access-token',
        idToken: 'unused-id-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });
    const verify = jest
      .spyOn(CognitoTokenVerifierService.prototype, 'verifyAccessToken')
      .mockResolvedValue({
        sub: 'test-subject',
        cognitoUsername: 'Google_test-subject',
        originJti: 'test-session',
      });

    try {
      const response = await lambda.handler({
        rawPath: '/api/auth/refresh',
        cookies: [
          'despensalista_refresh_token=test-refresh',
          'XSRF-TOKEN=test-xsrf',
        ],
        headers: { origin, 'x-xsrf-token': 'test-xsrf' },
        requestContext: { http: { method: 'POST' } },
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        statusCode: 403,
        code: 'GOOGLE_MFA_REQUIRED',
      });
      expect(response.cookies).toEqual([
        expect.stringMatching(/^despensalista_access_token=new-access-token;/),
        expect.stringMatching(/^despensalista_refresh_token=test-refresh;/),
        expect.stringMatching(/^XSRF-TOKEN=[a-zA-Z0-9_-]+;/),
      ]);
    } finally {
      refresh.mockRestore();
      verify.mockRestore();
      process.env = previousEnv;
      await lambda.closeCachedAppForTest();
    }
  });
});
