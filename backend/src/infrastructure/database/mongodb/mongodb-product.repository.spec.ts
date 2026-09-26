import { Product } from '../../../../src/domain/entities/product.entity';
import { Period } from '../../../../src/domain/enums/period.enum';
import { ProductCategory, QuantityUnit } from '../../../../src/domain/enums';
import { ProductId } from '../../../../src/domain/value-objects/product-id.vo';
import { UsageRate } from '../../../../src/domain/value-objects/usage-rate.vo';
import { UserId } from '../../../../src/domain/value-objects/user-id.vo';
import { MongoProductRepository } from './mongodb-product.repository';

type QueryResult<T> = {
  lean: () => {
    exec: () => Promise<T>;
  };
};

describe('MongoProductRepository', () => {
  const makeProduct = (): Product =>
    Product.create(
      UserId.fromString('user-1'),
      'Aceite de oliva',
      2,
      QuantityUnit.LITER,
      new UsageRate(1, Period.MONTH),
      ProductCategory.FOOD,
    );

  const makeQuery = <T>(value: T): QueryResult<T> => ({
    lean: () => ({
      exec: () => Promise.resolve(value),
    }),
  });

  it('returns a product by id when it exists', async () => {
    const product = makeProduct();
    const primitives = product.toPrimitives();
    const query = makeQuery(primitives);
    const model = {
      findOne: jest.fn().mockReturnValue(query),
      find: jest.fn(),
      deleteOne: jest.fn(),
    };

    const repository = new MongoProductRepository(model as never);

    const found = await repository.findById(
      ProductId.fromString(primitives.id),
    );

    expect(model.findOne).toHaveBeenCalledWith({ id: primitives.id });
    expect(found?.toPrimitives()).toMatchObject(primitives);
  });

  it('returns null when a product does not exist', async () => {
    const query = makeQuery(null);
    const model = {
      findOne: jest.fn().mockReturnValue(query),
      find: jest.fn(),
      deleteOne: jest.fn(),
    };

    const repository = new MongoProductRepository(model as never);

    await expect(
      repository.findById(ProductId.fromString('missing-product')),
    ).resolves.toBeNull();
  });

  it('deletes every legacy product owned by a user', async () => {
    const exec = jest.fn().mockResolvedValue({ deletedCount: 3 });
    const model = {
      findOne: jest.fn(),
      find: jest.fn(),
      deleteOne: jest.fn(),
      deleteMany: jest.fn().mockReturnValue({ exec }),
    };
    const repository = new MongoProductRepository(model as never);

    await expect(
      repository.deleteByUserId(UserId.fromString('user-1')),
    ).resolves.toBe(3);
    expect(model.deleteMany).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
