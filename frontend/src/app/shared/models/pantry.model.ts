import { ApiUserProfile, UserPreferences } from './profile.model';

export type ProductUnit =
  | 'lt'
  | 'kg'
  | 'g'
  | 'piezas'
  | 'ml'
  | 'paquete'
  | 'lata'
  | 'bolsa'
  | 'botella'
  | 'caja'
  | 'docena'
  | 'manojo'
  | 'medio kilo'
  | 'cuarto kilo'
  | 'rollo';
export type ProductCategory = 'food' | 'cleaning' | 'hygiene' | 'other';
export type ExpirationStatus =
  | 'expired'
  | 'critical'
  | 'soon'
  | 'stable'
  | 'none';
export type ProductTypeSelectionMode = 'existing' | 'new';
export type DepletionPeriod = 'day' | 'week' | 'month';
export type ShoppingPlanUrgency = 'depleted' | 'critical' | 'upcoming';
export type PantryStapleStatus = 'available' | 'low' | 'missing';
export type PlanningSettingSource = 'profile' | 'productType';
export type WasteReason =
  | 'expired'
  | 'spoiled'
  | 'not_used'
  | 'overbought'
  | 'other';

export const PRODUCT_UNITS: ProductUnit[] = [
  'piezas',
  'paquete',
  'lata',
  'bolsa',
  'botella',
  'caja',
  'docena',
  'kg',
  'g',
  'lt',
  'ml',
  'manojo',
  'medio kilo',
  'cuarto kilo',
  'rollo',
];
export const STORAGE_LOCATION_OPTIONS = [
  'Despensa',
  'Refrigerador',
  'Nevera',
  'Congelador',
  'Freezer',
  'Baño',
  'Limpieza',
  'Botiquin',
  'Mascotas',
  'Bodega',
  'Sobras',
  'Comidas preparadas',
  'Bebé',
  'Oficina',
  'Auto',
  'Herramientas',
];
export const SHOPPING_LOCATION_OPTIONS = [
  'Supermercado',
  'Mercado',
  'Tiendita',
  'Abarrotes',
  'Mayoreo',
  'Farmacia',
  'Limpieza',
  'Bodega',
  'Otro',
];
export const PRODUCT_CATEGORIES: ProductCategory[] = [
  'food',
  'cleaning',
  'hygiene',
  'other',
];
export const DEPLETION_PERIODS: DepletionPeriod[] = ['day', 'week', 'month'];

export interface ProductTypeDepletionRule {
  enabled: boolean;
  consumeAmount: number;
  unit: ProductUnit;
  everyAmount: number;
  everyPeriod: DepletionPeriod;
  anchorDate: Date;
}

export interface ProductTypeDepletionRuleRequest {
  enabled: boolean;
  consumeAmount: number;
  unit: ProductUnit;
  everyAmount: number;
  everyPeriod: DepletionPeriod;
  anchorDate: string;
}

export interface ProductTypePlanningSettings {
  planningEnabled: boolean;
  expirationWarningDaysOverride?: number;
  depletionWarningThresholdRatioOverride?: number;
  shoppingPlanLeadDaysOverride?: number;
}

export interface ProductTypeShoppingMetadata {
  storageLocation?: string;
  shoppingLocation?: string;
  preferredBrand?: string;
  substituteBrand?: string;
  shoppingNotes?: string;
  estimatedUnitPrice?: number;
  priceHistory?: ProductTypePriceHistoryEntry[];
  householdStaple: boolean;
  buyOnlyOnPromo: boolean;
  replenishWhenLow: boolean;
}

export interface ProductTypePriceHistoryEntry {
  shoppingLocation?: string;
  preferredBrand?: string;
  unit: ProductUnit;
  estimatedUnitPrice: number;
  recordedAt: Date;
}

export type ProductTypeShoppingMetadataRequest =
  Partial<ProductTypeShoppingMetadata>;

