import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import {
  ProductType,
  ProductTypeShoppingMetadataPrimitives,
} from '../../domain/entities/product-type.entity';
import {
  ExpirationStatus,
  ProductCategory,
  QuantityUnit,
} from '../../domain/enums';
import {
  UserPreferences,
  UserPreferencesPatch,
} from '../../domain/value-objects/user-preferences.vo';
import { calculateGroupedDepletionForecast } from '../services/depletion-forecast.service';
import {
  addCivilDays,
  mexicoCityDateLabel,
  utcDateLabel,
} from '../../domain/utils/civil-date';
import {
  DepletingProductGroup,
  ExpiringProductGroup,
  PriceReferenceItem,
  PantryStapleCatalogGroup,
  PantryStapleItem,
  PantryStapleStatus,
  PantryLotSummary,
  PantryOverview,
  PantryOverviewItem,
  ProductTypeEffectivePlanningSettings,
  ShoppingRouteCategoryGroup,
  ShoppingPlanItem,
  ShoppingRouteGroup,
  ShoppingPlanUrgency,
} from '../read-models/pantry-overview.read-model';

const DEFAULT_SHOPPING_LOCATION = 'Sin tienda definida';
const STORE_ROUTE_CATEGORY_ORDER: ProductCategory[] = [
  ProductCategory.FOOD,
  ProductCategory.CLEANING,
  ProductCategory.HYGIENE,
  ProductCategory.OTHER,
];
const STORE_ROUTE_LOCATION_ORDER = [
  'Supermercado',
  'Mercado',
  'Tiendita',
  'Abarrotes',
  'Mayoreo',
  'Farmacia',
  'Limpieza',
  'Bodega',
  'Otro',
  DEFAULT_SHOPPING_LOCATION,
];

