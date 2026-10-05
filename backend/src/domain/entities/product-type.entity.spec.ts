import { ProductCategory, QuantityUnit } from '../enums';
import { UserId } from '../value-objects/user-id.vo';
import { ProductType } from './product-type.entity';

describe('ProductType planning settings and archive state', () => {
  it('advances optimistic version timestamps even within the same millisecond', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T00:00:00Z'));
    try {
      const type = ProductType.create(
        UserId.fromString('user-1'),
        'Arroz',
        ProductCategory.FOOD,
        QuantityUnit.PIECE,
      );
      const before = type.updatedAt.getTime();
      type.updateShoppingMetadata({ estimatedUnitPrice: 10 });
      expect(type.updatedAt.getTime()).toBeGreaterThan(before);
      const after = type.updatedAt.getTime();
      type.archive();
      expect(type.updatedAt.getTime()).toBeGreaterThan(after);
    } finally {
      jest.useRealTimers();
    }
  });
  it('defaults planning to enabled when a depletion rule is active', () => {
    const productType = ProductType.create(
      UserId.fromString('user-1'),
      'Detergente',
      ProductCategory.CLEANING,
      QuantityUnit.LITER,
      {
        enabled: true,
        consumeAmount: 1,
        unit: QuantityUnit.LITER,
        everyAmount: 1,
        everyPeriod: 'month',
        anchorDate: new Date('2026-04-01T00:00:00.000Z'),
      },
    );

    expect(productType.toPrimitives().planningSettings).toEqual({
      planningEnabled: true,
    });
  });

  it('stores validated per-type planning overrides', () => {
    const productType = ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'user-1',
      baseName: 'Shampoo',
      category: ProductCategory.CLEANING,
      defaultUnit: QuantityUnit.LITER,
      planningSettings: {
        planningEnabled: true,
      },
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    productType.updatePlanningSettings({
      planningEnabled: false,
      expirationWarningDaysOverride: 10,
      depletionWarningThresholdRatioOverride: 1.5,
      shoppingPlanLeadDaysOverride: 14,
    });

    expect(productType.toPrimitives().planningSettings).toEqual({
      planningEnabled: false,
      expirationWarningDaysOverride: 10,
      depletionWarningThresholdRatioOverride: 1.5,
      shoppingPlanLeadDaysOverride: 14,
    });
  });

  it('preserves shopping metadata for LatAm shopping workflows', () => {
    const productType = ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'user-1',
      baseName: 'Frijol negro',
      category: ProductCategory.FOOD,
      defaultUnit: QuantityUnit.KILOGRAM,
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
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
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
    });
  });

  it('records a bounded price history when shopping price references change', () => {
    const productType = ProductType.create(
      UserId.fromString('user-1'),
      'Arroz',
      ProductCategory.FOOD,
      QuantityUnit.KILOGRAM,
      undefined,
      {
        shoppingLocation: 'Mercado',
        preferredBrand: 'Marca local',
        householdStaple: true,
        buyOnlyOnPromo: false,
        estimatedUnitPrice: 31.75,
      },
    );

    productType.updateShoppingMetadata({
      shoppingLocation: 'Bodega',
      preferredBrand: 'Marca local',
      estimatedUnitPrice: 29.5,
    });

    const metadata = productType.toPrimitives().shoppingMetadata!;

    expect(metadata.priceHistory).toEqual([
      expect.objectContaining({
        shoppingLocation: 'Bodega',
        preferredBrand: 'Marca local',
        unit: QuantityUnit.KILOGRAM,
        estimatedUnitPrice: 29.5,
      }),
      expect.objectContaining({
        shoppingLocation: 'Mercado',
        preferredBrand: 'Marca local',
        unit: QuantityUnit.KILOGRAM,
        estimatedUnitPrice: 31.75,
      }),
    ]);
  });

  it('rejects invalid planning override boundaries', () => {
    const productType = ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'user-1',
      baseName: 'Shampoo',
      category: ProductCategory.CLEANING,
      defaultUnit: QuantityUnit.LITER,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    expect(() =>
      productType.updatePlanningSettings({
        expirationWarningDaysOverride: 0,
      }),
    ).toThrow('Expiration warning days override must be between 1 and 60');
    expect(() =>
      productType.updatePlanningSettings({
        depletionWarningThresholdRatioOverride: 4.5,
      }),
    ).toThrow(
      'Depletion warning threshold ratio override must be between 0.25 and 4',
    );
    expect(() =>
      productType.updatePlanningSettings({
        shoppingPlanLeadDaysOverride: 31,
      }),
    ).toThrow('Shopping plan lead days override must be between 0 and 30');
  });

  it('archives and restores product types without losing planning settings', () => {
    const productType = ProductType.fromPrimitives({
      id: 'type-1',
      userId: 'user-1',
      baseName: 'Atun',
      category: ProductCategory.FOOD,
      defaultUnit: QuantityUnit.PIECE,
      planningSettings: {
        planningEnabled: true,
        shoppingPlanLeadDaysOverride: 5,
      },
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    productType.archive('Ya no se compra');

    expect(productType.isArchived()).toBe(true);
    expect(productType.toPrimitives()).toMatchObject({
      archivedReason: 'Ya no se compra',
      planningSettings: {
        planningEnabled: true,
        shoppingPlanLeadDaysOverride: 5,
      },
    });

    productType.restore();

    expect(productType.isArchived()).toBe(false);
    expect(productType.toPrimitives().archivedAt).toBeUndefined();
    expect(productType.toPrimitives().archivedReason).toBeUndefined();
  });
});
