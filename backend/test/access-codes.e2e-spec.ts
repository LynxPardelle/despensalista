import { Test } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AccessTokenGuard } from '../src/infrastructure/http/auth/access-token.guard';
import { configureApp } from '../src/app.setup';
import { User } from '../src/domain/entities/user.entity';
import { UserDao } from '../src/application/ports/daos';
import { USER_DAO } from '../src/application/tokens';
import { AccessCodeStore } from '../src/infrastructure/access/access-code.store';

describe('Access codes through authenticated HTTP and Mongo transactions', () => {
  let replSet: MongoMemoryReplSet;
  let app: NestFastifyApplication;
  let codes: AccessCodeStore;
  const first = User.create('gift-owner-one@example.test', 'First owner');
  const second = User.create('gift-owner-two@example.test', 'Second owner');
  let currentUser = first;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    Object.assign(process.env, {
      NODE_ENV: 'test',
      PERSISTENCE_PROVIDER: 'mongodb',
      DATABASE_URL: replSet.getUri(),
      DATABASE_NAME: 'access_codes_e2e',
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
            userId: currentUser.id.toString(),
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
    const users = app.get<UserDao>(USER_DAO);
    first.linkAuthSubject(first.id.toString());
    second.linkAuthSubject(second.id.toString());
    await users.save(first);
    await users.save(second);
    codes = app.get(AccessCodeStore);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  it('redeems only once, exposes paid benefits without Stripe, revokes without deleting lists and rejects another owner', async () => {
    const home = (
      await request(app.getHttpServer()).get('/api/household').expect(200)
    ).body;
    const id = randomUUID();
    const code = `DL1.${id}.${randomBytes(32).toString('base64url')}`;
    await codes.issue({
      id,
      plan: 'plus',
      mode: 'plan',
      months: 1,
      lifetime: false,
      createdAt: new Date().toISOString(),
      redeemUntil: new Date(Date.now() + 86400000).toISOString(),
      reason: 'Integration test',
      state: 'issued',
      secretHash: createHash('sha256').update(code).digest('hex'),
    });
    const post = (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Cookie', 'XSRF-TOKEN=gift-test')
        .set('X-XSRF-TOKEN', 'gift-test');
    const body = { code, householdId: home.household.id };
    const redeemed = await post('/api/household/access/redeem')
      .send(body)
      .expect(200);
    expect(redeemed.headers['cache-control']).toBe('no-store');
    expect(redeemed.body.replayed).toBe(false);
    expect(JSON.stringify(redeemed.body)).not.toContain(code);
    expect(
      (await post('/api/household/access/redeem').send(body).expect(200)).body
        .replayed,
    ).toBe(true);
    expect(
      (await request(app.getHttpServer()).get('/api/household').expect(200))
        .body.plan,
    ).toMatchObject({
      tier: 'plus',
      savedListLimit: 15,
      source: 'code',
    });
    await post('/api/pantry/shopping-lists')
      .send({
        title: 'Gift data is retained',
        items: [
          {
            productTypeId: randomUUID(),
            baseName: 'Arroz',
            quantity: 1,
            unit: 'piezas',
          },
        ],
      })
      .expect(201);
    currentUser = second;
    const otherHome = (
      await request(app.getHttpServer()).get('/api/household').expect(200)
    ).body;
    const used = await post('/api/household/access/redeem')
      .send({ code, householdId: otherHome.household.id })
      .expect(400);
    expect(used.body.code).toBe('ACCESS_CODE_USED');
    expect(await codes.revoke(id, 'QA grant revocation')).toBe(true);
    currentUser = first;
    expect(
      (await request(app.getHttpServer()).get('/api/household').expect(200))
        .body.plan.tier,
    ).toBe('free');
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/pantry/shopping-lists')
          .expect((response) => {
            if (response.status !== 200)
              throw new Error(JSON.stringify(response.body));
          })
          .expect(200)
      ).body,
    ).toHaveLength(1);
    const revoked = await post('/api/household/access/redeem')
      .send(body)
      .expect(400);
    expect(revoked.body.code).toBe('ACCESS_CODE_REVOKED');
  });
});