export function buildPantryOverview(
  userId: string,
  productTypes: ProductType[],
  inventoryLots: InventoryLot[],
  referenceDate: Date = new Date(),
  preferencesInput?: UserPreferencesPatch,
): PantryOverview {
  const preferences = UserPreferences.resolve(preferencesInput).toPrimitives();
  const activeProductTypes = productTypes.filter(
    (productType) => !productType.isArchived(),
  );
  const productTypeMap = new Map(
    activeProductTypes.map((productType) => [
      productType.id.toString(),
      productType,
    ]),
  );

  const groupedItems = new Map<
    string,
    PantryOverviewItem & {
      lotEntities: InventoryLot[];
      variantSet: Set<string>;
    }
  >();

  for (const productType of activeProductTypes) {
    const groupKey = productType.id.toString();
    const effectivePlanningSettings = resolveEffectivePlanningSettings(
      productType,
      preferences,
    );
    groupedItems.set(groupKey, {
      productTypeId: groupKey,
      baseName: productType.baseName,
      category: productType.category,
      defaultUnit: productType.defaultUnit,
      totalQuantity: 0,
      lotCount: 0,
      nextExpirationAt: undefined,
      expiringSoonQuantity: 0,
      hasDepletionRule: false,
      effectivePlanningSettings,
      shoppingMetadata: productType.shoppingMetadata,
      variants: [],
      lots: [],
      lotEntities: [],
      variantSet: new Set<string>(),
    });
  }

  for (const inventoryLot of inventoryLots) {
    if (inventoryLot.isArchived()) {
      continue;
    }

    const productType = productTypeMap.get(
      inventoryLot.productTypeId.toString(),
    );

    if (!productType) {
      continue;
    }

    const groupKey = productType.id.toString();
    const existingGroup = groupedItems.get(groupKey);

    if (!existingGroup) {
      continue;
    }

    const lotSummary = toLotSummary(
      inventoryLot,
      referenceDate,
      existingGroup.effectivePlanningSettings.expirationWarningDays,
    );

    existingGroup.totalQuantity = Number(
      (existingGroup.totalQuantity + inventoryLot.quantity).toFixed(2),
    );
    existingGroup.lotCount += 1;
    existingGroup.lotEntities.push(inventoryLot);
    existingGroup.lots.push(lotSummary);

    if (inventoryLot.variantName) {
      existingGroup.variantSet.add(inventoryLot.variantName);
    }

    if (
      inventoryLot.expiresAt &&
      (!existingGroup.nextExpirationAt ||
        inventoryLot.expiresAt < existingGroup.nextExpirationAt)
    ) {
      existingGroup.nextExpirationAt = inventoryLot.expiresAt;
    }

    if (
      inventoryLot.isExpiringWithinDays(
        existingGroup.effectivePlanningSettings.expirationWarningDays,
        referenceDate,
      )
    ) {
      existingGroup.expiringSoonQuantity = Number(
        (existingGroup.expiringSoonQuantity + inventoryLot.quantity).toFixed(2),
      );
    }
  }

  const items = Array.from(groupedItems.values())
    .map(({ lotEntities, variantSet, ...group }) => {
      const productType = productTypeMap.get(group.productTypeId);
      const depletionForecast = calculateGroupedDepletionForecast(
        productType?.defaultDepletionRule,
        lotEntities.map((lot) => ({
          recordedAvailableQuantity: lot.quantity,
          startDate: lot.purchaseDate,
        })),
        referenceDate,
      );

      return {
        ...group,
        hasDepletionRule: Boolean(depletionForecast),
        depletionRule: depletionForecast?.depletionRule,
        estimatedCurrentQuantity: depletionForecast?.estimatedCurrentQuantity,
        estimatedConsumedQuantity: depletionForecast?.estimatedConsumedQuantity,
        estimatedDepletionAt: depletionForecast?.estimatedDepletionAt,
        effectivePlanningSettings: group.effectivePlanningSettings,
        variants: Array.from(variantSet).sort(compareText),
        lots: [...group.lots].sort(compareLotSummary),
      };
    })
    .sort(compareGroupSummary);

  const expiringItems = items
    .filter((item) => item.expiringSoonQuantity > 0)
    .map<ExpiringProductGroup>((item) => ({
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      totalExpiringQuantity: item.expiringSoonQuantity,
      nextExpirationAt: item.nextExpirationAt,
      lotCount: item.lots.filter(
        (lot) =>
          lot.expirationStatus === ExpirationStatus.CRITICAL ||
          lot.expirationStatus === ExpirationStatus.EXPIRED ||
          lot.expirationStatus === ExpirationStatus.SOON,
      ).length,
      lots: item.lots.filter(
        (lot) =>
          lot.expirationStatus === ExpirationStatus.CRITICAL ||
          lot.expirationStatus === ExpirationStatus.EXPIRED ||
          lot.expirationStatus === ExpirationStatus.SOON,
      ),
    }))
    .sort(compareExpiringGroup);

  const depletingItems = items
    .filter(
      (item) =>
        item.hasDepletionRule &&
        item.effectivePlanningSettings.planningEnabled &&
        item.shoppingMetadata.replenishWhenLow &&
        item.depletionRule &&
        item.estimatedCurrentQuantity !== undefined &&
        item.estimatedCurrentQuantity <=
          item.depletionRule.consumeAmount *
            item.effectivePlanningSettings.depletionWarningThresholdRatio,
    )
    .map<DepletingProductGroup>((item) => ({
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      defaultUnit: item.defaultUnit,
      totalQuantity: item.totalQuantity,
      estimatedCurrentQuantity: item.estimatedCurrentQuantity ?? 0,
      estimatedConsumedQuantity: item.estimatedConsumedQuantity ?? 0,
      estimatedDepletionAt: item.estimatedDepletionAt ?? referenceDate,
      depletionRule: item.depletionRule!,
      effectivePlanningSettings: item.effectivePlanningSettings,
      shoppingMetadata: item.shoppingMetadata,
    }))
    .sort(compareDepletingGroup);

  const shoppingPlanItems = items
    .filter(
      (item) =>
        item.hasDepletionRule &&
        item.effectivePlanningSettings.planningEnabled &&
        item.shoppingMetadata.replenishWhenLow &&
        item.depletionRule &&
        item.estimatedCurrentQuantity !== undefined &&
        item.estimatedConsumedQuantity !== undefined &&
        item.estimatedDepletionAt,
    )
    .map<ShoppingPlanItem>((item) => {
      const estimatedDepletionAt = item.estimatedDepletionAt ?? referenceDate;
      const recommendedPurchaseAt = clampToReferenceDate(
        subtractDays(
          estimatedDepletionAt,
          item.effectivePlanningSettings.shoppingPlanLeadDays,
        ),
        referenceDate,
      );

      return {
        productTypeId: item.productTypeId,
        baseName: item.baseName,
        category: item.category,
        defaultUnit: item.defaultUnit,
        totalQuantity: item.totalQuantity,
        estimatedCurrentQuantity: item.estimatedCurrentQuantity ?? 0,
        estimatedConsumedQuantity: item.estimatedConsumedQuantity ?? 0,
        estimatedDepletionAt,
        recommendedPurchaseAt,
        suggestedPurchaseQuantity: item.depletionRule!.consumeAmount,
        estimatedUnitPrice: item.shoppingMetadata.estimatedUnitPrice,
        estimatedLineTotal: getEstimatedLineTotal(
          item.shoppingMetadata.estimatedUnitPrice,
          item.depletionRule!.consumeAmount,
        ),
        effectivePlanningSettings: item.effectivePlanningSettings,
        shoppingMetadata: item.shoppingMetadata,
        urgency: getShoppingPlanUrgency(
          item.estimatedCurrentQuantity ?? 0,
          estimatedDepletionAt,
          recommendedPurchaseAt,
          referenceDate,
        ),
        depletionRule: item.depletionRule!,
      };
    })
    .sort(compareShoppingPlanItem);

  const shoppingPlanEstimatedTotal = Number(
    shoppingPlanItems
      .reduce((sum, item) => sum + (item.estimatedLineTotal ?? 0), 0)
      .toFixed(2),
  );
  const shoppingRouteGroups = buildShoppingRouteGroups(shoppingPlanItems);
  const priceReferenceItems = buildPriceReferenceItems(activeProductTypes);
  const stapleItems = items
    .filter(
      (item) =>
        item.shoppingMetadata.householdStaple &&
        item.shoppingMetadata.replenishWhenLow,
    )
    .map<PantryStapleItem>((item) => {
      const suggestedPurchaseQuantity = item.depletionRule?.consumeAmount ?? 1;
      const status = getStapleStatus(item);

      return {
        productTypeId: item.productTypeId,
        baseName: item.baseName,
        category: item.category,
        defaultUnit: item.defaultUnit,
        totalQuantity: item.totalQuantity,
        estimatedCurrentQuantity: item.estimatedCurrentQuantity,
        suggestedPurchaseQuantity,
        estimatedUnitPrice: item.shoppingMetadata.estimatedUnitPrice,
        estimatedRestockTotal:
          status === 'available'
            ? undefined
            : getEstimatedLineTotal(
                item.shoppingMetadata.estimatedUnitPrice,
                suggestedPurchaseQuantity,
              ),
        status,
        shoppingMetadata: item.shoppingMetadata,
      };
    })
    .sort(compareStapleItem);
  const estimatedExpiringValue = Number(
    items
      .reduce(
        (sum, item) =>
          sum +
          item.expiringSoonQuantity *
            (item.shoppingMetadata.estimatedUnitPrice ?? 0),
        0,
      )
      .toFixed(2),
  );
  const estimatedStapleRestockTotal = Number(
    stapleItems
      .reduce((sum, item) => sum + (item.estimatedRestockTotal ?? 0), 0)
      .toFixed(2),
  );
  const stapleCatalogGroups = buildStapleCatalogGroups(stapleItems);
  const pricedShoppingItemCount = shoppingPlanItems.filter(
    (item) => item.estimatedLineTotal !== undefined,
  ).length;
  const unpricedShoppingItemCount =
    shoppingPlanItems.length - pricedShoppingItemCount;
  const promoOnlyShoppingItems = shoppingPlanItems.filter(
    (item) => item.shoppingMetadata.buyOnlyOnPromo,
  );
  const estimatedPromoOnlyTotal = Number(
    promoOnlyShoppingItems
      .reduce((sum, item) => sum + (item.estimatedLineTotal ?? 0), 0)
      .toFixed(2),
  );
  const duplicatePurchaseWarningCount = shoppingPlanItems.filter(
    (item) => item.totalQuantity > 0 && item.urgency !== 'depleted',
  ).length;

  return {
    userId,
    generatedAt: referenceDate,
    preferences,
    items,
    expiringItems,
    depletingItems,
    shoppingPlanItems,
    shoppingPlanEstimatedTotal,
    shoppingRouteGroups,
    priceReferenceItems,
    stapleItems,
    stapleCatalogGroups,
    valueInsights: {
      stapleCount: stapleItems.length,
      stapleAttentionCount: stapleItems.filter(
        (item) => item.status !== 'available',
      ).length,
      estimatedShoppingTotal: shoppingPlanEstimatedTotal,
      estimatedExpiringValue,
      estimatedWasteAtRisk: estimatedExpiringValue,
      estimatedStapleRestockTotal,
      pricedShoppingItemCount,
      unpricedShoppingItemCount,
      promoOnlyShoppingItemCount: promoOnlyShoppingItems.length,
      estimatedPromoOnlyTotal,
      duplicatePurchaseWarningCount,
    },
  };
}

