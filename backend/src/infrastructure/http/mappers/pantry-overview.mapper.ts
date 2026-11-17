import {
  DepletingProductGroup,
  ExpiringProductGroup,
  PriceReferenceItem,
  PantryStapleCatalogGroup,
  PantryLotSummary,
  PantryOverview,
  PantryStapleItem,
  ShoppingRouteCategoryGroup,
  ShoppingPlanItem,
  ShoppingRouteGroup,
} from '../../../application/read-models/pantry-overview.read-model';
import {
  DepletingProductGroupResponseDto,
  ExpiringProductGroupResponseDto,
  PriceReferenceItemResponseDto,
  PantryStapleCatalogGroupResponseDto,
  PantryLotSummaryResponseDto,
  PantryOverviewResponseDto,
  PantryStapleItemResponseDto,
  ShoppingRouteCategoryGroupResponseDto,
  ShoppingPlanItemResponseDto,
  ShoppingRouteGroupResponseDto,
} from '../dtos/pantry-overview-response.dto';

export class PantryOverviewMapper {
  static toResponse(
    overview: PantryOverview,
    householdId: string,
  ): PantryOverviewResponseDto {
    return {
      userId: overview.userId,
      householdId,
      generatedAt: overview.generatedAt,
      preferences: overview.preferences,
      items: overview.items.map((item) => ({
        productTypeId: item.productTypeId,
        baseName: item.baseName,
        category: item.category,
        defaultUnit: item.defaultUnit,
        totalQuantity: item.totalQuantity,
        lotCount: item.lotCount,
        nextExpirationAt: item.nextExpirationAt,
        expiringSoonQuantity: item.expiringSoonQuantity,
        hasDepletionRule: item.hasDepletionRule,
        depletionRule: item.depletionRule,
        effectivePlanningSettings: item.effectivePlanningSettings,
        shoppingMetadata: item.shoppingMetadata,
        estimatedCurrentQuantity: item.estimatedCurrentQuantity,
        estimatedConsumedQuantity: item.estimatedConsumedQuantity,
        estimatedDepletionAt: item.estimatedDepletionAt,
        variants: item.variants,
        lots: item.lots.map((lot) => this.toLotSummaryResponse(lot)),
      })),
      expiringItems: overview.expiringItems.map((item) =>
        this.toExpiringGroupResponse(item),
      ),
      depletingItems: overview.depletingItems.map((item) =>
        this.toDepletingGroupResponse(item),
      ),
      shoppingPlanItems: overview.shoppingPlanItems.map((item) =>
        this.toShoppingPlanItemResponse(item),
      ),
      shoppingPlanEstimatedTotal: overview.shoppingPlanEstimatedTotal,
      shoppingRouteGroups: (overview.shoppingRouteGroups ?? []).map((group) =>
        this.toShoppingRouteGroupResponse(group),
      ),
      priceReferenceItems: (overview.priceReferenceItems ?? []).map((item) =>
        this.toPriceReferenceItemResponse(item),
      ),
      stapleItems: overview.stapleItems.map((item) =>
        this.toStapleItemResponse(item),
      ),
      stapleCatalogGroups: overview.stapleCatalogGroups.map((group) =>
        this.toStapleCatalogGroupResponse(group),
      ),
      valueInsights: overview.valueInsights,
    };
  }

  static toExpiringGroupResponse(
    item: ExpiringProductGroup,
  ): ExpiringProductGroupResponseDto {
    return {
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      totalExpiringQuantity: item.totalExpiringQuantity,
      nextExpirationAt: item.nextExpirationAt,
      lotCount: item.lotCount,
      lots: item.lots.map((lot) => this.toLotSummaryResponse(lot)),
    };
  }

  static toDepletingGroupResponse(
    item: DepletingProductGroup,
  ): DepletingProductGroupResponseDto {
    return {
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      defaultUnit: item.defaultUnit,
      totalQuantity: item.totalQuantity,
      estimatedCurrentQuantity: item.estimatedCurrentQuantity,
      estimatedConsumedQuantity: item.estimatedConsumedQuantity,
      estimatedDepletionAt: item.estimatedDepletionAt,
      depletionRule: item.depletionRule,
      effectivePlanningSettings: item.effectivePlanningSettings,
      shoppingMetadata: item.shoppingMetadata,
    };
  }

