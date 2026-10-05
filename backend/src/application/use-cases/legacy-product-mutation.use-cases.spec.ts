import { Product } from '../../domain/entities/product.entity';
import {
  ProductCategory,
  ProductStatus,
  QuantityUnit,
} from '../../domain/enums';
import { Period } from '../../domain/enums/period.enum';
import { ProductRepository } from '../../domain/repositories/product.repository';
import { SchedulingService } from '../../domain/services/scheduling.service';
import { ProductId } from '../../domain/value-objects/product-id.vo';
import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { CreateProductUseCase } from './create-product.use-case';
import { UpdateProductQuantityUseCase } from './update-product-quantity.use-case';

describe('legacy product mutations', () => {
  const scheduling = {
    calculateNextPurchaseDate: jest
      .fn()
      .mockReturnValue(new Date('2026-10-01T00:00:00.000Z')),
    updateProductStatus: jest.fn().mockReturnValue(ProductStatus.AVAILABLE),
    getDaysUntilPurchase: jest.fn(),
  } as unknown as jest.Mocked<SchedulingService>;

  it('creates through the fenced pantry mutation port', async () => {
    const mutation = makePantryMutationMock();
    const product = await new CreateProductUseCase(
      mutation,
      scheduling,
    ).execute({
      userId: 'user-1',
      title: 'Arroz',
      currentQuantity: 2,
      unit: QuantityUnit.KILOGRAM,
      usageRate: { amount: 1, period: Period.WEEK },
      category: ProductCategory.FOOD,
    });

    expect(mutation.createProduct).toHaveBeenCalledWith(product);
  });

  it('updates using an immutable expected snapshot', async () => {
    const stored = Product.fromPrimitives({
      id: 'product-1',
      userId: 'user-1',
      title: 'Arroz',
      currentQuantity: 2,
      unit: QuantityUnit.KILOGRAM,
      usageRate: { amount: 1, period: Period.WEEK },
      category: ProductCategory.FOOD,
      status: ProductStatus.AVAILABLE,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const repository = {
      findById: jest.fn().mockResolvedValue(stored),
    } as unknown as jest.Mocked<ProductRepository>;
    const mutation = makePantryMutationMock();

    await new UpdateProductQuantityUseCase(
      repository,
      scheduling,
      mutation,
    ).execute(ProductId.fromString('product-1').toString(), 'user-1', 1);

    const [expected, updated] = mutation.updateProduct.mock.calls[0];
    expect(expected.currentQuantity).toBe(2);
    expect(updated.currentQuantity).toBe(1);
  });
});
