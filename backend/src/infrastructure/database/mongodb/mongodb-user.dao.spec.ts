import { UnauthorizedException } from '@nestjs/common';
import { Connection, createConnection, Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { CognitoProfileSyncService } from '../../../application/services/cognito-profile-sync.service';
import { User } from '../../../domain/entities/user.entity';
import { UserAccountStatus } from '../../../domain/enums';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { MongoUserDao } from './mongodb-user.dao';
import { UserDocument, UserSchema } from './schemas/user.schema';

describe('Mongo user deletion and delayed Cognito callbacks', () => {
  let replica: MongoMemoryReplSet;
  let connection: Connection;
  let model: Model<UserDocument>;
  let dao: MongoUserDao;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ launchTimeout: 30_000 }],
    });
    connection = await createConnection(replica.getUri()).asPromise();
    model = connection.model(UserDocument.name, UserSchema);
    await model.init();
    dao = new MongoUserDao(model);
    await dao.onModuleInit();
  }, 60_000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await model?.deleteMany({});
    await connection?.collection('account_revocations').deleteMany({});
    await connection?.collection('pantry_quotas').deleteMany({});
  });
  afterAll(async () => {
    await connection?.close();
    await replica?.stop();
  });

  it('a callback already past profile lookup cannot recreate a deleted linked account', async () => {
    const original = User.fromPrimitives({
      id: 'legacy-local-user',
      email: 'owner@example.com',
      username: 'Owner',
      authSubjectIds: ['cognito-sub', 'linked-sub'],
      status: UserAccountStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await dao.save(original);
    const sync = new CognitoProfileSyncService(dao);
    const save: (candidate: User) => Promise<User> = dao.save.bind(dao);
    let reachedSave!: () => void;
    let resumeSave!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedSave = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeSave = resolve;
    });
    jest.spyOn(dao, 'save').mockImplementationOnce(async (candidate) => {
      reachedSave();
      await resume;
      return save(candidate);
    });
    const callback = sync.syncFromClaims({
      sub: 'cognito-sub',
      email: 'owner@example.com',
      emailVerified: true,
    });
    const outcome = callback.then(
      () => null,
      (error: unknown) => error,
    );
    await reached;
    await dao.delete(original.id);
    resumeSave();
    expect(await outcome).toBeInstanceOf(UnauthorizedException);
    expect(await dao.findById(original.id)).toBeNull();
    expect(await model.countDocuments()).toBe(0);
    await expect(
      sync.syncFromClaims({
        sub: 'linked-sub',
        email: 'owner@example.com',
        emailVerified: true,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await dao.findById(UserId.fromString('linked-sub'))).toBeNull();
  });
});
