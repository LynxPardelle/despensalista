type LambdaModule = typeof import('./lambda');
import { ResumeAccountDeletionsUseCase } from './application/use-cases/resume-account-deletions.use-case';
import { CognitoTokenClientService } from './infrastructure/auth/cognito/cognito-token-client.service';
import { CognitoTokenVerifierService } from './infrastructure/auth/cognito/cognito-token-verifier.service';

describe('lambda handler', () => {
  let lambda: LambdaModule;
  const origin = 'https://dev.despensalista.lynxpardelle.com';
  const secondaryOrigin = 'https://despensalista.com';
  const originHeaders = {
    'x-despensalista-origin-verify': 'test-origin-verification-token',
  };
  const previousEnv = process.env;

  beforeAll(async () => {
    process.env = {
      ...previousEnv,
      NODE_ENV: 'test',
      PERSISTENCE_PROVIDER: 'dynamodb',
      DYNAMODB_USERS_TABLE: 'test-users',
      DYNAMODB_PRODUCTS_TABLE: 'test-products',
      DYNAMODB_PRODUCT_TYPES_TABLE: 'test-product-types',
      DYNAMODB_INVENTORY_LOTS_TABLE: 'test-inventory-lots',
      CORS_ORIGIN: origin,
      COGNITO_ENABLED: 'true',
      COGNITO_ISSUER:
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_7MDhLOulC',
      COGNITO_DOMAIN: 'https://cognito.example.invalid',
      COGNITO_CLIENT_ID: 'test-client',
      COGNITO_REDIRECT_URI: `${origin}/api/auth/cognito/callback`,
      COGNITO_LOGOUT_REDIRECT_URI: `${origin}/login`,
      COGNITO_SECONDARY_WEB_ORIGIN: secondaryOrigin,
      COGNITO_ALLOWED_PROVIDERS: 'COGNITO,Google',
      ORIGIN_VERIFY_HEADER_NAME: 'x-despensalista-origin-verify',
      ORIGIN_VERIFY_HEADER_VALUE:
        originHeaders['x-despensalista-origin-verify'],
      AUTH_COOKIE_SECURE: 'true',
      GOOGLE_MFA_TABLE: 'despensalista-dev-google-mfa',
      GOOGLE_MFA_ORIGIN: origin,
    };
    lambda = await import('./lambda');
  });

  afterAll(async () => {
    await lambda.closeCachedAppForTest();
    process.env = previousEnv;
  });

  it('serves the existing API through API Gateway events', async () => {
    const response = await lambda.handler({
      rawPath: '/api/healthz',
      headers: { ...originHeaders, host: 'api.despensalista.test' },
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

  it('uses the secondary Cognito callback only through the verified API origin', async () => {
    const event = {
      rawPath: '/api/auth/cognito/login',
      rawQueryString: 'provider=Google',
      headers: { 'x-despensalista-viewer-host': 'despensalista.com' },
      requestContext: { http: { method: 'GET' } },
    };

    const directResponse = await lambda.handler(event);
    expect(directResponse.statusCode).toBe(403);

    const proxyResponse = await lambda.handler({
      ...event,
      headers: { ...event.headers, ...originHeaders },
    });
    expect(proxyResponse.statusCode).toBe(302);
    expect(
      new URL(proxyResponse.headers.location).searchParams.get('redirect_uri'),
    ).toBe(`${secondaryOrigin}/api/auth/cognito/callback`);
    expect(proxyResponse.cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^despensalista_cognito_code_verifier=.+HttpOnly/,
        ),
      ]),
    );
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
        headers: { ...originHeaders, origin, 'x-xsrf-token': 'test-xsrf' },
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
    }
  });
});
