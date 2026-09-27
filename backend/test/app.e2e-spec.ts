import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as request from 'supertest';
import {
  ApiMetricsService,
  ApiMetricsSnapshot,
} from '../src/application/services/api-metrics.service';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { configureApp } from '../src/app.setup';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    app = await createTestApp(false);
  });

  afterEach(async () => {
    await app.close();
  });

  it('/api (GET)', () => {
    return request(app.getHttpServer()).get('/api').expect(200).expect({
      status: 'ok',
      service: 'despensalista-backend',
    });
  });

  it('/api/healthz (GET)', () => {
    return request(app.getHttpServer()).get('/api/healthz').expect(200).expect({
      status: 'ok',
      service: 'despensalista-backend',
    });
  });

  it('rejects direct origin access when origin verification is enabled', async () => {
    const guarded = await createTestApp(false, 'origin-secret');
    try {
      await request(guarded.getHttpServer()).get('/api/healthz').expect(403);
      await request(guarded.getHttpServer())
        .get('/api/healthz')
        .set('x-origin-verify', 'wrong')
        .expect(403);
      await request(guarded.getHttpServer())
        .get('/api/healthz')
        .set('x-origin-verify', 'origin-secret')
        .expect(200);
    } finally {
      await guarded.close();
    }
  });

  it('/api/metrics (GET)', async () => {
    await request(app.getHttpServer()).get('/api/healthz').expect(200);

    await request(app.getHttpServer())
      .get('/api/metrics')
      .set('X-Metrics-Token', 'test-metrics-token')
      .expect(200)
      .expect((response) => {
        const body = response.body as ApiMetricsSnapshot;
        expect(body.service).toBe('despensalista-backend');
        expect(body.totalRequests).toBeGreaterThanOrEqual(1);
        expect(body.routes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              method: 'GET',
              route: '/api/healthz',
            }),
          ]),
        );
      });
  });

  it('/api/docs/ (GET) when Swagger is enabled', async () => {
    const swaggerAppPromise = createTestApp(true);
    await expect(swaggerAppPromise).resolves.toBeDefined();
    const swaggerApp = await swaggerAppPromise;

    try {
      await request(swaggerApp.getHttpServer())
        .get('/api/docs/')
        .expect(200)
        .expect('Content-Type', /text\/html/);
    } finally {
      await swaggerApp.close();
    }
  });
});

async function createTestApp(
  swaggerEnabled: boolean,
  originSecret?: string,
): Promise<NestFastifyApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            API_PREFIX: 'api',
            CORS_ORIGIN: 'http://localhost:4200',
            HELMET_ENABLED: 'false',
            ORIGIN_VERIFY_HEADER_NAME: originSecret
              ? 'x-origin-verify'
              : undefined,
            ORIGIN_VERIFY_HEADER_VALUE: originSecret,
            METRICS_ACCESS_TOKEN: 'test-metrics-token',
            SWAGGER_ENABLED: swaggerEnabled ? 'true' : 'false',
          }),
        ],
      }),
    ],
    controllers: [AppController],
    providers: [AppService, ApiMetricsService],
  }).compile();
  const testApp = moduleFixture.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

  try {
    await configureApp(testApp, testApp.get(ConfigService));
    await testApp.init();
    await testApp.getHttpAdapter().getInstance().ready();
    return testApp;
  } catch (error) {
    await testApp.close();
    throw error;
  }
}
