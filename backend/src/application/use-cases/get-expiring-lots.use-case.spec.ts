import { ProductType } from '../../domain/entities/product-type.entity';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { GetExpiringLotsUseCase } from './get-expiring-lots.use-case';

describe('GetExpiringLotsUseCase', () => {
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

  const userId = UserId.fromString('lot-user');

  const makeProductType = (): ProductType =>
    ProductType.create(
      userId,
      'Atun',
      ProductCategory.FOOD,
      QuantityUnit.PIECE,
    );

  it('returns lots that fall inside a custom expiration window', async () => {
    const productTypeRepository = makeProductTypeRepository();
    const inventoryLotRepository = makeInventoryLotRepository();
    const productType = makeProductType();
    const productTypeId = productType.id;

    const soonLot = InventoryLot.create(
      userId,
      productTypeId,
      'Marca cercana',
      2,
      QuantityUnit.PIECE,
      addDays(10),
    );
    const laterLot = InventoryLot.create(
      userId,
      productTypeId,
      'Marca lejana',
      3,
      QuantityUnit.PIECE,
      addDays(25),
    );

    productTypeRepository.findByUserId.mockResolvedValue([productType]);
    inventoryLotRepository.findByUserId.mockResolvedValue([soonLot, laterLot]);

    const useCase = new GetExpiringLotsUseCase(
      productTypeRepository,
      inventoryLotRepository,
    );

    const groups = await useCase.execute(userId.toString(), 30);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.lotCount).toBe(2);
    expect(groups[0]?.totalExpiringQuantity).toBe(5);
    expect(groups[0]?.lots.map((lot) => lot.variantName)).toEqual([
      'Marca cercana',
      'Marca lejana',
    ]);
  });

  it('filters out lots outside a smaller expiration window', async () => {
    const productTypeRepository = makeProductTypeRepository();
    const inventoryLotRepository = makeInventoryLotRepository();
    const productType = makeProductType();
    const productTypeId = productType.id;

    const nearLot = InventoryLot.create(
      userId,
      productTypeId,
      'Marca proxima',
      2,
      QuantityUnit.PIECE,
      addDays(2),
    );
    const laterLot = InventoryLot.create(
      userId,
      productTypeId,
      'Marca estable',
      3,
      QuantityUnit.PIECE,
      addDays(12),
    );

    productTypeRepository.findByUserId.mockResolvedValue([productType]);
    inventoryLotRepository.findByUserId.mockResolvedValue([nearLot, laterLot]);

    const useCase = new GetExpiringLotsUseCase(
      productTypeRepository,
      inventoryLotRepository,
    );

    const groups = await useCase.execute(userId.toString(), 7);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.lotCount).toBe(1);
    expect(groups[0]?.totalExpiringQuantity).toBe(2);
    expect(groups[0]?.lots[0]?.variantName).toBe('Marca proxima');
  });

  it('keeps the expiring window on the Mexico City day after UTC midnight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-29T00:00:00.000Z'));

    try {
      const productTypeRepository = makeProductTypeRepository();
      const inventoryLotRepository = makeInventoryLotRepository();
      const productType = makeProductType();
      const todayLot = InventoryLot.create(
        userId,
        productType.id,
        'Caduca hoy',
        1,
        QuantityUnit.PIECE,
        new Date('2026-04-28T00:00:00.000Z'),
      );
      const tomorrowLot = InventoryLot.create(
        userId,
        productType.id,
        'Caduca mañana',
        1,
        QuantityUnit.PIECE,
        new Date('2026-04-29T00:00:00.000Z'),
      );
      const laterLot = InventoryLot.create(
        userId,
        productType.id,
        'Caduca pasado mañana',
        1,
        QuantityUnit.PIECE,
        new Date('2026-04-30T00:00:00.000Z'),
      );
      productTypeRepository.findByUserId.mockResolvedValue([productType]);
      inventoryLotRepository.findByUserId.mockResolvedValue([
        todayLot,
        tomorrowLot,
        laterLot,
      ]);

      const groups = await new GetExpiringLotsUseCase(
        productTypeRepository,
        inventoryLotRepository,
      ).execute(userId.toString(), 1);

      expect(groups[0]?.lots.map((lot) => lot.variantName)).toEqual([
        'Caduca hoy',
        'Caduca mañana',
      ]);
      expect(groups[0]?.totalExpiringQuantity).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

function addDays(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}