export interface ProductTypeEffectivePlanningSettings {
  planningEnabled: boolean;
  expirationWarningDays: number;
  depletionWarningThresholdRatio: number;
  shoppingPlanLeadDays: number;
  expirationWarningDaysSource: PlanningSettingSource;
  depletionWarningThresholdRatioSource: PlanningSettingSource;
  shoppingPlanLeadDaysSource: PlanningSettingSource;
}

export interface ProductType {
  id: string;
  userId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  defaultDepletionRule?: ProductTypeDepletionRule;
  planningSettings: ProductTypePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
  archivedAt: Date | null;
  archivedReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryLot {
  id: string;
  userId: string;
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  expiresAt: Date | null;
  purchaseDate: Date | null;
  archivedAt: Date | null;
  archivedReason?: string;
  expirationStatus: ExpirationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PantryLotSummary {
  lotId: string;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  expiresAt: Date | null;
  purchaseDate: Date | null;
  expirationStatus: ExpirationStatus;
  updatedAt: Date;
}

export interface PantryOverviewItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  lotCount: number;
  nextExpirationAt: Date | null;
  expiringSoonQuantity: number;
  hasDepletionRule: boolean;
  depletionRule?: ProductTypeDepletionRule;
  effectivePlanningSettings: ProductTypeEffectivePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
  estimatedCurrentQuantity?: number;
  estimatedConsumedQuantity?: number;
  estimatedDepletionAt?: Date;
  variants: string[];
  lots: PantryLotSummary[];
}

export interface ExpiringProductGroup {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  totalExpiringQuantity: number;
  nextExpirationAt: Date | null;
  lotCount: number;
  lots: PantryLotSummary[];
}

export interface DepletingProductGroup {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  estimatedCurrentQuantity: number;
  estimatedConsumedQuantity: number;
  estimatedDepletionAt: Date;
  depletionRule: ProductTypeDepletionRule;
  effectivePlanningSettings: ProductTypeEffectivePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

export interface ShoppingPlanItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  estimatedCurrentQuantity: number;
  estimatedConsumedQuantity: number;
  estimatedDepletionAt: Date;
  recommendedPurchaseAt: Date;
  suggestedPurchaseQuantity: number;
  estimatedUnitPrice?: number;
  estimatedLineTotal?: number;
  urgency: ShoppingPlanUrgency;
  depletionRule: ProductTypeDepletionRule;
  effectivePlanningSettings: ProductTypeEffectivePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

export interface ShoppingRouteGroup {
  shoppingLocation: string;
  itemCount: number;
  urgentItemCount: number;
  promoOnlyCount: number;
  missingPriceCount: number;
  estimatedTotal: number;
  nextRecommendedPurchaseAt: Date;
  categoryBreakdown: ShoppingRouteCategoryGroup[];
  items: ShoppingPlanItem[];
}

export interface ShoppingRouteCategoryGroup {
  category: ProductCategory;
  itemCount: number;
  estimatedTotal: number;
  items: ShoppingPlanItem[];
}

export interface PriceReferenceItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  shoppingLocation: string;
  preferredBrand?: string;
  substituteBrand?: string;
  estimatedUnitPrice: number;
  priceHistory: ProductTypePriceHistoryEntry[];
  buyOnlyOnPromo: boolean;
  updatedAt: Date;
}

export interface PantryStapleItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  estimatedCurrentQuantity?: number;
  suggestedPurchaseQuantity: number;
  estimatedUnitPrice?: number;
  estimatedRestockTotal?: number;
  status: PantryStapleStatus;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

export interface PantryValueInsights {
  stapleCount: number;
  stapleAttentionCount: number;
  estimatedShoppingTotal: number;
  estimatedExpiringValue: number;
  estimatedWasteAtRisk: number;
  estimatedStapleRestockTotal: number;
  pricedShoppingItemCount: number;
  unpricedShoppingItemCount: number;
  promoOnlyShoppingItemCount: number;
  estimatedPromoOnlyTotal: number;
  duplicatePurchaseWarningCount?: number;
  weeklyWasteLossEstimate?: number;
}

export interface PantryStapleCatalogGroup {
  status: PantryStapleStatus;
  itemCount: number;
  estimatedRestockTotal: number;
  items: PantryStapleItem[];
}

export interface PantryOverview {
  userId: string;
  generatedAt: Date;
  preferences: UserPreferences;
  items: PantryOverviewItem[];
  expiringItems: ExpiringProductGroup[];
  depletingItems: DepletingProductGroup[];
  shoppingPlanItems: ShoppingPlanItem[];
  shoppingPlanEstimatedTotal: number;
  shoppingRouteGroups: ShoppingRouteGroup[];
  priceReferenceItems: PriceReferenceItem[];
  stapleItems: PantryStapleItem[];
  stapleCatalogGroups: PantryStapleCatalogGroup[];
  valueInsights: PantryValueInsights;
}

export interface CreateProductTypeRequest {
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  defaultDepletionRule?: ProductTypeDepletionRuleRequest;
  shoppingMetadata?: ProductTypeShoppingMetadataRequest;
}

export interface CreateInventoryLotRequest {
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  expiresAt?: string;
  purchaseDate?: string;
}

export interface CloseShoppingPurchaseItemRequest {
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  paidUnitPrice?: number;
  shoppingLocation?: string;
  expiresAt?: string;
}

export interface CloseShoppingPurchaseRequest {
  items: CloseShoppingPurchaseItemRequest[];
}

export interface IdempotentMutationResult<T> {
  value: T;
  idempotencyKey: string;
  replayed: boolean;
}

export interface CursorPagination {
  nextCursor?: string;
}

export interface ApiCursorPage<T> {
  items: T[];
  pagination: CursorPagination;
}

export interface SavedShoppingListItem {
  productTypeId: string;
  baseName: string;
  quantity: number;
  unit: ProductUnit;
  shoppingLocation?: string;
  estimatedUnitPrice?: number;
  estimatedLineTotal?: number;
}

export interface SavedShoppingList {
  id: string;
  ownerUserId?: string;
  title: string;
  occasion?: string;
  shoppingLocation?: string;
  createdAt: Date;
  updatedAt: Date;
  items: SavedShoppingListItem[];
}

export interface ApiSavedShoppingList
  extends Omit<SavedShoppingList, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

export interface CreateSavedShoppingListRequest {
  title: string;
  occasion?: string;
  shoppingLocation?: string;
  items: SavedShoppingListItem[];
}

export interface CreateShoppingShareRequest {
  text: string;
}

export interface ApiShoppingShare {
  id?: string;
  token?: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
}

export interface ShoppingShare {
  id?: string;
  token?: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
}

export interface ApiPublicShoppingShare {
  text: string;
  createdAt: string;
  expiresAt: string;
}

export interface PublicShoppingShare {
  text: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ConsumeInventoryLotRequest {
  quantity: number;
  wasteReason?: WasteReason;
  wasteNote?: string;
}

export interface WasteQuantityTotal {
  unit: ProductUnit;
  quantity: number;
}

export interface WasteReasonSummary {
  reason: WasteReason;
  eventCount: number;
  estimatedLossTotal: number;
}

export interface WasteEventSummary {
  id: string;
  productName: string;
  quantity: number;
  unit: ProductUnit;
  reason: WasteReason;
  note?: string;
  estimatedLoss?: number;
  occurredAt: Date;
}

export interface WasteOverview {
  userId: string;
  generatedAt: Date;
  windowDays: number;
  eventCount: number;
  estimatedLossTotal: number;
  totalQuantityByUnit: WasteQuantityTotal[];
  reasonBreakdown: WasteReasonSummary[];
  recentEvents: WasteEventSummary[];
}

export interface ArchivePantryItemRequest {
  reason?: string;
}

export interface DeletePantryItemRequest {
  confirmationText: string;
}

export interface ProductTypePlanningSettingsRequest {
  planningEnabled?: boolean;
  expirationWarningDaysOverride?: number;
  depletionWarningThresholdRatioOverride?: number;
  shoppingPlanLeadDaysOverride?: number;
}

export interface ArchivedPantryItems {
  productTypes: ProductType[];
  inventoryLots: InventoryLot[];
  pagination?: ArchivedPantryPagination;
}

export interface RegisterLotRequest {
  selectionMode: ProductTypeSelectionMode;
  existingProductTypeId?: string;
  newProductType?: {
    baseName: string;
    category: ProductCategory;
    defaultUnit: ProductUnit;
    defaultDepletionRule?: ProductTypeDepletionRuleRequest;
    shoppingMetadata?: ProductTypeShoppingMetadataRequest;
  };
  defaultDepletionRule?: ProductTypeDepletionRuleRequest;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  expiresAt?: string;
  purchaseDate?: string;
}

export interface ApiProductType {
  id: string;
  userId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  defaultDepletionRule?: ApiProductTypeDepletionRule;
  planningSettings: ProductTypePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
  archivedAt?: string | null;
  archivedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProductTypeDepletionRule {
  enabled: boolean;
  consumeAmount: number;
  unit: ProductUnit;
  everyAmount: number;
  everyPeriod: DepletionPeriod;
  anchorDate: string;
}

export interface ApiPantryLotSummary {
  lotId: string;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  expiresAt?: string | null;
  purchaseDate?: string | null;
  expirationStatus: ExpirationStatus;
  updatedAt: string;
}

export interface ApiPantryOverviewItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  lotCount: number;
  nextExpirationAt?: string | null;
  expiringSoonQuantity: number;
  hasDepletionRule: boolean;
  depletionRule?: ApiProductTypeDepletionRule;
  effectivePlanningSettings: ProductTypeEffectivePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
  estimatedCurrentQuantity?: number;
  estimatedConsumedQuantity?: number;
  estimatedDepletionAt?: string | null;
  variants: string[];
  lots: ApiPantryLotSummary[];
}

export interface ApiExpiringProductGroup {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  totalExpiringQuantity: number;
  nextExpirationAt?: string | null;
  lotCount: number;
  lots: ApiPantryLotSummary[];
}

export interface ApiDepletingProductGroup {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  estimatedCurrentQuantity: number;
  estimatedConsumedQuantity: number;
  estimatedDepletionAt: string;
  depletionRule: ApiProductTypeDepletionRule;
  effectivePlanningSettings: ProductTypeEffectivePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

export interface ApiShoppingPlanItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  estimatedCurrentQuantity: number;
  estimatedConsumedQuantity: number;
  estimatedDepletionAt: string;
  recommendedPurchaseAt: string;
  suggestedPurchaseQuantity: number;
  estimatedUnitPrice?: number;
  estimatedLineTotal?: number;
  urgency: ShoppingPlanUrgency;
  depletionRule: ApiProductTypeDepletionRule;
  effectivePlanningSettings: ProductTypeEffectivePlanningSettings;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

export interface ApiShoppingRouteGroup {
  shoppingLocation: string;
  itemCount: number;
  urgentItemCount: number;
  promoOnlyCount: number;
  missingPriceCount: number;
  estimatedTotal: number;
  nextRecommendedPurchaseAt: string;
  categoryBreakdown?: ApiShoppingRouteCategoryGroup[];
  items: ApiShoppingPlanItem[];
}

export interface ApiShoppingRouteCategoryGroup {
  category: ProductCategory;
  itemCount: number;
  estimatedTotal: number;
  items: ApiShoppingPlanItem[];
}

export interface ApiPriceReferenceItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  shoppingLocation: string;
  preferredBrand?: string;
  substituteBrand?: string;
  estimatedUnitPrice: number;
  priceHistory?: ApiProductTypePriceHistoryEntry[];
  buyOnlyOnPromo: boolean;
  updatedAt: string;
}

export interface ApiProductTypePriceHistoryEntry {
  shoppingLocation?: string;
  preferredBrand?: string;
  unit: ProductUnit;
  estimatedUnitPrice: number;
  recordedAt: string;
}

export interface ApiPantryStapleItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  defaultUnit: ProductUnit;
  totalQuantity: number;
  estimatedCurrentQuantity?: number;
  suggestedPurchaseQuantity: number;
  estimatedUnitPrice?: number;
  estimatedRestockTotal?: number;
  status: PantryStapleStatus;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

export interface ApiPantryStapleCatalogGroup {
  status: PantryStapleStatus;
  itemCount: number;
  estimatedRestockTotal: number;
  items: ApiPantryStapleItem[];
}

export interface ApiPantryOverview {
  userId: string;
  generatedAt: string;
  preferences: UserPreferences;
  items: ApiPantryOverviewItem[];
  expiringItems: ApiExpiringProductGroup[];
  depletingItems: ApiDepletingProductGroup[];
  shoppingPlanItems: ApiShoppingPlanItem[];
  shoppingPlanEstimatedTotal?: number;
  shoppingRouteGroups?: ApiShoppingRouteGroup[];
  priceReferenceItems?: ApiPriceReferenceItem[];
  stapleItems?: ApiPantryStapleItem[];
  stapleCatalogGroups?: ApiPantryStapleCatalogGroup[];
  valueInsights?: PantryValueInsights;
}

export interface ApiInventoryLot {
  id: string;
  userId: string;
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: ProductUnit;
  expiresAt?: string | null;
  purchaseDate?: string | null;
  archivedAt?: string | null;
  archivedReason?: string;
  expirationStatus: ExpirationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApiArchivedPantryItems {
  productTypes: ApiProductType[];
  inventoryLots: ApiInventoryLot[];
  pagination?: ArchivedPantryPagination;
}

export interface ApiWasteEventSummary {
  id: string;
  productName: string;
  quantity: number;
  unit: ProductUnit;
  reason: WasteReason;
  note?: string;
  estimatedLoss?: number;
  occurredAt: string;
}

export interface ApiWasteOverview {
  userId: string;
  generatedAt: string;
  windowDays: number;
  eventCount: number;
  estimatedLossTotal: number;
  totalQuantityByUnit: WasteQuantityTotal[];
  reasonBreakdown: WasteReasonSummary[];
  recentEvents: ApiWasteEventSummary[];
}

export interface ArchivedPantryPagination {
  limit: number;
  productTypesNextCursor?: string;
  inventoryLotsNextCursor?: string;
  hasMoreProductTypes: boolean;
  hasMoreInventoryLots: boolean;
}

export interface ArchivedPantryQuery {
  limit?: number;
  productTypesCursor?: string;
  inventoryLotsCursor?: string;
  includeProductTypes?: boolean;
  includeInventoryLots?: boolean;
}

export interface PantryDataLimits {
  activeProductTypesPerUser: number;
  archivedProductTypesPerUser: number;
  productTypeSearchResults: number;
  activeInventoryLotsPerUser: number;
  archivedInventoryLotsPerUser: number;
  archivedPantryPageSize: number;
  inventoryLotsPerProductType: number;
  shoppingCheckoutItems: number;
  savedShoppingListsPerUser: number;
  savedShoppingListItems: number;
}

export interface ApiPantryExport {
  formatVersion: 1;
  exportedAt: string;
  profile: ApiUserProfile;
  overview: ApiPantryOverview;
  archived: ApiArchivedPantryItems;
  shoppingLists: ApiSavedShoppingList[];
  limits: PantryDataLimits;
}
