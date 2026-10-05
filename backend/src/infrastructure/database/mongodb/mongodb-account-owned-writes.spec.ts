import { Connection, createConnection, Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { UserDevice } from '../../../domain/entities/user-device.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserPreferences } from '../../../domain/value-objects/user-preferences.vo';
import { MongoUserDeviceRepository } from './mongodb-user-device.repository';
import { MongoUserPreferencesDao } from './mongodb-user-preferences.dao';
import {
  UserDeviceDocument,
  UserDeviceSchema,
} from './schemas/user-device.schema';
import { UserDocument, UserSchema } from './schemas/user.schema';

describe('Mongo account-owned writes', () => {
  let replica: MongoMemoryReplSet;
  let connection: Connection;
  let userModel: Model<UserDocument>;
  let deviceModel: Model<UserDeviceDocument>;
  let preferences: MongoUserPreferencesDao;
  let devices: MongoUserDeviceRepository;

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    connection = await createConnection(replica.getUri()).asPromise();
    userModel = connection.model(UserDocument.name, UserSchema);
    deviceModel = connection.model(UserDeviceDocument.name, UserDeviceSchema);
    preferences = new MongoUserPreferencesDao(userModel);
    devices = new MongoUserDeviceRepository(deviceModel);
  }, 60_000);

  beforeEach(async () => {
    await connection.db?.dropDatabase();
    await userModel.create({
      id: 'user-1',
      email: 'user@example.com',
      normalizedEmail: 'user@example.com',
      username: 'user',
      normalizedUsername: 'user',
      authSubjectIds: [],
      status: 'active',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await connection?.close();
    await replica?.stop();
  });

  it('rejects delayed preference and device writes after the account fence and sweep', async () => {
    const device = makeDevice();
    await devices.save(device);
    await userModel.updateOne(
      { id: 'user-1' },
      { $set: { deletionFenceExpiresAt: new Date(Date.now() + 86_400_000) } },
    );
    await deviceModel.deleteMany({ userId: 'user-1' });

    await expect(
      preferences.save(UserId.fromString('user-1'), UserPreferences.resolve()),
    ).rejects.toThrow('deletion is in progress');
    await expect(devices.save(device)).rejects.toThrow(
      'deletion is in progress',
    );
    expect(await deviceModel.countDocuments({ userId: 'user-1' })).toBe(0);
  });
});

function makeDevice(): UserDevice {
  return UserDevice.create({
    id: 'device-1',
    userId: UserId.fromString('user-1'),
    label: 'Chrome en Windows',
    userAgentSummary: 'Chrome en Windows',
    now: new Date('2026-09-01T00:00:00.000Z'),
  });
}
