import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { QuantityUnit } from '../../../domain/enums';
import {
  MAX_ACTIVE_INVENTORY_LOTS_PER_USER,
  MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
  MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE,
} from '../../../application/constants/query-limits';
import { ProductTypeId } from '../../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { MongoInventoryLotRepository } from './mongodb-inventory-lot.repository';

type QueryResult<T> = {
  sort: jest.MockedFunction<() => QueryResult<T>>;
  limit: jest.MockedFunction<(limit: number) => QueryResult<T>>;
  lean: jest.MockedFunction<
    () => {
      exec: jest.MockedFunction<() => Promise<T>>;
    }
  >;
};

describe('MongoInventoryLotRepository archive-aware queries', () => {
  const userId = UserId.fromString('user-1');
  const productTypeId = ProductTypeId.fromString('type-1');

  const makeInventoryLot = (): InventoryLot =>
    InventoryLot.fromPrimitives({
      id: 'lot-1',
      userId: userId.toString(),
      productTypeId: productTypeId.toString(),
      variantName: 'Marca QA',
      quantity: 2,
      unit: QuantityUnit.PIECE,
      archivedAt: new Date('2026-04-20T00:00:00.000Z'),
      archivedReason: 'Regalado',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-20T00:00:00.000Z'),
    });

  const makeQuery = <T>(value: T): QueryResult<T> => {
    const query = {} as QueryResult<T>;
    query.sort = jest.fn(() => query);
    query.limit = jest.fn((_limit: number) => query);
    query.lean = jest.fn(() => ({
      exec: jest.fn(() => Promise.resolve(value)),
    }));

    return query;
  };

  it('persists archive state', async () => {
    const lot = makeInventoryLot();
    const primitives = lot.toPrimitives();
    const model = {
      findOneAndUpdate: jest.fn().mockReturnValue(makeQuery(primitives)),
      findOne: jest.fn(),
      find: jest.fn(),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };

    const repository = new MongoInventoryLotRepository(model as never);

    await repository.save(lot);

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { id: primitives.id },
      expect.objectContaining({
        $set: expect.objectContaining({
          archivedAt: primitives.archivedAt,
          archivedReason: primitives.archivedReason,
        }),
      }),
      expect.objectContaining({
        new: true,
        upsert: true,
      }),
    );
  });

  it('excludes archived lots from active user listings', async () => {
    const query = makeQuery([]);
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(query),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };
    const repository = new MongoInventoryLotRepository(model as never);

    await repository.findByUserId(userId);

    expect(model.find).toHaveBeenCalledWith({
      userId: userId.toString(),
      archivedAt: { $exists: false },
    });
    expect(query.limit).not.toHaveBeenCalled();
  });

  it('excludes archived lots from active product type listings', async () => {
    const query = makeQuery([]);
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(query),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };
    const repository = new MongoInventoryLotRepository(model as never);

    await repository.findByProductTypeId(productTypeId);

    expect(model.find).toHaveBeenCalledWith({
      productTypeId: productTypeId.toString(),
      archivedAt: { $exists: false },
    });
    expect(query.limit).not.toHaveBeenCalled();
  });

  it('lists active and archived lots for atomic product type cascade deletion', async () => {
    const archivedLot = makeInventoryLot().toPrimitives();
    const activeLot = { ...archivedLot, id: 'lot-2', archivedAt: undefined };
    const query = makeQuery([activeLot, archivedLot]);
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(query),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };
    const repository = new MongoInventoryLotRepository(model as never);

    const lots = await repository.findAllByProductTypeId(productTypeId);

    expect(model.find).toHaveBeenCalledWith({
      productTypeId: productTypeId.toString(),
    });
    expect(lots.map((lot) => lot.id.toString())).toEqual(['lot-2', 'lot-1']);
  });

  it('lists archived lots separately', async () => {
    const lot = makeInventoryLot().toPrimitives();
    const query = makeQuery([lot]);
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(query),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };
    jest.spyOn(query, 'limit');

    const repository = new MongoInventoryLotRepository(model as never);

    const archived = await repository.findArchivedByUserId(userId);

    expect(model.find).toHaveBeenCalledWith({
      userId: userId.toString(),
      archivedAt: { $exists: true },
    });
    expect(query.limit).toHaveBeenCalledWith(51);
    expect(archived[0].toPrimitives()).toMatchObject({
      id: 'lot-1',
      archivedReason: 'Regalado',
    });
  });

  it('returns archived lot pages with next cursors', async () => {
    const lots = [
      makeInventoryLot().toPrimitives(),
      InventoryLot.fromPrimitives({
        ...makeInventoryLot().toPrimitives(),
        id: 'lot-2',
        archivedAt: new Date('2026-04-19T00:00:00.000Z'),
      }).toPrimitives(),
    ];
    const query = makeQuery(lots);
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(query),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };
    jest.spyOn(query, 'limit');

    const repository = new MongoInventoryLotRepository(model as never);

    const page = await repository.findArchivedPageByUserId(userId, {
      limit: 1,
    });

    expect(query.limit).toHaveBeenCalledWith(2);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
  });

  it('rejects malformed archive cursors before querying MongoDB', async () => {
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
    };
    const repository = new MongoInventoryLotRepository(model as never);
    const invalidCursors = [
      Buffer.from('[]').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          archivedAt: 'not-a-date',
          id: 'lot-1',
          userId: userId.toString(),
        }),
      ).toString('base64url'),
    ];

    for (const cursor of invalidCursors) {
      await expect(
        repository.findArchivedPageByUserId(userId, { limit: 1, cursor }),
      ).rejects.toThrow('Invalid archived inventory lot cursor');
    }
    expect(model.find).not.toHaveBeenCalled();
  });
});
