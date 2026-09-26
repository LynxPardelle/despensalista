import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { BadRequestException } from '@nestjs/common';
import { ProductType } from '../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { CreateInventoryLotUseCase } from './create-inventory-lot.use-case';

describe('CreateInventoryLotUseCase', () => {
  it('rejects creating a lot for an archived product type', async () => {
    const inventoryLotRepository = makeInventoryLotRepository();
    const productTypeRepository = makeProductTypeRepository();
    productTypeRepository.findById.mockResolvedValue(
      makeProductType({ archived: true }),
    );

    await expect(
      new CreateInventoryLotUseCase(
        productTypeRepository,
        makePantryMutationMock({ lots: inventoryLotRepository }),
      ).execute({
        userId: 'owner-user',
        productTypeId: 'type-1',
        quantity: 2,
        unit: QuantityUnit.PIECE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inventoryLotRepository.save).not.toHaveBeenCalled();
  });
});

function makeInventoryLotRepository(): jest.Mocked<InventoryLotRepository> {
  return {
    save: jest.fn((lot) => Promise.resolve(lot)),
    findById: jest.fn(),
    findByUserId: jest.fn(),
    findArchivedByUserId: jest.fn(),
    findArchivedPageByUserId: jest.fn(),
    findByProductTypeId: jest.fn(),
    reassignUserOwnership: jest.fn(),
    delete: jest.fn(),
    deleteByProductTypeId: jest.fn(),
    deleteByUserId: jest.fn(),
  };
}

function makeProductTypeRepository(): jest.Mocked<ProductTypeRepository> {
  return {
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
  };
}

function makeProductType(input: { archived: boolean }): ProductType {
  return ProductType.fromPrimitives({
    id: 'type-1',
    userId: 'owner-user',
    baseName: 'Arroz',
    category: ProductCategory.FOOD,
    defaultUnit: QuantityUnit.PIECE,
    archivedAt: input.archived
      ? new Date('2026-04-20T00:00:00.000Z')
      : undefined,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
  });
}
