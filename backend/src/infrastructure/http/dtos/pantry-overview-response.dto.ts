import { ApiProperty } from '@nestjs/swagger';

export class PantryLotSummaryResponseDto {
  @ApiProperty()
  lotId: string;

  @ApiProperty({ required: false })
  variantName?: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  unit: string;

  @ApiProperty({ required: false })
  expiresAt?: Date;

  @ApiProperty({ required: false })
  purchaseDate?: Date;

  @ApiProperty()
  expirationStatus: string;

  @ApiProperty()
  updatedAt: Date;
}

export class ExpiringProductGroupResponseDto {
  @ApiProperty()
  productTypeId: string;

  @ApiProperty()
  baseName: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  totalExpiringQuantity: number;

  @ApiProperty({ required: false })
  nextExpirationAt?: Date;

  @ApiProperty()
  lotCount: number;

  @ApiProperty({ type: [PantryLotSummaryResponseDto] })
  lots: PantryLotSummaryResponseDto[];
}

export class DepletionRuleResponseDto {
  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  consumeAmount: number;

  @ApiProperty()
  unit: string;

  @ApiProperty()
  everyAmount: number;

  @ApiProperty()
  everyPeriod: string;

  @ApiProperty()
  anchorDate: Date;
}

export class ProductTypeEffectivePlanningSettingsResponseDto {
  @ApiProperty()
  planningEnabled: boolean;

  @ApiProperty()
  expirationWarningDays: number;

  @ApiProperty()
  depletionWarningThresholdRatio: number;

  @ApiProperty()
  shoppingPlanLeadDays: number;

  @ApiProperty()
  expirationWarningDaysSource: string;

  @ApiProperty()
  depletionWarningThresholdRatioSource: string;

  @ApiProperty()
  shoppingPlanLeadDaysSource: string;
}

export class ProductTypeShoppingMetadataResponseDto {
  @ApiProperty({ required: false })
  storageLocation?: string;

  @ApiProperty({ required: false })
  shoppingLocation?: string;

  @ApiProperty({ required: false })
  preferredBrand?: string;

  @ApiProperty({ required: false })
  substituteBrand?: string;

  @ApiProperty({ required: false })
  shoppingNotes?: string;

  @ApiProperty({ required: false })
  estimatedUnitPrice?: number;

  @ApiProperty()
  householdStaple: boolean;

  @ApiProperty()
  buyOnlyOnPromo: boolean;

  @ApiProperty()
  replenishWhenLow: boolean;
}

export class PantryStapleItemResponseDto {
  @ApiProperty()
  productTypeId: string;

  @ApiProperty()
  baseName: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  defaultUnit: string;

  @ApiProperty()
  totalQuantity: number;

  @ApiProperty({ required: false })
  estimatedCurrentQuantity?: number;

  @ApiProperty()
  suggestedPurchaseQuantity: number;

  @ApiProperty({ required: false })
  estimatedUnitPrice?: number;

  @ApiProperty({ required: false })
  estimatedRestockTotal?: number;

  @ApiProperty()
  status: string;

  @ApiProperty({ type: ProductTypeShoppingMetadataResponseDto })
  shoppingMetadata: ProductTypeShoppingMetadataResponseDto;
}

export class PantryValueInsightsResponseDto {
  @ApiProperty()
  stapleCount: number;

  @ApiProperty()
  stapleAttentionCount: number;

  @ApiProperty()
  estimatedShoppingTotal: number;

  @ApiProperty()
  estimatedExpiringValue: number;

  @ApiProperty()
  estimatedWasteAtRisk: number;

  @ApiProperty()
  estimatedStapleRestockTotal: number;

  @ApiProperty()
  pricedShoppingItemCount: number;

  @ApiProperty()
  unpricedShoppingItemCount: number;

  @ApiProperty()
  promoOnlyShoppingItemCount: number;

  @ApiProperty()
  estimatedPromoOnlyTotal: number;