function buildShoppingRouteGroups(
  shoppingPlanItems: ShoppingPlanItem[],
): ShoppingRouteGroup[] {
  const grouped = new Map<string, ShoppingPlanItem[]>();

  for (const item of shoppingPlanItems) {
    const location =
      item.shoppingMetadata.shoppingLocation ?? DEFAULT_SHOPPING_LOCATION;
    grouped.set(location, [...(grouped.get(location) ?? []), item]);
  }

  return Array.from(grouped.entries())
    .map(([shoppingLocation, items]) => {
      const orderedItems = [...items].sort(compareShoppingRouteItem);

      return {
        shoppingLocation,
        itemCount: orderedItems.length,
        urgentItemCount: orderedItems.filter(
          (item) => item.urgency !== 'upcoming',
        ).length,
        promoOnlyCount: orderedItems.filter(
          (item) => item.shoppingMetadata.buyOnlyOnPromo,
        ).length,
        missingPriceCount: orderedItems.filter(
          (item) => item.estimatedLineTotal === undefined,
        ).length,
        estimatedTotal: Number(
          orderedItems
            .reduce((sum, item) => sum + (item.estimatedLineTotal ?? 0), 0)
            .toFixed(2),
        ),
        nextRecommendedPurchaseAt: orderedItems
          .map((item) => item.recommendedPurchaseAt)
          .sort((left, right) => left.getTime() - right.getTime())[0],
        categoryBreakdown: buildRouteCategoryBreakdown(orderedItems),
        items: orderedItems,
      };
    })
    .sort(compareShoppingRouteGroup);
}

