import { Type, ValidationPipe } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { ConfigService } from '@nestjs/config';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ApiMetricsAlertSinkService } from './application/services/api-metrics-alert-sink.service';
import { ApiMetricsService } from './application/services/api-metrics.service';
import { registerApiMetricsHook } from './infrastructure/http/api-metrics.hook';
import { ApiExceptionFilter } from './infrastructure/http/filters/api-exception.filter';
import { registerRequestIdHook } from './infrastructure/http/request-id';

export async function configureApp(
  app: NestFastifyApplication,
  configService: ConfigService,
): Promise<void> {
  const apiPrefix = configService.get<string>('API_PREFIX') ?? 'api';
  const corsOrigin = parseCorsOrigins(
    configService.get<string>('CORS_ORIGIN') ?? 'http://localhost:4200',
  );
  const helmetEnabled = configService.get<string>('HELMET_ENABLED') !== 'false';
  const rateLimitEnabled =
    configService.get<string>('RATE_LIMIT_ENABLED') !== 'false';
  const rateLimitTrustProxy =
    configService.get<string>('RATE_LIMIT_TRUST_PROXY') === 'true';
  const swaggerEnabled =
    configService.get<string>('SWAGGER_ENABLED') === 'true';
  const metricsService = app.get(ApiMetricsService, { strict: false });
  const metricsAlertSink = getOptionalProvider(app, ApiMetricsAlertSinkService);

  app.setGlobalPrefix(apiPrefix);
  const originHeader = configService.get<string>('ORIGIN_VERIFY_HEADER_NAME');
  const originSecret = configService.get<string>('ORIGIN_VERIFY_HEADER_VALUE');
  if (Boolean(originHeader) !== Boolean(originSecret)) {
    throw new Error('Origin verification requires both header name and value');
  }
  if (originHeader && originSecret) {
    const expected = Buffer.from(originSecret);
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRequest', async (request, reply) => {
        const header = request.headers[originHeader.toLowerCase()];
        const actual = Buffer.from(typeof header === 'string' ? header : '');
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          await reply.code(403).send({ statusCode: 403, message: 'Forbidden' });
        }
      });
  }
  app.enableCors({ origin: corsOrigin, credentials: true });
  registerRequestIdHook(app.getHttpAdapter().getInstance());
  metricsService.configure({
    slowRequestThresholdMs:
      configService.get<number>('METRICS_SLOW_REQUEST_THRESHOLD_MS') ?? 1000,
    errorRateAlertThreshold:
      configService.get<number>('METRICS_ERROR_RATE_ALERT_THRESHOLD') ?? 0.05,
    maxRoutes: configService.get<number>('METRICS_MAX_ROUTES') ?? 50,
  });
  registerApiMetricsHook(
    app.getHttpAdapter().getInstance(),
    metricsService,
    metricsAlertSink,
  );
  await app.register(fastifyCookie);

  if (rateLimitEnabled) {
    await app.register(fastifyRateLimit, {
      max: configService.get<number>('RATE_LIMIT_MAX') ?? 120,
      timeWindow:
        configService.get<number | string>('RATE_LIMIT_TIME_WINDOW') ??
        '1 minute',
      keyGenerator: createRateLimitKeyGenerator(rateLimitTrustProxy),
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());

  if (helmetEnabled) {
    await app.register(fastifyHelmet);
  }

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(
        configService.get<string>('SWAGGER_TITLE') ?? 'Despensa Lista API',
      )
      .setDescription(
        configService.get<string>('SWAGGER_DESCRIPTION') ??
          'Despensa Lista API documentation',
      )
      .setVersion(configService.get<string>('SWAGGER_VERSION') ?? '1.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document);
  }
}

function parseCorsOrigins(corsOrigin: string): string[] {
  return corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createRateLimitKeyGenerator(
  trustProxy: boolean,
): (request: FastifyRequest) => string {
  return (request) => {
    if (trustProxy) {
      const forwardedFor = getFirstForwardedFor(
        request.headers['x-forwarded-for'],
      );

      if (forwardedFor) {
        return forwardedFor;
      }
    }

    return request.ip;
  };
}

function getFirstForwardedFor(
  value: string | string[] | undefined,
): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue
    ?.split(',')
    .map((part) => part.trim())
    .find(Boolean);
}

function getOptionalProvider<T>(
  app: NestFastifyApplication,
  token: Type<T>,
): T | undefined {
  try {
    return app.get(token, { strict: false });
  } catch {
    return undefined;
  }
}
