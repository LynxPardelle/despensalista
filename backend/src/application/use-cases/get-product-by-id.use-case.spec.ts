import { Product } from '../../domain/entities/product.entity';
import { Period } from '../../domain/enums/period.enum';
import {
  ProductCategory,
  ProductStatus,
  QuantityUnit,
} from '../../domain/enums';
import { ProductRepository } from '../../domain/repositories/product.repository';
import { ProductId } from '../../domain/value-objects/product-id.vo';
import { UsageRate } from '../../domain/value-objects/usage-rate.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { GetProductByIdUseCase } from './get-product-by-id.use-case';

describe('GetProductByIdUseCase', () => {
  const makeRepository = (): jest.Mocked<ProductRepository> => ({
    findById: jest.fn(),
    findByUserId: jest.fn(),
    findByCategory: jest.fn(),
    findByStatus: jest.fn(),
    deleteByUserId: jest.fn(),
    findAll: jest.fn(),
  });

  const makeProduct = (): Product => {
    const product = Product.create(
      UserId.fromString('user-1'),
      'Aceite de oliva',
      2,
      QuantityUnit.LITER,
      new UsageRate(1, Period.MONTH),
      ProductCategory.FOOD,
    );

    return Product.fromPrimitives({
      ...product.toPrimitives(),
      status: ProductStatus.AVAILABLE,
    });
  };

  it('returns the product when the repository finds it', async () => {
    const repository = makeRepository();
    const product = makeProduct();
    repository.findById.mockResolvedValue(product);

    const useCase = new GetProductByIdUseCase(repository);

    await expect(
      useCase.execute(product.id.toString(), 'user-1'),
    ).resolves.toBe(product);
    expect(repository.findById.mock.calls).toHaveLength(1);
    expect(repository.findById.mock.calls[0]?.[0]?.toString()).toBe(
      ProductId.fromString(product.id.toString()).toString(),
    );
  });

  it('throws when the product does not exist', async () => {
    const repository = makeRepository();
    repository.findById.mockResolvedValue(null);

    const useCase = new GetProductByIdUseCase(repository);

    await expect(useCase.execute('missing-product', 'user-1')).rejects.toThrow(
      'Product not found',
    );
  });
});