function buildRouteCategoryBreakdown(
  items: ShoppingPlanItem[],
): ShoppingRouteCategoryGroup[] {
  const grouped = new Map<ProductCategory, ShoppingPlanItem[]>();

  for (const item of items) {
    grouped.set(item.category, [...(grouped.get(item.category) ?? []), item]);
  }

  return Array.from(grouped.entries())
    .map(([category, categoryItems]) => ({
      category,
      itemCount: categoryItems.length,
      estimatedTotal: Number(
        categoryItems
          .reduce((sum, item) => sum + (item.estimatedLineTotal ?? 0), 0)
          .toFixed(2),
      ),
      items: categoryItems,
    }))
    .sort(
      (left, right) =>
        getCategoryRank(left.category) - getCategoryRank(right.category),
    );
}

function buildStapleCatalogGroups(
  stapleItems: PantryStapleItem[],
): PantryStapleCatalogGroup[] {
  const grouped = new Map<PantryStapleStatus, PantryStapleItem[]>();

  for (const item of stapleItems) {
    grouped.set(item.status, [...(grouped.get(item.status) ?? []), item]);
  }

  return Array.from(grouped.entries())
    .map(([status, items]) => ({
      status,
      itemCount: items.length,
      estimatedRestockTotal: Number(
        items
          .reduce((sum, item) => sum + (item.estimatedRestockTotal ?? 0), 0)
          .toFixed(2),
      ),
      items,
    }))
    .sort(
      (left, right) =>
        getStapleStatusRank(left.status) - getStapleStatusRank(right.status),
    );
}