  @ApiProperty()
  duplicatePurchaseWarningCount: number;
}

export class DepletingProductGroupResponseDto {
  @ApiProperty()
  productTypeId: string;

  @ApiProperty()
  baseName: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  defaultUnit: string;

  @ApiProperty()
  totalQuantity: number;

  @ApiProperty()
  estimatedCurrentQuantity: number;

  @ApiProperty()
  estimatedConsumedQuantity: number;

  @ApiProperty()
  estimatedDepletionAt: Date;

  @ApiProperty({ type: DepletionRuleResponseDto })
  depletionRule: DepletionRuleResponseDto;

  @ApiProperty({ type: ProductTypeEffectivePlanningSettingsResponseDto })
  effectivePlanningSettings: ProductTypeEffectivePlanningSettingsResponseDto;

  @ApiProperty({ type: ProductTypeShoppingMetadataResponseDto })
  shoppingMetadata: ProductTypeShoppingMetadataResponseDto;
}

export class ShoppingPlanItemResponseDto {
  @ApiProperty()
  productTypeId: string;

  @ApiProperty()
  baseName: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  defaultUnit: string;

  @ApiProperty()
  totalQuantity: number;

  @ApiProperty()
  estimatedCurrentQuantity: number;

  @ApiProperty()
  estimatedConsumedQuantity: number;

  @ApiProperty()
  estimatedDepletionAt: Date;

  @ApiProperty()
  recommendedPurchaseAt: Date;

  @ApiProperty()
  suggestedPurchaseQuantity: number;

  @ApiProperty({ required: false })
  estimatedUnitPrice?: number;

  @ApiProperty({ required: false })
  estimatedLineTotal?: number;

  @ApiProperty()
  urgency: string;

  @ApiProperty({ type: DepletionRuleResponseDto })
  depletionRule: DepletionRuleResponseDto;

  @ApiProperty({ type: ProductTypeEffectivePlanningSettingsResponseDto })
  effectivePlanningSettings: ProductTypeEffectivePlanningSettingsResponseDto;

  @ApiProperty({ type: ProductTypeShoppingMetadataResponseDto })
  shoppingMetadata: ProductTypeShoppingMetadataResponseDto;
}

export class ShoppingRouteGroupResponseDto {
  @ApiProperty()
  shoppingLocation: string;

  @ApiProperty()
  itemCount: number;

  @ApiProperty()
  urgentItemCount: number;

  @ApiProperty()
  promoOnlyCount: number;

  @ApiProperty()
  missingPriceCount: number;

  @ApiProperty()
  estimatedTotal: number;

  @ApiProperty()
  nextRecommendedPurchaseAt: Date;

  @ApiProperty({ type: () => [ShoppingRouteCategoryGroupResponseDto] })
  categoryBreakdown: ShoppingRouteCategoryGroupResponseDto[];

  @ApiProperty({ type: [ShoppingPlanItemResponseDto] })
  items: ShoppingPlanItemResponseDto[];
}

export class ShoppingRouteCategoryGroupResponseDto {
  @ApiProperty()
  category: string;

  @ApiProperty()
  itemCount: number;

  @ApiProperty()
  estimatedTotal: number;

  @ApiProperty({ type: [ShoppingPlanItemResponseDto] })
  items: ShoppingPlanItemResponseDto[];
}

export class PantryStapleCatalogGroupResponseDto {
  @ApiProperty()
  status: string;

  @ApiProperty()
  itemCount: number;

  @ApiProperty()
  estimatedRestockTotal: number;

  @ApiProperty({ type: [PantryStapleItemResponseDto] })
  items: PantryStapleItemResponseDto[];
}

export class PriceHistoryEntryResponseDto {
  @ApiProperty({ required: false })
  shoppingLocation?: string;

  @ApiProperty({ required: false })
  preferredBrand?: string;

  @ApiProperty()
  unit: string;

  @ApiProperty()
  estimatedUnitPrice: number;