  static toShoppingPlanItemResponse(
    item: ShoppingPlanItem,
  ): ShoppingPlanItemResponseDto {
    return {
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      defaultUnit: item.defaultUnit,
      totalQuantity: item.totalQuantity,
      estimatedCurrentQuantity: item.estimatedCurrentQuantity,
      estimatedConsumedQuantity: item.estimatedConsumedQuantity,
      estimatedDepletionAt: item.estimatedDepletionAt,
      recommendedPurchaseAt: item.recommendedPurchaseAt,
      suggestedPurchaseQuantity: item.suggestedPurchaseQuantity,
      estimatedUnitPrice: item.estimatedUnitPrice,
      estimatedLineTotal: item.estimatedLineTotal,
      urgency: item.urgency,
      depletionRule: item.depletionRule,
      effectivePlanningSettings: item.effectivePlanningSettings,
      shoppingMetadata: item.shoppingMetadata,
    };
  }

  static toShoppingRouteGroupResponse(
    group: ShoppingRouteGroup,
  ): ShoppingRouteGroupResponseDto {
    return {
      shoppingLocation: group.shoppingLocation,
      itemCount: group.itemCount,
      urgentItemCount: group.urgentItemCount,
      promoOnlyCount: group.promoOnlyCount,
      missingPriceCount: group.missingPriceCount,
      estimatedTotal: group.estimatedTotal,
      nextRecommendedPurchaseAt: group.nextRecommendedPurchaseAt,
      categoryBreakdown: group.categoryBreakdown.map((categoryGroup) =>
        this.toShoppingRouteCategoryGroupResponse(categoryGroup),
      ),
      items: group.items.map((item) => this.toShoppingPlanItemResponse(item)),
    };
  }

  static toShoppingRouteCategoryGroupResponse(
    group: ShoppingRouteCategoryGroup,
  ): ShoppingRouteCategoryGroupResponseDto {
    return {
      category: group.category,
      itemCount: group.itemCount,
      estimatedTotal: group.estimatedTotal,
      items: group.items.map((item) => this.toShoppingPlanItemResponse(item)),
    };
  }

  static toPriceReferenceItemResponse(
    item: PriceReferenceItem,
  ): PriceReferenceItemResponseDto {
    return {
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      defaultUnit: item.defaultUnit,
      shoppingLocation: item.shoppingLocation,
      preferredBrand: item.preferredBrand,
      substituteBrand: item.substituteBrand,
      estimatedUnitPrice: item.estimatedUnitPrice,
      priceHistory: item.priceHistory.map((entry) => ({
        shoppingLocation: entry.shoppingLocation,
        preferredBrand: entry.preferredBrand,
        unit: entry.unit,
        estimatedUnitPrice: entry.estimatedUnitPrice,
        recordedAt: entry.recordedAt,
      })),
      buyOnlyOnPromo: item.buyOnlyOnPromo,
      updatedAt: item.updatedAt,
    };
  }

  static toStapleItemResponse(
    item: PantryStapleItem,
  ): PantryStapleItemResponseDto {
    return {
      productTypeId: item.productTypeId,
      baseName: item.baseName,
      category: item.category,
      defaultUnit: item.defaultUnit,
      totalQuantity: item.totalQuantity,
      estimatedCurrentQuantity: item.estimatedCurrentQuantity,
      suggestedPurchaseQuantity: item.suggestedPurchaseQuantity,
      estimatedUnitPrice: item.estimatedUnitPrice,
      estimatedRestockTotal: item.estimatedRestockTotal,
      status: item.status,
      shoppingMetadata: item.shoppingMetadata,
    };
  }

  static toStapleCatalogGroupResponse(
    group: PantryStapleCatalogGroup,
  ): PantryStapleCatalogGroupResponseDto {
    return {
      status: group.status,
      itemCount: group.itemCount,
      estimatedRestockTotal: group.estimatedRestockTotal,
      items: group.items.map((item) => this.toStapleItemResponse(item)),
    };
  }

  private static toLotSummaryResponse(
    lot: PantryLotSummary,
  ): PantryLotSummaryResponseDto {
    return {
      lotId: lot.lotId,
      variantName: lot.variantName,
      quantity: lot.quantity,
      unit: lot.unit,
      expiresAt: lot.expiresAt,
      purchaseDate: lot.purchaseDate,
      expirationStatus: lot.expirationStatus,
      updatedAt: lot.updatedAt,
    };
  }
}
