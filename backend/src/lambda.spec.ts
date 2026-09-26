type LambdaModule = typeof import('./lambda');
import { ResumeAccountDeletionsUseCase } from './application/use-cases/resume-account-deletions.use-case';

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
});