function buildPriceReferenceItems(
  productTypes: ProductType[],
): PriceReferenceItem[] {
  return productTypes
    .filter(
      (productType) =>
        productType.shoppingMetadata.estimatedUnitPrice !== undefined,
    )
    .map((productType) => {
      const metadata = productType.shoppingMetadata;

      return {
        productTypeId: productType.id.toString(),
        baseName: productType.baseName,
        category: productType.category,
        defaultUnit: productType.defaultUnit,
        shoppingLocation:
          metadata.shoppingLocation ?? DEFAULT_SHOPPING_LOCATION,
        preferredBrand: metadata.preferredBrand,
        substituteBrand: metadata.substituteBrand,
        estimatedUnitPrice: metadata.estimatedUnitPrice!,
        priceHistory: buildPriceHistory(
          metadata,
          productType.defaultUnit,
          productType.updatedAt,
        ),
        buyOnlyOnPromo: metadata.buyOnlyOnPromo,
        updatedAt: productType.updatedAt,
      };
    })
    .sort(comparePriceReferenceItem);
}

function buildPriceHistory(
  metadata: ProductTypeShoppingMetadataPrimitives,
  defaultUnit: QuantityUnit,
  updatedAt: Date,
): PriceReferenceItem['priceHistory'] {
  if (metadata.priceHistory && metadata.priceHistory.length > 0) {
    return metadata.priceHistory
      .map((entry) => ({
        ...entry,
        recordedAt: new Date(entry.recordedAt),
      }))
      .sort(
        (left, right) => right.recordedAt.getTime() - left.recordedAt.getTime(),
      );
  }

  if (metadata.estimatedUnitPrice === undefined) {
    return [];
  }

  return [
    {
      shoppingLocation: metadata.shoppingLocation,
      preferredBrand: metadata.preferredBrand,
      unit: defaultUnit,
      estimatedUnitPrice: metadata.estimatedUnitPrice,
      recordedAt: updatedAt,
    },
  ];
}

function getEstimatedLineTotal(
  estimatedUnitPrice: number | undefined,
  suggestedPurchaseQuantity: number,
): number | undefined {
  if (estimatedUnitPrice === undefined) {
    return undefined;
  }

  return Number((estimatedUnitPrice * suggestedPurchaseQuantity).toFixed(2));
}

function toLotSummary(
  inventoryLot: InventoryLot,
  referenceDate: Date,
  expirationWarningDays: number,
): PantryLotSummary {
  return {
    lotId: inventoryLot.id.toString(),
    variantName: inventoryLot.variantName,
    quantity: inventoryLot.quantity,
    unit: inventoryLot.unit,
    expiresAt: inventoryLot.expiresAt,
    purchaseDate: inventoryLot.purchaseDate,
    expirationStatus: inventoryLot.getExpirationStatus(
      referenceDate,
      expirationWarningDays,
    ),
    updatedAt: inventoryLot.updatedAt,
  };
}

