import { Test } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AccessTokenGuard } from '../src/infrastructure/http/auth/access-token.guard';
import { configureApp } from '../src/app.setup';
import { User } from '../src/domain/entities/user.entity';
import { UserDao } from '../src/application/ports/daos';
import { USER_DAO } from '../src/application/tokens';

describe('Pantry production contracts (HTTP + Mongo transactions)', () => {
  let replSet: MongoMemoryReplSet;
  let app: NestFastifyApplication;
  let connection: Connection;
  const user = User.create('pantry-e2e@example.test', 'Pantry e2e');

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PERSISTENCE_PROVIDER: 'mongodb',
      DATABASE_URL: replSet.getUri(),
      DATABASE_NAME: 'pantry_e2e',
      COGNITO_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'false',
      HELMET_ENABLED: 'false',
    });
    delete process.env.MONGO_HOST;
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest().authUser = {
            userId: user.id.toString(),
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await configureApp(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    connection = app.get<Connection>(getConnectionToken());
    await app.get<UserDao>(USER_DAO).save(user);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  const post = (path: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('Cookie', 'XSRF-TOKEN=pantry-test')
      .set('X-XSRF-TOKEN', 'pantry-test');

  it('creates, pages, buys, replays, consumes as waste, archives/restores and deletes data', async () => {
    const type = (
      await post('/api/product-types')
        .send({
          baseName: 'Arroz e2e',
          category: 'food',
          defaultUnit: 'piezas',
        })
        .expect(201)
    ).body as { id: string };
    const checkout = {
      items: [
        {
          productTypeId: type.id,
          quantity: 3,
          unit: 'piezas',
          paidUnitPrice: 15,
        },
      ],
    };
    await post('/api/pantry/checkout').send(checkout).expect(400);
    const key = randomUUID();
    const first = await post('/api/pantry/checkout')
      .set('Idempotency-Key', key)
      .send(checkout)
      .expect(201);
    const again = await post('/api/pantry/checkout')
      .set('Idempotency-Key', key)
      .send(checkout)
      .expect(201)
      .expect('Idempotency-Replayed', 'true');
    expect(again.body).toEqual(first.body);
    await post('/api/pantry/checkout')
      .set('Idempotency-Key', key)
      .send({ items: [{ ...checkout.items[0], quantity: 4 }] })
      .expect(409);
    const lot = first.body[0] as { id: string };
    const consumeKey = randomUUID();
    const waste = { quantity: 1, wasteReason: 'expired' };
    const consumed = await post(`/api/inventory-lots/${lot.id}/consume`)
      .set('Idempotency-Key', consumeKey)
      .send(waste)
      .expect(201);
    const replay = await post(`/api/inventory-lots/${lot.id}/consume`)
      .set('Idempotency-Key', consumeKey)
      .send(waste)
      .expect(201)
      .expect('Idempotency-Replayed', 'true');
    expect(replay.body).toEqual(consumed.body);
    expect(consumed.body.quantity).toBe(2);
    expect(await connection.collection('waste_events').countDocuments()).toBe(
      1,
    );
    await post(`/api/inventory-lots/${lot.id}/archive`)
      .send({ reason: 'qa' })
      .expect(201);
    await post(`/api/inventory-lots/${lot.id}/restore`).send({}).expect(201);
    await post('/api/product-types')
      .send({ baseName: 'Frijol e2e', category: 'food', defaultUnit: 'piezas' })
      .expect(201);
    const page = await request(app.getHttpServer())
      .get('/api/product-types/page?limit=1')
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.pagination.hasMore).toBe(true);
    const next = await request(app.getHttpServer())
      .get('/api/product-types/page')
      .query({ limit: 1, cursor: page.body.pagination.nextCursor })
      .expect(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toEqual(page.body.items[0].id);
    await request(app.getHttpServer())
      .get('/api/inventory-lots/page?limit=101')
      .expect(400);
    const lots = await request(app.getHttpServer())
      .get('/api/inventory-lots/page')
      .expect(200);
    expect(lots.body.items).toHaveLength(1);
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(2);
    // Data deletion is tested through the actual use case to avoid unrelated step-up auth.
    const { DeletePantryDataUseCase } =
      await import('../src/application/use-cases/delete-pantry-data.use-case');
    await app
      .get(DeletePantryDataUseCase)
      .execute({ userId: user.id.toString(), confirmationText: 'ELIMINAR' });
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(0);
    expect(await connection.collection('pantry_quotas').countDocuments()).toBe(
      0,
    );
    expect(await connection.collection('inventory_lots').countDocuments()).toBe(
      0,
    );
  }, 30_000);
});
