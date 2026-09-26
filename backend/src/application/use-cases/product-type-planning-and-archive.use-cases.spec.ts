import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductType } from '../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { ArchiveProductTypeUseCase } from './archive-product-type.use-case';
import { DeleteProductTypeUseCase } from './delete-product-type.use-case';
import { RestoreProductTypeUseCase } from './restore-product-type.use-case';
import { UpdateProductTypePlanningSettingsUseCase } from './update-product-type-planning-settings.use-case';

describe('product type planning settings and archive use cases', () => {
  const makeProductTypeRepository = (): jest.Mocked<ProductTypeRepository> => ({
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

  const makeInventoryLotRepository =
    (): jest.Mocked<InventoryLotRepository> => ({
      save: jest.fn((lot) => Promise.resolve(lot)),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      findArchivedByUserId: jest.fn(),
      findArchivedPageByUserId: jest.fn(),
      findByProductTypeId: jest.fn().mockResolvedValue([]),
      reassignUserOwnership: jest.fn(),
      delete: jest.fn(),
      deleteByProductTypeId: jest.fn(),
      deleteByUserId: jest.fn(),
    });

  const makeProductType = (): ProductType =>
    ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'owner-user',
      baseName: 'Detergente',
      category: ProductCategory.CLEANING,
      defaultUnit: QuantityUnit.LITER,
      defaultDepletionRule: {
        enabled: true,
        consumeAmount: 1,
        unit: QuantityUnit.LITER,
        everyAmount: 1,
        everyPeriod: 'month',
        anchorDate: new Date('2026-04-01T00:00:00.000Z'),
      },
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

  it('updates planning settings for the owning user', async () => {
    const repository = makeProductTypeRepository();
    const productType = makeProductType();
    repository.findById.mockResolvedValue(productType);
    const useCase = new UpdateProductTypePlanningSettingsUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    const updated = await useCase.execute({
      productTypeId: 'type-1',
      userId: 'owner-user',
      planningSettings: {
        planningEnabled: false,
        shoppingPlanLeadDaysOverride: 10,
      },
    });

    expect(updated.toPrimitives().planningSettings).toMatchObject({
      planningEnabled: false,
      shoppingPlanLeadDaysOverride: 10,
    });
    expect(repository.save).toHaveBeenCalledWith(productType);
  });

  it('rejects planning settings updates from another user', async () => {
    const repository = makeProductTypeRepository();
    repository.findById.mockResolvedValue(makeProductType());
    const useCase = new UpdateProductTypePlanningSettingsUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    );

    await expect(
      useCase.execute({
        productTypeId: 'type-1',
        userId: 'other-user',
        planningSettings: {
          planningEnabled: false,
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('archives and restores product types for the owning user', async () => {
    const repository = makeProductTypeRepository();
    const productType = makeProductType();
    repository.findById.mockResolvedValue(productType);

    const archived = await new ArchiveProductTypeUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    ).execute({
      productTypeId: 'type-1',
      userId: 'owner-user',
      reason: 'Ya no se compra',
    });

    expect(archived.isArchived()).toBe(true);
    expect(archived.toPrimitives().archivedReason).toBe('Ya no se compra');

    const restored = await new RestoreProductTypeUseCase(
      repository,
      makePantryMutationMock({ types: repository }),
    ).execute({
      productTypeId: 'type-1',
      userId: 'owner-user',
    });

    expect(restored.isArchived()).toBe(false);
  });

  it('requires archive and confirmation before permanent product type delete', async () => {
    const productTypeRepository = makeProductTypeRepository();
    const inventoryLotRepository = makeInventoryLotRepository();
    const productType = makeProductType();
    productTypeRepository.findById.mockResolvedValue(productType);
    const useCase = new DeleteProductTypeUseCase(
      productTypeRepository,
      inventoryLotRepository,
      makePantryMutationMock({
        types: productTypeRepository,
        lots: inventoryLotRepository,
      }),
    );

    await expect(
      useCase.execute({
        productTypeId: 'type-1',
        userId: 'owner-user',
        confirmationText: 'Detergente',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    productType.archive();

    await expect(
      useCase.execute({
        productTypeId: 'type-1',
        userId: 'owner-user',
        confirmationText: 'Detergente',
      }),
    ).resolves.toBeUndefined();
    expect(inventoryLotRepository.deleteByProductTypeId).toHaveBeenCalledWith(
      ProductTypeId.fromString('type-1'),
    );
    expect(productTypeRepository.delete).toHaveBeenCalledWith(
      ProductTypeId.fromString('type-1'),
    );
  });

  it('keeps the archived product type retryable when archived-lot cleanup fails', async () => {
    const productTypeRepository = makeProductTypeRepository();
    const inventoryLotRepository = makeInventoryLotRepository();
    const productType = makeProductType();
    productType.archive();
    productTypeRepository.findById.mockResolvedValue(productType);
    inventoryLotRepository.deleteByProductTypeId
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce(undefined);
    const pantryMutation = makePantryMutationMock({
      types: productTypeRepository,
      lots: inventoryLotRepository,
    });
    const useCase = new DeleteProductTypeUseCase(
      productTypeRepository,
      inventoryLotRepository,
      pantryMutation,
    );

    await expect(
      useCase.execute({
        productTypeId: 'type-1',
        userId: 'owner-user',
        confirmationText: 'Detergente',
      }),
    ).rejects.toThrow('storage unavailable');
    expect(pantryMutation.beginProductTypeDeletion).toHaveBeenCalledTimes(1);
    expect(pantryMutation.deleteProductType).not.toHaveBeenCalled();

    await expect(
      useCase.execute({
        productTypeId: 'type-1',
        userId: 'owner-user',
        confirmationText: 'Detergente',
      }),
    ).resolves.toBeUndefined();
    expect(inventoryLotRepository.deleteByProductTypeId).toHaveBeenCalledTimes(
      2,
    );
    expect(pantryMutation.beginProductTypeDeletion).toHaveBeenCalledTimes(2);
    expect(pantryMutation.deleteProductType).toHaveBeenCalledTimes(1);
  });
});