function compareGroupSummary(
  left: PantryOverviewItem,
  right: PantryOverviewItem,
): number {
  if (left.nextExpirationAt && right.nextExpirationAt) {
    const dateDifference =
      left.nextExpirationAt.getTime() - right.nextExpirationAt.getTime();

    if (dateDifference !== 0) {
      return dateDifference;
    }
  }

  if (left.nextExpirationAt) {
    return -1;
  }

  if (right.nextExpirationAt) {
    return 1;
  }

  return compareText(left.baseName, right.baseName);
}

function compareExpiringGroup(
  left: ExpiringProductGroup,
  right: ExpiringProductGroup,
): number {
  if (left.nextExpirationAt && right.nextExpirationAt) {
    return left.nextExpirationAt.getTime() - right.nextExpirationAt.getTime();
  }

  if (left.nextExpirationAt) {
    return -1;
  }

  if (right.nextExpirationAt) {
    return 1;
  }

  return compareText(left.baseName, right.baseName);
}

function compareDepletingGroup(
  left: DepletingProductGroup,
  right: DepletingProductGroup,
): number {
  const dateDifference =
    left.estimatedDepletionAt.getTime() - right.estimatedDepletionAt.getTime();

  if (dateDifference !== 0) {
    return dateDifference;
  }

  return compareText(left.baseName, right.baseName);
}

function compareShoppingPlanItem(
  left: ShoppingPlanItem,
  right: ShoppingPlanItem,
): number {
  const dateDifference =
    left.recommendedPurchaseAt.getTime() -
    right.recommendedPurchaseAt.getTime();

  if (dateDifference !== 0) {
    return dateDifference;
  }

  return compareText(left.baseName, right.baseName);
}

function compareShoppingRouteItem(
  left: ShoppingPlanItem,
  right: ShoppingPlanItem,
): number {
  const categoryDifference =
    getCategoryRank(left.category) - getCategoryRank(right.category);

  if (categoryDifference !== 0) {
    return categoryDifference;
  }

  return compareShoppingPlanItem(left, right);
}

function compareShoppingRouteGroup(
  left: ShoppingRouteGroup,
  right: ShoppingRouteGroup,
): number {
  const locationRankDifference =
    getShoppingLocationRank(left.shoppingLocation) -
    getShoppingLocationRank(right.shoppingLocation);

  if (locationRankDifference !== 0) {
    return locationRankDifference;
  }

  const dateDifference =
    left.nextRecommendedPurchaseAt.getTime() -
    right.nextRecommendedPurchaseAt.getTime();

  if (dateDifference !== 0) {
    return dateDifference;
  }

  const missingPriceDifference =
    left.missingPriceCount - right.missingPriceCount;

  if (missingPriceDifference !== 0) {
    return missingPriceDifference;
  }

  const urgentDifference = right.urgentItemCount - left.urgentItemCount;

  if (urgentDifference !== 0) {
    return urgentDifference;
  }

  return compareText(left.shoppingLocation, right.shoppingLocation);
}

function comparePriceReferenceItem(
  left: PriceReferenceItem,
  right: PriceReferenceItem,
): number {
  const locationDifference = compareText(
    left.shoppingLocation,
    right.shoppingLocation,
  );

  if (locationDifference !== 0) {
    return locationDifference;
  }

  return compareText(left.baseName, right.baseName);
}

function getStapleStatus(item: PantryOverviewItem): PantryStapleStatus {
  const estimatedCurrentQuantity =
    item.estimatedCurrentQuantity ?? item.totalQuantity;

  if (estimatedCurrentQuantity <= 0 || item.totalQuantity <= 0) {
    return 'missing';
  }

  if (
    item.expiringSoonQuantity > 0 ||
    (item.depletionRule &&
      estimatedCurrentQuantity <=
        item.depletionRule.consumeAmount *
          item.effectivePlanningSettings.depletionWarningThresholdRatio)
  ) {
    return 'low';
  }

  return 'available';
}