  @ApiProperty()
  recordedAt: Date;
}

export class PriceReferenceItemResponseDto {
  @ApiProperty()
  productTypeId: string;

  @ApiProperty()
  baseName: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  defaultUnit: string;

  @ApiProperty()
  shoppingLocation: string;

  @ApiProperty({ required: false })
  preferredBrand?: string;

  @ApiProperty({ required: false })
  substituteBrand?: string;

  @ApiProperty()
  estimatedUnitPrice: number;

  @ApiProperty({ type: [PriceHistoryEntryResponseDto] })
  priceHistory: PriceHistoryEntryResponseDto[];

  @ApiProperty()
  buyOnlyOnPromo: boolean;

  @ApiProperty()
  updatedAt: Date;
}

export class PantryOverviewItemResponseDto {
  @ApiProperty()
  productTypeId: string;

  @ApiProperty()
  baseName: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  defaultUnit: string;

  @ApiProperty()
  totalQuantity: number;

  @ApiProperty()
  lotCount: number;

  @ApiProperty({ required: false })
  nextExpirationAt?: Date;

  @ApiProperty()
  expiringSoonQuantity: number;

  @ApiProperty()
  hasDepletionRule: boolean;

  @ApiProperty({ required: false, type: DepletionRuleResponseDto })
  depletionRule?: DepletionRuleResponseDto;

  @ApiProperty({ type: ProductTypeEffectivePlanningSettingsResponseDto })
  effectivePlanningSettings: ProductTypeEffectivePlanningSettingsResponseDto;

  @ApiProperty({ type: ProductTypeShoppingMetadataResponseDto })
  shoppingMetadata: ProductTypeShoppingMetadataResponseDto;

  @ApiProperty({ required: false })
  estimatedCurrentQuantity?: number;

  @ApiProperty({ required: false })
  estimatedConsumedQuantity?: number;

  @ApiProperty({ required: false })
  estimatedDepletionAt?: Date;

  @ApiProperty({ type: [String] })
  variants: string[];

  @ApiProperty({ type: [PantryLotSummaryResponseDto] })
  lots: PantryLotSummaryResponseDto[];
}

export class PantryOverviewResponseDto {
  @ApiProperty()
  userId: string;

  @ApiProperty()
  householdId: string;

  @ApiProperty()
  generatedAt: Date;

  @ApiProperty()
  preferences: {
    expirationWarningDays: number;
    showExpiredEntryAlert: boolean;
    depletionWarningThresholdRatio: number;
    shoppingPlanLeadDays: number;
    showGuidanceTips: boolean;
  };

  @ApiProperty({ type: [PantryOverviewItemResponseDto] })
  items: PantryOverviewItemResponseDto[];

  @ApiProperty({ type: [ExpiringProductGroupResponseDto] })
  expiringItems: ExpiringProductGroupResponseDto[];

  @ApiProperty({ type: [DepletingProductGroupResponseDto] })
  depletingItems: DepletingProductGroupResponseDto[];

  @ApiProperty({ type: [ShoppingPlanItemResponseDto] })
  shoppingPlanItems: ShoppingPlanItemResponseDto[];

  @ApiProperty()
  shoppingPlanEstimatedTotal: number;

  @ApiProperty({ type: [ShoppingRouteGroupResponseDto] })
  shoppingRouteGroups: ShoppingRouteGroupResponseDto[];

  @ApiProperty({ type: [PriceReferenceItemResponseDto] })
  priceReferenceItems: PriceReferenceItemResponseDto[];

  @ApiProperty({ type: [PantryStapleItemResponseDto] })
  stapleItems: PantryStapleItemResponseDto[];

  @ApiProperty({ type: [PantryStapleCatalogGroupResponseDto] })
  stapleCatalogGroups: PantryStapleCatalogGroupResponseDto[];

  @ApiProperty({ type: PantryValueInsightsResponseDto })
  valueInsights: PantryValueInsightsResponseDto;
}
