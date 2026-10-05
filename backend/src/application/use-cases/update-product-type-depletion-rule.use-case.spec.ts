import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { ProductType } from '../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { UpdateProductTypeDepletionRuleUseCase } from './update-product-type-depletion-rule.use-case';

describe('UpdateProductTypeDepletionRuleUseCase', () => {
  const makeRepository = (): jest.Mocked<ProductTypeRepository> => ({
    save: jest.fn((productType) => Promise.resolve(productType)),
    findById: jest.fn(),
    findByUserId: jest.fn(),
    findArchivedByUserId: jest.fn(),
    findArchivedPageByUserId: jest.fn(),
    searchByUserId: jest.fn(),
    findByBaseName: jest.fn(),
    reassignUserOwnership: jest.fn(),
    delete: jest.fn(),
    deleteByUserId: jest.fn(),
  });

  const makeProductType = (): ProductType =>
    ProductType.create(
      UserId.fromString('owner-user'),
      'Shampoo familiar',
      ProductCategory.HYGIENE,
      QuantityUnit.LITER,
    );

  it('updates the depletion rule only for the owning user', async () => {
    const repository = makeRepository();
    const productType = makeProductType();
    repository.findById.mockResolvedValue(productType);
    const useCase = new UpdateProductTypeDepletionRuleUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    const updatedProductType = await useCase.execute({
      productTypeId: productType.id.toString(),
      userId: 'owner-user',
      defaultDepletionRule: {
        enabled: true,
        consumeAmount: 0.5,
        unit: QuantityUnit.LITER,
        everyAmount: 2,
        everyPeriod: 'month',
        anchorDate: new Date('2026-01-24T00:00:00.000Z'),
      },
    });

    expect(
      updatedProductType.toPrimitives().defaultDepletionRule,
    ).toMatchObject({
      enabled: true,
      consumeAmount: 0.5,
      unit: QuantityUnit.LITER,
      everyAmount: 2,
      everyPeriod: 'month',
    });
    expect(repository.save.mock.calls[0]?.[0]).toBe(productType);
  });

  it('throws when another user tries to update the product type', async () => {
    const repository = makeRepository();
    const productType = makeProductType();
    repository.findById.mockResolvedValue(productType);
    const useCase = new UpdateProductTypeDepletionRuleUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    await expect(
      useCase.execute({
        productTypeId: productType.id.toString(),
        userId: 'other-user',
        defaultDepletionRule: {
          enabled: true,
          consumeAmount: 0.5,
          unit: QuantityUnit.LITER,
          everyAmount: 2,
          everyPeriod: 'month',
          anchorDate: new Date('2026-01-24T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow('Product type not found');
  });
});