function compareStapleItem(
  left: PantryStapleItem,
  right: PantryStapleItem,
): number {
  const statusDifference =
    getStapleStatusRank(left.status) - getStapleStatusRank(right.status);

  if (statusDifference !== 0) {
    return statusDifference;
  }

  const locationDifference = compareText(
    left.shoppingMetadata.shoppingLocation ?? '',
    right.shoppingMetadata.shoppingLocation ?? '',
  );

  if (locationDifference !== 0) {
    return locationDifference;
  }

  return compareText(left.baseName, right.baseName);
}

function getCategoryRank(category: ProductCategory): number {
  const index = STORE_ROUTE_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? STORE_ROUTE_CATEGORY_ORDER.length : index;
}

function getShoppingLocationRank(location: string): number {
  const normalizedLocation = normalizeRouteLocation(location);
  const index = STORE_ROUTE_LOCATION_ORDER.findIndex(
    (candidate) => normalizeRouteLocation(candidate) === normalizedLocation,
  );

  return index === -1 ? STORE_ROUTE_LOCATION_ORDER.length : index;
}

function normalizeRouteLocation(location: string): string {
  return location.trim().toLocaleLowerCase('es');
}

function getStapleStatusRank(status: PantryStapleStatus): number {
  const ranks: Record<PantryStapleStatus, number> = {
    missing: 0,
    low: 1,
    available: 2,
  };

  return ranks[status];
}

function compareLotSummary(
  left: PantryLotSummary,
  right: PantryLotSummary,
): number {
  if (left.expiresAt && right.expiresAt) {
    const dateDifference = left.expiresAt.getTime() - right.expiresAt.getTime();

    if (dateDifference !== 0) {
      return dateDifference;
    }
  }

  if (left.expiresAt) {
    return -1;
  }

  if (right.expiresAt) {
    return 1;
  }

  return right.updatedAt.getTime() - left.updatedAt.getTime();
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'es', { sensitivity: 'base' });
}

function resolveEffectivePlanningSettings(
  productType: ProductType,
  preferences: ReturnType<UserPreferences['toPrimitives']>,
): ProductTypeEffectivePlanningSettings {
  const settings = productType.planningSettings;

  return {
    planningEnabled: settings.planningEnabled,
    expirationWarningDays:
      settings.expirationWarningDaysOverride ??
      preferences.expirationWarningDays,
    depletionWarningThresholdRatio:
      settings.depletionWarningThresholdRatioOverride ??
      preferences.depletionWarningThresholdRatio,
    shoppingPlanLeadDays:
      settings.shoppingPlanLeadDaysOverride ?? preferences.shoppingPlanLeadDays,
    expirationWarningDaysSource:
      settings.expirationWarningDaysOverride === undefined
        ? 'profile'
        : 'productType',
    depletionWarningThresholdRatioSource:
      settings.depletionWarningThresholdRatioOverride === undefined
        ? 'profile'
        : 'productType',
    shoppingPlanLeadDaysSource:
      settings.shoppingPlanLeadDaysOverride === undefined
        ? 'profile'
        : 'productType',
  };
}

function subtractDays(date: Date, days: number): Date {
  return addCivilDays(date, -days);
}

function clampToReferenceDate(date: Date, referenceDate: Date): Date {
  const today = mexicoCityDateLabel(referenceDate);
  const target = utcDateLabel(date);
  return target < today ? today : target;
}

function getShoppingPlanUrgency(
  estimatedCurrentQuantity: number,
  estimatedDepletionAt: Date,
  recommendedPurchaseAt: Date,
  referenceDate: Date,
): ShoppingPlanUrgency {
  if (estimatedCurrentQuantity <= 0) {
    return 'depleted';
  }

  if (
    recommendedPurchaseAt <= mexicoCityDateLabel(referenceDate) ||
    estimatedDepletionAt <= addCivilDays(mexicoCityDateLabel(referenceDate), 7)
  ) {
    return 'critical';
  }

  return 'upcoming';
}
