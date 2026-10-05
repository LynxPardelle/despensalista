import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { hashShoppingShareToken } from '../../../application/utils/shopping-share-token';
import { MongoShoppingShareRepository } from './mongodb-shopping-share.repository';
import { ShoppingShareSchema } from './schemas/shopping-share.schema';

type QueryResult<T> = {
  sort: (sort: Record<string, number>) => QueryResult<T>;
  limit: (limit: number) => QueryResult<T>;
  lean: () => {
    exec: () => Promise<T>;
  };
};

describe('MongoShoppingShareRepository', () => {
  it('physically expires temporary shares at their declared expiry', () => {
    expect(ShoppingShareSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { expiresAt: 1 },
          expect.objectContaining({
            name: 'shopping_share_ttl',
            expireAfterSeconds: 0,
          }),
        ],
      ]),
    );
  });

  it('lists active owner shares without revoked or expired records', async () => {
    const share = makeShare().toPrimitives();
    const query = makeQuery([share]);
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue(query),
      deleteMany: jest.fn(),
    };
    jest.spyOn(query, 'sort');
    jest.spyOn(query, 'limit');
    const repository = new MongoShoppingShareRepository(model as never);

    const shares = await repository.listActiveByOwnerUserId(
      'user-1',
      new Date('2026-05-19T00:00:00.000Z'),
    );

    expect(model.find).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      expiresAt: { $gt: new Date('2026-05-19T00:00:00.000Z') },
      $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }],
    });
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(query.limit).toHaveBeenCalledWith(25);
    expect(shares[0].toPrimitives().id).toBe('share-1');
  });

  it('finds shares by id for owner-side revocation', async () => {
    const share = makeShare().toPrimitives();
    const model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn().mockReturnValue(makeQuery(share)),
      find: jest.fn(),
      deleteMany: jest.fn(),
    };
    const repository = new MongoShoppingShareRepository(model as never);

    const found = await repository.findById('share-1');

    expect(model.findOne).toHaveBeenCalledWith({ id: 'share-1' });
    expect(found?.toPrimitives().id).toBe('share-1');
  });
});

function makeQuery<T>(value: T): QueryResult<T> {
  const query: QueryResult<T> = {
    sort: () => query,
    limit: () => query,
    lean: () => ({
      exec: () => Promise.resolve(value),
    }),
  };

  return query;
}

function makeShare(): ShoppingShare {
  return ShoppingShare.fromPrimitives({
    id: 'share-1',
    ownerUserId: 'user-1',
    tokenHash: hashShoppingShareToken('server-backed-token'),
    text: 'Lista de compras',
    createdAt: new Date('2026-05-19T00:00:00.000Z'),
    expiresAt: new Date('2026-05-26T00:00:00.000Z'),
    updatedAt: new Date('2026-05-19T00:00:00.000Z'),
  });
}
