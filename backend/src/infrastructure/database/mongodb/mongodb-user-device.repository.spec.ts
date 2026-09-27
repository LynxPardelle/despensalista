import { Model } from 'mongoose';
import { UserDevice } from '../../../domain/entities/user-device.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { MongoUserDeviceRepository } from './mongodb-user-device.repository';
import { UserDeviceDocument } from './schemas/user-device.schema';

describe('MongoUserDeviceRepository capacity reservation', () => {
  it('increments a capped reservation in the device transaction', async () => {
    const context = makeContext();
    context.model.findOne.mockReturnValue(queryResult(null));
    context.reservations.findOne.mockResolvedValue({
      _id: 'user-1',
      count: 24,
    });

    await context.repository.save(makeDevice());

    expect(context.session.withTransaction).toHaveBeenCalledTimes(1);
    expect(context.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1', status: 'active' }),
      { $inc: { mutationVersion: 1 } },
      { session: context.session },
    );
    expect(context.reservations.updateOne).toHaveBeenCalledWith(
      { _id: 'user-1', count: { $lt: 25 } },
      { $inc: { count: 1 } },
      { session: context.session },
    );
    expect(context.model.findOneAndUpdate).toHaveBeenCalledWith(
      { id: 'device-1', userId: 'user-1' },
      { $set: expect.objectContaining({ id: 'device-1', userId: 'user-1' }) },
      { new: true, upsert: true, session: context.session },
    );
  });

  it('returns no device once the reservation is full', async () => {
    const context = makeContext();
    context.model.findOne.mockReturnValue(queryResult(null));
    context.reservations.findOne.mockResolvedValue({
      _id: 'user-1',
      count: 25,
    });

    await expect(context.repository.save(makeDevice())).resolves.toBeNull();
    expect(context.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('initializes a missing reservation from legacy device rows', async () => {
    const context = makeContext();
    context.model.findOne.mockReturnValue(queryResult(null));
    context.reservations.findOne.mockResolvedValue(null);
    context.model.countDocuments.mockReturnValue(queryResult(24));

    await context.repository.save(makeDevice());

    expect(context.reservations.insertOne).toHaveBeenCalledWith(
      { _id: 'user-1', count: 24 },
      { session: context.session },
    );
    expect(context.reservations.updateOne).toHaveBeenCalledWith(
      { _id: 'user-1', count: { $lt: 25 } },
      { $inc: { count: 1 } },
      { session: context.session },
    );
  });

  it('updates an existing device without consuming another slot', async () => {
    const context = makeContext();
    context.model.findOne.mockReturnValue(
      queryResult(makeDevice().toPrimitives()),
    );

    await context.repository.save(makeDevice());

    expect(context.reservations.findOne).not.toHaveBeenCalled();
    expect(context.reservations.updateOne).not.toHaveBeenCalled();
  });

  it('does not reserve twice when a duplicate create transaction retries', async () => {
    const context = makeContext(true);
    const existing = makeDevice().toPrimitives();
    context.model.findOne
      .mockReturnValueOnce(queryResult(null))
      .mockReturnValueOnce(queryResult(existing));
    context.reservations.findOne.mockResolvedValue({
      _id: 'user-1',
      count: 0,
    });
    context.model.findOneAndUpdate
      .mockReturnValueOnce(queryFailure(new Error('write conflict')))
      .mockReturnValueOnce(queryResult(existing));

    await expect(context.repository.save(makeDevice())).resolves.toMatchObject({
      id: 'device-1',
    });
    expect(context.reservations.updateOne).toHaveBeenCalledTimes(1);
  });

  it('deletes reservation state in the account device cleanup transaction', async () => {
    const context = makeContext();
    context.model.deleteMany.mockReturnValue(queryResult({ deletedCount: 2 }));

    await expect(
      context.repository.deleteByUserId(UserId.fromString('user-1')),
    ).resolves.toBe(2);
    expect(context.reservations.deleteOne).toHaveBeenCalledWith(
      { _id: 'user-1' },
      { session: context.session },
    );
  });
});

function makeContext(retryOnce = false) {
  const session = {
    withTransaction: jest.fn(async (callback: () => Promise<void>) => {
      if (!retryOnce) return callback();
      try {
        await callback();
      } catch {
        await callback();
      }
    }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const reservations = {
    findOne: jest.fn(),
    insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  };
  const model = {
    db: {
      startSession: jest.fn().mockResolvedValue(session),
      collection: jest.fn((name: string) =>
        name === 'users' ? users : reservations,
      ),
    },
    findOne: jest.fn(),
    findOneAndUpdate: jest
      .fn()
      .mockReturnValue(queryResult(makeDevice().toPrimitives())),
    countDocuments: jest.fn(),
    deleteMany: jest.fn(),
  };

  return {
    model,
    repository: new MongoUserDeviceRepository(
      model as unknown as Model<UserDeviceDocument>,
    ),
    reservations,
    session,
    users,
  };
}

function queryResult<T>(value: T) {
  const query = {
    session: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

function queryFailure(error: Error) {
  const query = queryResult(undefined);
  query.exec.mockRejectedValue(error);
  return query;
}

function makeDevice(): UserDevice {
  return UserDevice.create({
    id: 'device-1',
    userId: UserId.fromString('user-1'),
    label: 'Chrome en Windows',
    userAgentSummary: 'Chrome en Windows',
    now: new Date('2026-09-01T00:00:00.000Z'),
  });
}
