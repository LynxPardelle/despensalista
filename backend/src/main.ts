import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { rawBody: Boolean(process.env.STRIPE_BILLING_CONFIG_PARAMETER) },
  );
  const configService = app.get(ConfigService);
  await configureApp(app, configService);

  const port = Number(configService.get<number | string>('PORT') ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
