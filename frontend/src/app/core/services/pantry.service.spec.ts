import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PantryService } from './pantry.service';
import { environment } from '../../../environments/environment';

describe('PantryService', () => {
  let service: PantryService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
    });

    service = TestBed.inject(PantryService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('sends and exposes idempotency metadata when consuming inventory', () => {
    const idempotencyKey = '9b29fb9a-ce30-473f-abaf-f8d987634f55';
    let result: any;

    (service.consumeInventoryLot as any)(
      'lot-1',
      { quantity: 1, wasteReason: 'expired' },
      idempotencyKey,
    ).subscribe((response: unknown) => {
      result = response;
    });

    const request = httpMock.expectOne(
      `${environment.apiUrl}/inventory-lots/lot-1/consume`,
    );
    expect(request.request.headers.get('Idempotency-Key')).toBe(idempotencyKey);
    request.flush(makeApiInventoryLot(), {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Idempotency-Replayed': 'true',
      },
    });

    expect(result.value.id).toBe('lot-1');
    expect(result.idempotencyKey).toBe(idempotencyKey);
    expect(result.replayed).toBeTrue();
  });

  it('sends and exposes idempotency metadata when closing a purchase', () => {
    const idempotencyKey = 'fb5b1163-9dc5-4db4-b181-9f036f31bd08';
    let result: any;

    (service.closeShoppingPurchase as any)(
      {
        items: [
          {
            productTypeId: 'type-1',
            quantity: 1,
            unit: 'piezas',
          },
        ],
      },
      idempotencyKey,
    ).subscribe((response: unknown) => {
      result = response;
    });

    const request = httpMock.expectOne(`${environment.apiUrl}/pantry/checkout`);
    expect(request.request.headers.get('Idempotency-Key')).toBe(idempotencyKey);
    request.flush([makeApiInventoryLot()], {
      headers: { 'Idempotency-Key': idempotencyKey },
    });

    expect(result.value).toHaveSize(1);
    expect(result.idempotencyKey).toBe(idempotencyKey);
    expect(result.replayed).toBeFalse();
  });

  it('keeps product type search array-compatible while using cursor pagination', () => {
    service.searchProductTypes('arroz').subscribe((productTypes) => {
      expect(productTypes.map((productType) => productType.id)).toEqual(['type-1']);
    });

    const request = httpMock.expectOne((candidate) => {
      return (
        candidate.url === `${environment.apiUrl}/product-types/page` &&
        candidate.params.get('search') === 'arroz' &&
        candidate.params.get('limit') === '50'
      );
    });
    request.flush({
      items: [makeApiProductType()],
      pagination: {},
    });
  });

  it('follows all product search cursors instead of hiding later matches', () => {
    let result: string[] = [];
    service.searchProductTypes('arroz').subscribe(items => result = items.map(item => item.id));
    httpMock.expectOne(request => request.url.endsWith('/product-types/page') && !request.params.has('cursor'))
      .flush({ items: [makeApiProductType()], pagination: { nextCursor: 'next-page', hasMore: true } });
    httpMock.expectOne(request => request.params.get('cursor') === 'next-page')
      .flush({ items: [{ ...makeApiProductType(), id: 'type-2' }], pagination: { hasMore: false } });
    expect(result).toEqual(['type-1', 'type-2']);
  });

  it('normalizes shopping plan dates from pantry overview responses', () => {
    service.getPantryOverview().subscribe((overview) => {
      expect(overview.shoppingPlanItems).toHaveSize(1);
      expect((overview as any).shoppingPlanEstimatedTotal).toBe(42.5);
      expect((overview.items[0] as any).shoppingMetadata).toEqual({
        storageLocation: 'Limpieza',
        shoppingLocation: 'Mayoreo',
        preferredBrand: 'Marca hogar',
        substituteBrand: 'Marca propia',
        householdStaple: true,
        buyOnlyOnPromo: true,
        replenishWhenLow: true,
        shoppingNotes: 'Comprar solo si hay promo',
        estimatedUnitPrice: 42.5,
      });
      expect(overview.stapleItems[0]).toEqual(
        jasmine.objectContaining({
          productTypeId: 'type-detergent',
          status: 'missing',
          estimatedRestockTotal: 42.5,
        }),
      );
      expect(overview.valueInsights).toEqual({
        stapleCount: 1,
        stapleAttentionCount: 1,
        estimatedShoppingTotal: 42.5,
        estimatedExpiringValue: 0,
        estimatedWasteAtRisk: 0,
        estimatedStapleRestockTotal: 42.5,
        pricedShoppingItemCount: 1,
        unpricedShoppingItemCount: 0,
        promoOnlyShoppingItemCount: 1,
        estimatedPromoOnlyTotal: 42.5,
      });
      expect((overview as any).shoppingRouteGroups[0]).toEqual(
        jasmine.objectContaining({
          shoppingLocation: 'Mayoreo',
          itemCount: 1,
          estimatedTotal: 42.5,
          missingPriceCount: 0,
          nextRecommendedPurchaseAt: new Date('2026-04-28T00:00:00.000Z'),
        }),
      );
      expect(
        (overview as any).shoppingRouteGroups[0].categoryBreakdown[0],
      ).toEqual(
        jasmine.objectContaining({
          category: 'cleaning',
          itemCount: 1,
          estimatedTotal: 42.5,
        }),
      );
      expect(
        (overview as any).shoppingRouteGroups[0].categoryBreakdown[0].items[0]
          .recommendedPurchaseAt,
      ).toEqual(new Date('2026-04-28T00:00:00.000Z'));
      expect((overview as any).stapleCatalogGroups[0]).toEqual(
        jasmine.objectContaining({
          status: 'missing',
          itemCount: 1,
          estimatedRestockTotal: 42.5,
        }),
      );
      expect((overview as any).priceReferenceItems[0]).toEqual(
        jasmine.objectContaining({
          productTypeId: 'type-detergent',
          baseName: 'Detergente',
          shoppingLocation: 'Mayoreo',
          estimatedUnitPrice: 42.5,
          priceHistory: [
            jasmine.objectContaining({
              shoppingLocation: 'Mayoreo',
              estimatedUnitPrice: 42.5,
              recordedAt: new Date('2026-04-24T00:00:00.000Z'),
            }),
          ],
          updatedAt: new Date('2026-04-24T00:00:00.000Z'),
        }),
      );
      expect((overview.shoppingPlanItems[0] as any).estimatedLineTotal).toBe(
        42.5,
      );
      expect(overview.shoppingPlanItems[0].recommendedPurchaseAt).toEqual(
        new Date('2026-04-28T00:00:00.000Z'),
      );
      expect(overview.shoppingPlanItems[0].estimatedDepletionAt).toEqual(
        new Date('2026-05-01T00:00:00.000Z'),
      );
    });

    const request = httpMock.expectOne(`${environment.apiUrl}/pantry/overview`);
    expect(request.request.withCredentials).toBeTrue();
    request.flush({
      userId: 'tester',
      generatedAt: '2026-04-24T12:00:00.000Z',
      preferences: {
        expirationWarningDays: 7,
        showExpiredEntryAlert: true,
        depletionWarningThresholdRatio: 1,
        shoppingPlanLeadDays: 3,
        showGuidanceTips: true,
      },
      items: [
        {
          productTypeId: 'type-detergent',
          baseName: 'Detergente',
          category: 'cleaning',
          defaultUnit: 'lt',
          totalQuantity: 1,
          lotCount: 1,
          nextExpirationAt: null,
          expiringSoonQuantity: 0,
          hasDepletionRule: true,
          depletionRule: {
            enabled: true,
            consumeAmount: 1,
            unit: 'lt',
            everyAmount: 1,
            everyPeriod: 'month',
            anchorDate: '2026-03-24T00:00:00.000Z',
          },
          effectivePlanningSettings: makeEffectivePlanningSettings(),
          shoppingMetadata: {
            storageLocation: 'Limpieza',
            shoppingLocation: 'Mayoreo',
            preferredBrand: 'Marca hogar',
            substituteBrand: 'Marca propia',
            householdStaple: true,
            buyOnlyOnPromo: true,
            shoppingNotes: 'Comprar solo si hay promo',
            estimatedUnitPrice: 42.5,
          },
          estimatedCurrentQuantity: 0,
          estimatedConsumedQuantity: 1,
          estimatedDepletionAt: '2026-04-24T00:00:00.000Z',
          variants: ['Marca hogar'],
          lots: [
            {
              lotId: 'lot-1',
              variantName: 'Marca hogar',
              quantity: 1,
              unit: 'lt',
              expiresAt: null,
              purchaseDate: '2026-03-24T00:00:00.000Z',
              expirationStatus: 'none',
              updatedAt: '2026-04-24T00:00:00.000Z',
            },
          ],
        },
      ],
      expiringItems: [],
      depletingItems: [],
      shoppingPlanItems: [
        {
          productTypeId: 'type-detergent',
          baseName: 'Detergente',
          category: 'cleaning',
          defaultUnit: 'lt',
          totalQuantity: 2,
          estimatedCurrentQuantity: 1,
          estimatedConsumedQuantity: 1,
          estimatedDepletionAt: '2026-05-01T00:00:00.000Z',
          recommendedPurchaseAt: '2026-04-28T00:00:00.000Z',
          suggestedPurchaseQuantity: 1,
          estimatedUnitPrice: 42.5,
          estimatedLineTotal: 42.5,
          shoppingMetadata: {
            storageLocation: 'Limpieza',
            shoppingLocation: 'Mayoreo',
            preferredBrand: 'Marca hogar',
            substituteBrand: 'Marca propia',
            householdStaple: true,
            buyOnlyOnPromo: true,
            shoppingNotes: 'Comprar solo si hay promo',
            estimatedUnitPrice: 42.5,
          },
          urgency: 'upcoming',
          effectivePlanningSettings: makeEffectivePlanningSettings(),
          depletionRule: {
            enabled: true,
            consumeAmount: 1,
            unit: 'lt',
            everyAmount: 1,
            everyPeriod: 'week',
            anchorDate: '2026-04-17T00:00:00.000Z',
          },
        },
      ],
      shoppingPlanEstimatedTotal: 42.5,
      shoppingRouteGroups: [
        {
          shoppingLocation: 'Mayoreo',
          itemCount: 1,
          urgentItemCount: 0,
          promoOnlyCount: 1,
          missingPriceCount: 0,
          estimatedTotal: 42.5,
          nextRecommendedPurchaseAt: '2026-04-28T00:00:00.000Z',
          categoryBreakdown: [
            {
              category: 'cleaning',
              itemCount: 1,
              estimatedTotal: 42.5,
              items: [
                {
                  productTypeId: 'type-detergent',
                  baseName: 'Detergente',
                  category: 'cleaning',
                  defaultUnit: 'lt',
                  totalQuantity: 2,
                  estimatedCurrentQuantity: 1,
                  estimatedConsumedQuantity: 1,
                  estimatedDepletionAt: '2026-05-01T00:00:00.000Z',
                  recommendedPurchaseAt: '2026-04-28T00:00:00.000Z',
                  suggestedPurchaseQuantity: 1,
                  estimatedUnitPrice: 42.5,
                  estimatedLineTotal: 42.5,
                  shoppingMetadata: {
                    storageLocation: 'Limpieza',
                    shoppingLocation: 'Mayoreo',
                    preferredBrand: 'Marca hogar',
                    substituteBrand: 'Marca propia',
                    householdStaple: true,
                    buyOnlyOnPromo: true,
                    shoppingNotes: 'Comprar solo si hay promo',
                    estimatedUnitPrice: 42.5,
                  },
                  urgency: 'upcoming',
                  effectivePlanningSettings: makeEffectivePlanningSettings(),
                  depletionRule: {
                    enabled: true,
                    consumeAmount: 1,
                    unit: 'lt',
                    everyAmount: 1,
                    everyPeriod: 'week',
                    anchorDate: '2026-04-17T00:00:00.000Z',
                  },
                },
              ],
            },
          ],
          items: [
            {
              productTypeId: 'type-detergent',
              baseName: 'Detergente',
              category: 'cleaning',
              defaultUnit: 'lt',
              totalQuantity: 2,
              estimatedCurrentQuantity: 1,
              estimatedConsumedQuantity: 1,
              estimatedDepletionAt: '2026-05-01T00:00:00.000Z',
              recommendedPurchaseAt: '2026-04-28T00:00:00.000Z',
              suggestedPurchaseQuantity: 1,
              estimatedUnitPrice: 42.5,
              estimatedLineTotal: 42.5,
              shoppingMetadata: {
                storageLocation: 'Limpieza',
                shoppingLocation: 'Mayoreo',
                preferredBrand: 'Marca hogar',
                substituteBrand: 'Marca propia',
                householdStaple: true,
                buyOnlyOnPromo: true,
                shoppingNotes: 'Comprar solo si hay promo',
                estimatedUnitPrice: 42.5,
              },
              urgency: 'upcoming',
              effectivePlanningSettings: makeEffectivePlanningSettings(),
              depletionRule: {
                enabled: true,
                consumeAmount: 1,
                unit: 'lt',
                everyAmount: 1,
                everyPeriod: 'week',
                anchorDate: '2026-04-17T00:00:00.000Z',
              },
            },
          ],
        },
      ],
      priceReferenceItems: [
        {
          productTypeId: 'type-detergent',
          baseName: 'Detergente',
          category: 'cleaning',
          defaultUnit: 'lt',
          shoppingLocation: 'Mayoreo',
          preferredBrand: 'Marca hogar',
          substituteBrand: 'Marca propia',
          estimatedUnitPrice: 42.5,
          priceHistory: [
            {
              shoppingLocation: 'Mayoreo',
              preferredBrand: 'Marca hogar',
              unit: 'lt',
              estimatedUnitPrice: 42.5,
              recordedAt: '2026-04-24T00:00:00.000Z',
            },
          ],
          buyOnlyOnPromo: true,
          updatedAt: '2026-04-24T00:00:00.000Z',
        },
      ],
      stapleItems: [
        {
          productTypeId: 'type-detergent',
          baseName: 'Detergente',
          category: 'cleaning',
          defaultUnit: 'lt',
          totalQuantity: 1,
          estimatedCurrentQuantity: 0,
          suggestedPurchaseQuantity: 1,
          estimatedUnitPrice: 42.5,
          estimatedRestockTotal: 42.5,
          status: 'missing',
          shoppingMetadata: {
            householdStaple: true,
            buyOnlyOnPromo: true,
            estimatedUnitPrice: 42.5,
          },
        },
      ],
      stapleCatalogGroups: [
        {
          status: 'missing',
          itemCount: 1,
          estimatedRestockTotal: 42.5,
          items: [
            {
              productTypeId: 'type-detergent',
              baseName: 'Detergente',
              category: 'cleaning',
              defaultUnit: 'lt',
              totalQuantity: 1,
              estimatedCurrentQuantity: 0,
              suggestedPurchaseQuantity: 1,
              estimatedUnitPrice: 42.5,
              estimatedRestockTotal: 42.5,
              status: 'missing',
              shoppingMetadata: {
                householdStaple: true,
                buyOnlyOnPromo: true,
                estimatedUnitPrice: 42.5,
              },
            },
          ],
        },
      ],
      valueInsights: {
        stapleCount: 1,
        stapleAttentionCount: 1,
        estimatedShoppingTotal: 42.5,
        estimatedExpiringValue: 0,
        estimatedWasteAtRisk: 0,
        estimatedStapleRestockTotal: 42.5,
        pricedShoppingItemCount: 1,
        unpricedShoppingItemCount: 0,
        promoOnlyShoppingItemCount: 1,
        estimatedPromoOnlyTotal: 42.5,
      },
    });
  });

  it('sends shopping metadata when registering a new product type', () => {
    service
      .registerLot({
        selectionMode: 'new',
        newProductType: {
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
        },
        quantity: 2,
        unit: 'kg',
      } as any)
      .subscribe();

    const productTypeRequest = httpMock.expectOne(
      `${environment.apiUrl}/product-types`,
    );
    expect(productTypeRequest.request.withCredentials).toBeTrue();
    expect(productTypeRequest.request.body.shoppingMetadata).toEqual({
      storageLocation: 'Despensa',
      shoppingLocation: 'Mercado',
      preferredBrand: 'Marca local',
      substituteBrand: 'Marca propia',
      householdStaple: true,
      buyOnlyOnPromo: true,
      shoppingNotes: 'Comprar bolsa grande si esta en promo',
      estimatedUnitPrice: 36.5,
    });
    productTypeRequest.flush({
      ...makeApiProductType(),
      id: 'type-frijol',
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
    });

    const inventoryLotRequest = httpMock.expectOne(
      `${environment.apiUrl}/inventory-lots`,
    );
    expect(inventoryLotRequest.request.withCredentials).toBeTrue();
    inventoryLotRequest.flush({
      id: 'lot-1',
      userId: 'tester',
      productTypeId: 'type-frijol',
      quantity: 2,
      unit: 'kg',
      expiresAt: null,
      purchaseDate: null,
      archivedAt: null,
      expirationStatus: 'none',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('normalizes product type planning and archive responses', () => {
    service.searchProductTypes('detergente').subscribe((productTypes) => {
      expect(productTypes[0].planningSettings).toEqual({
        planningEnabled: true,
        shoppingPlanLeadDaysOverride: 6,
      });
      expect(productTypes[0].archivedAt).toEqual(
        new Date('2026-04-24T00:00:00.000Z'),
      );
    });

    const request = httpMock.expectOne(
      `${environment.apiUrl}/product-types/page?search=detergente&limit=50`,
    );
    expect(request.request.withCredentials).toBeTrue();
    request.flush({
      items: [{
        id: 'type-detergent',
        userId: 'tester',
        baseName: 'Detergente',
        category: 'cleaning',
        defaultUnit: 'lt',
        planningSettings: {
          planningEnabled: true,
          shoppingPlanLeadDaysOverride: 6,
        },
        archivedAt: '2026-04-24T00:00:00.000Z',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      }],
      pagination: {},
    });
  });

  it('calls archive, restore, delete, and archived item endpoints', () => {
    service
      .archiveProductType('type-1', { reason: 'No comprar mas' })
      .subscribe();
    const archiveProductTypeRequest = httpMock.expectOne(
      `${environment.apiUrl}/product-types/type-1/archive`,
    );
    expect(archiveProductTypeRequest.request.withCredentials).toBeTrue();
    archiveProductTypeRequest.flush(makeApiProductType());

    service.restoreProductType('type-1').subscribe();
    const restoreProductTypeRequest = httpMock.expectOne(
      `${environment.apiUrl}/product-types/type-1/restore`,
    );
    expect(restoreProductTypeRequest.request.withCredentials).toBeTrue();
    restoreProductTypeRequest.flush(makeApiProductType());

    service
      .deleteInventoryLot('lot-1', { confirmationText: 'Lote lot-1' })
      .subscribe();
    const deleteRequest = httpMock.expectOne(
      `${environment.apiUrl}/inventory-lots/lot-1`,
    );
    expect(deleteRequest.request.method).toBe('DELETE');
    expect(deleteRequest.request.withCredentials).toBeTrue();
    expect(deleteRequest.request.body).toEqual({
      confirmationText: 'Lote lot-1',
    });
    deleteRequest.flush(null);

    service.getArchivedPantryItems().subscribe((archivedItems) => {
      expect(archivedItems.productTypes[0].id).toBe('type-1');
      expect(archivedItems.inventoryLots[0].purchaseDate).toEqual(
        new Date('2026-04-01T00:00:00.000Z'),
      );
      expect(archivedItems.pagination?.hasMoreInventoryLots).toBeTrue();
    });
    const archivedItemsRequest = httpMock.expectOne(
      `${environment.apiUrl}/pantry/archived`,
    );
    expect(archivedItemsRequest.request.withCredentials).toBeTrue();
    archivedItemsRequest.flush({
      productTypes: [makeApiProductType()],
      inventoryLots: [
        {
          id: 'lot-1',
          userId: 'tester',
          productTypeId: 'type-1',
          variantName: 'Botella grande',
          quantity: 1,
          unit: 'lt',
          expiresAt: null,
          purchaseDate: '2026-04-01T00:00:00.000Z',
          archivedAt: '2026-04-24T00:00:00.000Z',
          expirationStatus: 'none',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-24T00:00:00.000Z',
        },
      ],
      pagination: {
        limit: 50,
        inventoryLotsNextCursor: 'next-lots',
        hasMoreProductTypes: false,
        hasMoreInventoryLots: true,
      },
    });
  });

  it('passes archived pantry cursor query parameters', () => {
    service
      .getArchivedPantryItems({
        limit: 10,
        productTypesCursor: 'types-cursor',
        includeInventoryLots: false,
      })
      .subscribe();

    const request = httpMock.expectOne((candidate) => {
      return (
        candidate.url === `${environment.apiUrl}/pantry/archived` &&
        candidate.params.get('limit') === '10' &&
        candidate.params.get('productTypesCursor') === 'types-cursor' &&
        candidate.params.get('includeInventoryLots') === 'false'
      );
    });
    expect(request.request.withCredentials).toBeTrue();
    request.flush({
      productTypes: [],
      inventoryLots: [],
      pagination: {
        limit: 10,
        hasMoreProductTypes: false,
        hasMoreInventoryLots: false,
      },
    });
  });

  it('requests a portable pantry export', () => {
    service.exportPantryData().subscribe((exportData) => {
      expect(exportData.formatVersion).toBe(1);
      expect(exportData.profile.email).toBe('chef@example.com');
    });

    const request = httpMock.expectOne(`${environment.apiUrl}/pantry/export`);
    expect(request.request.withCredentials).toBeTrue();
    request.flush({
      formatVersion: 1,
      exportedAt: '2026-05-17T00:00:00.000Z',
      profile: {
        id: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        status: 'active',
        connectedIdentityCount: 1,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z',
        retentionPolicy: {
          archivedRecordRetentionDays: 365,
          archivedRecordAutoDeleteEnabled: false,
          temporaryShoppingShareRetentionDays: 7,
          permanentlyDeletedRecords: 'removed_immediately',
          accountDeletion: 'local_and_cognito_delete_requested',
        },
        security: {
          stepUp: {
            enabled: false,
            maxAgeSeconds: 900,
            fresh: true,
          },
        },
        preferences: {
          expirationWarningDays: 7,
          showExpiredEntryAlert: true,
          depletionWarningThresholdRatio: 1,
          shoppingPlanLeadDays: 3,
          showGuidanceTips: true,
        },
      },
      overview: {
        userId: 'user-1',
        generatedAt: '2026-05-17T00:00:00.000Z',
        preferences: {
          expirationWarningDays: 7,
          showExpiredEntryAlert: true,
          depletionWarningThresholdRatio: 1,
          shoppingPlanLeadDays: 3,
          showGuidanceTips: true,
        },
        items: [],
        expiringItems: [],
        depletingItems: [],
        shoppingPlanItems: [],
        shoppingPlanEstimatedTotal: 0,
      },
      archived: {
        productTypes: [],
        inventoryLots: [],
      },
    });
  });

  it('loads waste overview and normalizes event dates', () => {
    service.getWasteOverview().subscribe((overview) => {
      expect(overview.eventCount).toBe(1);
      expect(overview.recentEvents[0].occurredAt).toEqual(
        new Date('2026-06-09T00:00:00.000Z'),
      );
    });

    const request = httpMock.expectOne(
      `${environment.apiUrl}/pantry/waste-overview`,
    );
    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBeTrue();
    request.flush({
      userId: 'tester',
      generatedAt: '2026-06-09T00:01:00.000Z',
      windowDays: 30,
      eventCount: 1,
      estimatedLossTotal: 25,
      totalQuantityByUnit: [
        {
          unit: 'piezas',
          quantity: 1,
        },
      ],
      reasonBreakdown: [
        {
          reason: 'expired',
          eventCount: 1,
          estimatedLossTotal: 25,
        },
      ],
      recentEvents: [
        {
          id: 'waste-1',
          productName: 'Leche',
          quantity: 1,
          unit: 'piezas',
          reason: 'expired',
          estimatedLoss: 25,
          occurredAt: '2026-06-09T00:00:00.000Z',
        },
      ],
    });
  });

  it('creates, resolves, and revokes server-backed shopping share tokens', () => {
    service
      .createShoppingShare({ text: 'Lista de compras\n- Arroz' })
      .subscribe((share) => {
        expect(share.token).toBe('opaque-token');
        expect(share.createdAt).toEqual(new Date('2026-05-19T00:00:00.000Z'));
        expect(share.expiresAt).toEqual(new Date('2026-05-26T00:00:00.000Z'));
      });

    const createRequest = httpMock.expectOne(
      `${environment.apiUrl}/pantry/shopping-shares`,
    );
    expect(createRequest.request.method).toBe('POST');
    expect(createRequest.request.withCredentials).toBeTrue();
    expect(createRequest.request.body).toEqual({
      text: 'Lista de compras\n- Arroz',
    });
    createRequest.flush({
      token: 'opaque-token',
      createdAt: '2026-05-19T00:00:00.000Z',
      expiresAt: '2026-05-26T00:00:00.000Z',
    });

    service.resolveShoppingShare('opaque-token').subscribe((share) => {
      expect(share.text).toContain('Arroz');
      expect(share.expiresAt).toEqual(new Date('2026-05-26T00:00:00.000Z'));
    });

    const resolveRequest = httpMock.expectOne(
      `${environment.apiUrl}/shopping-shares/opaque-token`,
    );
    expect(resolveRequest.request.method).toBe('GET');
    expect(resolveRequest.request.withCredentials).toBeFalse();
    resolveRequest.flush({
      text: 'Lista de compras\n- Arroz',
      createdAt: '2026-05-19T00:00:00.000Z',
      expiresAt: '2026-05-26T00:00:00.000Z',
    });

    service.revokeShoppingShare('opaque-token').subscribe((share) => {
      expect(share.revokedAt).toEqual(new Date('2026-05-20T00:00:00.000Z'));
    });

    const revokeRequest = httpMock.expectOne(
      `${environment.apiUrl}/pantry/shopping-shares/opaque-token`,
    );
    expect(revokeRequest.request.method).toBe('DELETE');
    expect(revokeRequest.request.withCredentials).toBeTrue();
    revokeRequest.flush({
      createdAt: '2026-05-19T00:00:00.000Z',
      expiresAt: '2026-05-26T00:00:00.000Z',
      revokedAt: '2026-05-20T00:00:00.000Z',
    });
  });

  it('lists active shopping shares and revokes one by id', () => {
    service.listActiveShoppingShares().subscribe((shares) => {
      expect(shares).toEqual([
        jasmine.objectContaining({
          id: 'share-active-1',
          createdAt: new Date('2026-05-19T00:00:00.000Z'),
          expiresAt: new Date('2026-05-26T00:00:00.000Z'),
          revokedAt: null,
        }),
      ]);
    });

    const listRequest = httpMock.expectOne(
      `${environment.apiUrl}/pantry/shopping-shares`,
    );
    expect(listRequest.request.method).toBe('GET');
    expect(listRequest.request.withCredentials).toBeTrue();
    listRequest.flush([
      {
        id: 'share-active-1',
        createdAt: '2026-05-19T00:00:00.000Z',
        expiresAt: '2026-05-26T00:00:00.000Z',
      },
    ]);

    service.revokeShoppingShareById('share-active-1').subscribe((share) => {
      expect(share.id).toBe('share-active-1');
      expect(share.revokedAt).toEqual(new Date('2026-05-20T00:00:00.000Z'));
    });

    const revokeRequest = httpMock.expectOne(
      `${environment.apiUrl}/pantry/shopping-shares/by-id/share-active-1`,
    );
    expect(revokeRequest.request.method).toBe('DELETE');
    expect(revokeRequest.request.withCredentials).toBeTrue();
    revokeRequest.flush({
      id: 'share-active-1',
      createdAt: '2026-05-19T00:00:00.000Z',
      expiresAt: '2026-05-26T00:00:00.000Z',
      revokedAt: '2026-05-20T00:00:00.000Z',
    });
  });
});

function makeEffectivePlanningSettings() {
  return {
    planningEnabled: true,
    expirationWarningDays: 7,
    depletionWarningThresholdRatio: 1,
    shoppingPlanLeadDays: 3,
    expirationWarningDaysSource: 'profile',
    depletionWarningThresholdRatioSource: 'profile',
    shoppingPlanLeadDaysSource: 'profile',
  };
}

function makeApiProductType() {
  return {
    id: 'type-1',
    userId: 'tester',
    baseName: 'Detergente',
    category: 'cleaning',
    defaultUnit: 'lt',
    planningSettings: {
      planningEnabled: true,
    },
    archivedAt: '2026-04-24T00:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  };
}

function makeApiInventoryLot() {
  return {
    id: 'lot-1',
    userId: 'tester',
    productTypeId: 'type-1',
    quantity: 1,
    unit: 'piezas',
    expiresAt: null,
    purchaseDate: null,
    archivedAt: null,
    expirationStatus: 'none',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-24T00:00:00.000Z',
  };
}
