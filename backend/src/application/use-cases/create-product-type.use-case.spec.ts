import { BadRequestException } from '@nestjs/common';
import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { QuantityUnit } from '../../domain/enums';
import { CreateProductTypeUseCase } from './create-product-type.use-case';

describe('CreateProductTypeUseCase', () => {
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

  it('persists a default depletion rule when creating a product type', async () => {
    const repository = makeRepository();
    repository.findByBaseName.mockResolvedValue(null);
    const useCase = new CreateProductTypeUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    const productType = await useCase.execute({
      userId: 'rule-user',
      baseName: 'Detergente liquido',
      category: 'cleaning',
      defaultUnit: 'lt',
      defaultDepletionRule: {
        enabled: true,
        consumeAmount: 1,
        unit: QuantityUnit.LITER,
        everyAmount: 1,
        everyPeriod: 'month',
        anchorDate: new Date('2026-01-24T00:00:00.000Z'),
      },
    });

    expect(productType.toPrimitives().defaultDepletionRule).toMatchObject({
      enabled: true,
      consumeAmount: 1,
      unit: QuantityUnit.LITER,
      everyAmount: 1,
      everyPeriod: 'month',
    });
  });

  it('rejects depletion rules that use a different unit than the product type', async () => {
    const repository = makeRepository();
    repository.findByBaseName.mockResolvedValue(null);
    const useCase = new CreateProductTypeUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    await expect(
      useCase.execute({
        userId: 'rule-user',
        baseName: 'Detergente liquido',
        category: 'cleaning',
        defaultUnit: 'lt',
        defaultDepletionRule: {
          enabled: true,
          consumeAmount: 1,
          unit: QuantityUnit.KILOGRAM,
          everyAmount: 1,
          everyPeriod: 'month',
          anchorDate: new Date('2026-01-24T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(
      'Depletion rule unit must match product type default unit',
    );
  });

  it('rejects an interval whose first occurrence cannot be represented', async () => {
    const repository = makeRepository();
    repository.findByBaseName.mockResolvedValue(null);
    const useCase = new CreateProductTypeUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    await expect(
      useCase.execute({
        userId: 'rule-user',
        baseName: 'Detergente liquido',
        category: 'cleaning',
        defaultUnit: 'lt',
        defaultDepletionRule: {
          enabled: true,
          consumeAmount: 1,
          unit: QuantityUnit.LITER,
          everyAmount: 1_000_000_000,
          everyPeriod: 'day',
          anchorDate: new Date('2026-04-28T00:00:00.000Z'),
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists shopping metadata when creating a LatAm product type', async () => {
    const repository = makeRepository();
    repository.findByBaseName.mockResolvedValue(null);
    const useCase = new CreateProductTypeUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    const productType = await useCase.execute({
      userId: 'rule-user',
      baseName: 'Frijol negro',
      category: 'food',
      defaultUnit: 'kg',
      shoppingMetadata: {
        storageLocation: 'Despensa',
        shoppingLocation: 'Mercado',
        preferredBrand: 'Marca local',
        substituteBrand: 'Marca propia',
        householdStaple: true,
        buyOnlyOnPromo: true,
        shoppingNotes: 'Comprar bolsa grande si esta en promo',
        estimatedUnitPrice: 36.5,
      },
    } as any);

    expect((productType.toPrimitives() as any).shoppingMetadata).toEqual({
      storageLocation: 'Despensa',
      shoppingLocation: 'Mercado',
      preferredBrand: 'Marca local',
      substituteBrand: 'Marca propia',
      householdStaple: true,
      buyOnlyOnPromo: true,
      replenishWhenLow: true,
      shoppingNotes: 'Comprar bolsa grande si esta en promo',
      estimatedUnitPrice: 36.5,
      priceHistory: [
        expect.objectContaining({
          shoppingLocation: 'Mercado',
          preferredBrand: 'Marca local',
          unit: 'kg',
          estimatedUnitPrice: 36.5,
        }),
      ],
    });
  });
});
