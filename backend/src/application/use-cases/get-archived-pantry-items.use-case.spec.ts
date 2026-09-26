import { ProductType } from '../../domain/entities/product-type.entity';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { GetArchivedPantryItemsUseCase } from './get-archived-pantry-items.use-case';

describe('GetArchivedPantryItemsUseCase', () => {
  const makeProductTypeRepository = (): jest.Mocked<ProductTypeRepository> => ({
    save: jest.fn(),
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
      save: jest.fn(),
      findById: jest.fn(),
      findByUserId: jest.fn(),
      findArchivedByUserId: jest.fn(),
      findArchivedPageByUserId: jest.fn(),
      findByProductTypeId: jest.fn(),
      findAllByProductTypeId: jest.fn(),
      reassignUserOwnership: jest.fn(),
      delete: jest.fn(),
      deleteByUserId: jest.fn(),
    });

  it('returns archived product types and lots for the current user', async () => {
    const productTypeRepository = makeProductTypeRepository();
    const inventoryLotRepository = makeInventoryLotRepository();
    const productType = ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'owner-user',
      baseName: 'Atun',
      category: ProductCategory.FOOD,
      defaultUnit: QuantityUnit.PIECE,
      archivedAt: new Date('2026-04-20T00:00:00.000Z'),
      archivedReason: 'No se compra',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-20T00:00:00.000Z'),
    });
    const lot = InventoryLot.fromPrimitives({
      id: 'lot-1',
      userId: 'owner-user',
      productTypeId: 'type-1',
      variantName: 'Dolores QA',
      quantity: 2,
      unit: QuantityUnit.PIECE,
      archivedAt: new Date('2026-04-21T00:00:00.000Z'),
      archivedReason: 'Regalado',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-21T00:00:00.000Z'),
    });
    productTypeRepository.findArchivedByUserId.mockResolvedValue([productType]);
    inventoryLotRepository.findArchivedByUserId.mockResolvedValue([lot]);

    const result = await new GetArchivedPantryItemsUseCase(
      productTypeRepository,
      inventoryLotRepository,
    ).execute('owner-user');

    expect(productTypeRepository.findArchivedByUserId).toHaveBeenCalledWith(
      UserId.fromString('owner-user'),
    );
    expect(inventoryLotRepository.findArchivedByUserId).toHaveBeenCalledWith(
      UserId.fromString('owner-user'),
    );
    expect(result.productTypes[0]).toMatchObject({
      id: 'type-1',
      archivedReason: 'No se compra',
    });
    expect(result.inventoryLots[0]).toMatchObject({
      id: 'lot-1',
      archivedReason: 'Regalado',
    });
  });

  it('returns a cursor-paginated archived page when requested', async () => {
    const productTypeRepository = makeProductTypeRepository();
    const inventoryLotRepository = makeInventoryLotRepository();
    const productType = ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'owner-user',
      baseName: 'Atun',
      category: ProductCategory.FOOD,
      defaultUnit: QuantityUnit.PIECE,
      archivedAt: new Date('2026-04-20T00:00:00.000Z'),
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-20T00:00:00.000Z'),
    });
    productTypeRepository.findArchivedPageByUserId.mockResolvedValue({
      items: [productType],
      nextCursor: 'next-types',
    });
    inventoryLotRepository.findArchivedPageByUserId.mockResolvedValue({
      items: [],
      nextCursor: undefined,
    });

    const result = await new GetArchivedPantryItemsUseCase(
      productTypeRepository,
      inventoryLotRepository,
    ).execute('owner-user', {
      limit: 10,
      productTypesCursor: 'types-cursor',
      includeInventoryLots: false,
    });

    expect(productTypeRepository.findArchivedPageByUserId).toHaveBeenCalledWith(
      UserId.fromString('owner-user'),
      {
        limit: 10,
        cursor: 'types-cursor',
      },
    );
    expect(
      inventoryLotRepository.findArchivedPageByUserId,
    ).not.toHaveBeenCalled();
    expect(result.pagination).toEqual({
      limit: 10,
      productTypesNextCursor: 'next-types',
      inventoryLotsNextCursor: undefined,
      hasMoreProductTypes: true,
      hasMoreInventoryLots: false,
    });
  });
});
