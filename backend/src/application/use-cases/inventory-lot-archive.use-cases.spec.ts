import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { InventoryLotId } from '../../domain/value-objects/inventory-lot-id.vo';
import { ArchiveInventoryLotUseCase } from './archive-inventory-lot.use-case';
import { DeleteInventoryLotUseCase } from './delete-inventory-lot.use-case';
import { RestoreInventoryLotUseCase } from './restore-inventory-lot.use-case';

describe('inventory lot archive use cases', () => {
  const makeRepository = (): jest.Mocked<InventoryLotRepository> => ({
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
  });

  const makeLot = (): InventoryLot =>
    InventoryLot.fromPrimitives({
      id: 'lot-1',
      userId: 'owner-user',
      productTypeId: 'type-1',
      variantName: 'Dolores QA',
      quantity: 2,
      unit: QuantityUnit.PIECE,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

  it('archives and restores lots for the owning user', async () => {
    const repository = makeRepository();
    const lot = makeLot();
    repository.findById.mockResolvedValue(lot);

    const archived = await new ArchiveInventoryLotUseCase(
      repository,
      makePantryMutationMock({ lots: repository }),
    ).execute({
      lotId: 'lot-1',
      userId: 'owner-user',
      reason: 'Regalado',
    });

    expect(archived.isArchived()).toBe(true);
    expect(archived.toPrimitives().archivedReason).toBe('Regalado');

    const restored = await makeRestoreUseCase(
      repository,
      makeProductTypeRepository(makeProductType()),
    ).execute({ lotId: 'lot-1', userId: 'owner-user' });

    expect(restored.isArchived()).toBe(false);
  });

  it('rejects restoring a lot whose product type is archived', async () => {
    const repository = makeRepository();
    const lot = makeLot();
    const productType = makeProductType();
    lot.archive();
    productType.archive();
    repository.findById.mockResolvedValue(lot);
    const productTypeRepository = makeProductTypeRepository(productType);

    await expect(
      makeRestoreUseCase(repository, productTypeRepository).execute({
        lotId: 'lot-1',
        userId: 'owner-user',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('hides lots from another user behind not found', async () => {
    const repository = makeRepository();
    repository.findById.mockResolvedValue(makeLot());

    await expect(
      new ArchiveInventoryLotUseCase(
        repository,
        makePantryMutationMock({ lots: repository }),
      ).execute({
        lotId: 'lot-1',
        userId: 'other-user',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires archive and confirmation before permanent lot delete', async () => {
    const repository = makeRepository();
    const lot = makeLot();
    repository.findById.mockResolvedValue(lot);
    const useCase = new DeleteInventoryLotUseCase(
      repository,
      makePantryMutationMock({ lots: repository }),
    );

    await expect(
      useCase.execute({
        lotId: 'lot-1',
        userId: 'owner-user',
        confirmationText: 'Dolores QA',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    lot.archive();

    await expect(
      useCase.execute({
        lotId: 'lot-1',
        userId: 'owner-user',
        confirmationText: 'Dolores QA',
      }),
    ).resolves.toBeUndefined();
    expect(repository.delete).toHaveBeenCalledWith(
      InventoryLotId.fromString('lot-1'),
    );
  });
});

function makeProductType(): ProductType {
  return ProductType.fromPrimitives({
    id: 'type-1',
    userId: 'owner-user',
    baseName: 'Arroz',
    category: ProductCategory.FOOD,
    defaultUnit: QuantityUnit.PIECE,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  });
}

function makeProductTypeRepository(
  productType: ProductType,
): jest.Mocked<ProductTypeRepository> {
  return {
    save: jest.fn((value) => Promise.resolve(value)),
    findById: jest.fn().mockResolvedValue(productType),
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

function makeRestoreUseCase(
  inventoryLotRepository: InventoryLotRepository,
  productTypeRepository: ProductTypeRepository,
): RestoreInventoryLotUseCase {
  return new RestoreInventoryLotUseCase(
    inventoryLotRepository,
    productTypeRepository,
    makePantryMutationMock({ lots: inventoryLotRepository }),
  );
}
