import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { EMPTY, Observable } from 'rxjs';
import { expand, map, reduce, switchMap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import {
  ApiInventoryLot,
  ApiCursorPage,
  ApiArchivedPantryItems,
  ApiPantryExport,
  ApiWasteOverview,
  ApiDepletingProductGroup,
  ApiPantryLotSummary,
  ApiPantryOverview,
  ApiPantryOverviewItem,
  ApiPublicShoppingShare,
  ApiShoppingShare,
  ApiPantryStapleCatalogGroup,
  ApiPantryStapleItem,
  ApiPriceReferenceItem,
  ApiProductType,
  ApiProductTypeDepletionRule,
  ApiShoppingPlanItem,
  ApiShoppingRouteCategoryGroup,
  ApiShoppingRouteGroup,
  ApiSavedShoppingList,
  ArchivedPantryItems,
  ArchivedPantryQuery,
  ArchivePantryItemRequest,
  CloseShoppingPurchaseRequest,
  ConsumeInventoryLotRequest,
  CreateInventoryLotRequest,
  CreateShoppingShareRequest,
  CreateSavedShoppingListRequest,
  CreateProductTypeRequest,
  DeletePantryItemRequest,
  DepletingProductGroup,
  InventoryLot,
  IdempotentMutationResult,
  PantryLotSummary,
  PantryOverview,
  PantryOverviewItem,
  PantryStapleCatalogGroup,
  PantryStapleItem,
  PriceReferenceItem,
  ProductTypeDepletionRule,
  ProductTypeDepletionRuleRequest,
  ProductTypePlanningSettingsRequest,
  ProductTypeShoppingMetadata,
  ProductTypeShoppingMetadataRequest,
  ProductType,
  PublicShoppingShare,
  RegisterLotRequest,
  SavedShoppingList,
  ShoppingShare,
  ShoppingPlanItem,
  ShoppingRouteCategoryGroup,
  ShoppingRouteGroup,
  WasteOverview,
} from '../../shared/models/pantry.model';

@Injectable({
  providedIn: 'root',
})
export class PantryService {
  private readonly apiUrl = environment.apiUrl;
  private readonly productTypesUrl = `${this.apiUrl}/product-types`;
  private readonly inventoryLotsUrl = `${this.apiUrl}/inventory-lots`;
  private readonly pantryOverviewUrl = `${this.apiUrl}/pantry/overview`;
  private readonly archivedPantryUrl = `${this.apiUrl}/pantry/archived`;
  private readonly pantryExportUrl = `${this.apiUrl}/pantry/export`;
  private readonly pantryCheckoutUrl = `${this.apiUrl}/pantry/checkout`;
  private readonly pantryWasteOverviewUrl = `${this.apiUrl}/pantry/waste-overview`;
  private readonly pantryShoppingSharesUrl = `${this.apiUrl}/pantry/shopping-shares`;
  private readonly pantryShoppingListsUrl = `${this.apiUrl}/pantry/shopping-lists`;
  private readonly publicShoppingSharesUrl = `${this.apiUrl}/shopping-shares`;

  constructor(private readonly http: HttpClient) {}

  getPantryOverview(): Observable<PantryOverview> {
    return this.http
      .get<ApiPantryOverview>(this.pantryOverviewUrl, { withCredentials: true })
      .pipe(map((overview) => this.normalizePantryOverview(overview)));
  }

  getWasteOverview(): Observable<WasteOverview> {
    return this.http
      .get<ApiWasteOverview>(this.pantryWasteOverviewUrl, {
        withCredentials: true,
      })
      .pipe(map((overview) => this.normalizeWasteOverview(overview)));
  }

  searchProductTypes(search: string): Observable<ProductType[]> {
    const getPage = (cursor?: string) => this.http
      .get<ApiCursorPage<ApiProductType>>(`${this.productTypesUrl}/page`, {
        params: { search, limit: 50, ...(cursor ? { cursor } : {}) },
        withCredentials: true,
      });
    return getPage().pipe(
      expand(page => page.pagination.nextCursor ? getPage(page.pagination.nextCursor) : EMPTY),
      reduce((items, page) => [...items, ...page.items], [] as ApiProductType[]),
      map(items => items.map(item => this.normalizeProductType(item))),
    );
  }

  createProductType(request: CreateProductTypeRequest): Observable<ProductType> {
    return this.http
      .post<ApiProductType>(this.productTypesUrl, request, {
        withCredentials: true,
      })
      .pipe(map((productType) => this.normalizeProductType(productType)));
  }

  updateProductTypeDepletionRule(
    productTypeId: string,
    defaultDepletionRule: ProductTypeDepletionRuleRequest,
  ): Observable<ProductType> {
    return this.http
      .patch<ApiProductType>(`${this.productTypesUrl}/${productTypeId}/depletion-rule`, {
        defaultDepletionRule,
      }, {
        withCredentials: true,
      })
      .pipe(map((productType) => this.normalizeProductType(productType)));
  }

  updateProductTypePlanningSettings(
    productTypeId: string,
    planningSettings: ProductTypePlanningSettingsRequest,
  ): Observable<ProductType> {
    return this.http
      .patch<ApiProductType>(
        `${this.productTypesUrl}/${productTypeId}/planning-settings`,
        planningSettings,
        { withCredentials: true },
      )
      .pipe(map((productType) => this.normalizeProductType(productType)));
  }

  updateProductTypeShoppingMetadata(
    productTypeId: string,
    shoppingMetadata: ProductTypeShoppingMetadataRequest,
  ): Observable<ProductType> {
    return this.http
      .patch<ApiProductType>(
        `${this.productTypesUrl}/${productTypeId}/shopping-metadata`,
        shoppingMetadata,
        { withCredentials: true },
      )
      .pipe(map((productType) => this.normalizeProductType(productType)));
  }

  archiveProductType(
    productTypeId: string,
    request: ArchivePantryItemRequest = {},
  ): Observable<ProductType> {
    return this.http
      .post<ApiProductType>(`${this.productTypesUrl}/${productTypeId}/archive`, request, {
        withCredentials: true,
      })
      .pipe(map((productType) => this.normalizeProductType(productType)));
  }

  restoreProductType(productTypeId: string): Observable<ProductType> {
    return this.http
      .post<ApiProductType>(`${this.productTypesUrl}/${productTypeId}/restore`, {}, {
        withCredentials: true,
      })
      .pipe(map((productType) => this.normalizeProductType(productType)));
  }

  deleteProductType(
    productTypeId: string,
    request: DeletePantryItemRequest,
  ): Observable<void> {
    return this.http.delete<void>(`${this.productTypesUrl}/${productTypeId}`, {
      body: request,
      withCredentials: true,
    });
  }

  createInventoryLot(request: CreateInventoryLotRequest): Observable<InventoryLot> {
    return this.http
      .post<ApiInventoryLot>(this.inventoryLotsUrl, request, {
        withCredentials: true,
      })
      .pipe(map((inventoryLot) => this.normalizeInventoryLot(inventoryLot)));
  }

  registerLot(request: RegisterLotRequest): Observable<InventoryLot> {
    if (request.selectionMode === 'existing') {
      if (!request.existingProductTypeId) {
        throw new Error('An existing product type must be selected');
      }

      const createLot = () =>
        this.createInventoryLot({
          productTypeId: request.existingProductTypeId!,
          variantName: request.variantName,
          quantity: request.quantity,
          unit: request.unit,
          expiresAt: request.expiresAt,
          purchaseDate: request.purchaseDate,
        });

      return request.defaultDepletionRule
        ? this.updateProductTypeDepletionRule(
            request.existingProductTypeId,
            request.defaultDepletionRule,
          ).pipe(switchMap(createLot))
        : createLot();
    }

    if (!request.newProductType) {
      throw new Error('A new product type payload is required');
    }

    return this.createProductType({
      baseName: request.newProductType.baseName,
      category: request.newProductType.category,
      defaultUnit: request.newProductType.defaultUnit,
      defaultDepletionRule: request.newProductType.defaultDepletionRule,
      shoppingMetadata: request.newProductType.shoppingMetadata,
    }).pipe(
      switchMap((productType) =>
        this.createInventoryLot({
          productTypeId: productType.id,
          variantName: request.variantName,
          quantity: request.quantity,
          unit: request.unit,
          expiresAt: request.expiresAt,
          purchaseDate: request.purchaseDate,
        }),
      ),
    );
  }

  consumeInventoryLot(
    lotId: string,
    request: ConsumeInventoryLotRequest,
    idempotencyKey: string,
  ): Observable<IdempotentMutationResult<InventoryLot | null>> {
    return this.http
      .post<ApiInventoryLot | null>(`${this.inventoryLotsUrl}/${lotId}/consume`, request, {
        headers: { 'Idempotency-Key': idempotencyKey },
        observe: 'response',
        withCredentials: true,
      })
      .pipe(
        map((response) => ({
          value: response.body
            ? this.normalizeInventoryLot(response.body)
            : null,
          idempotencyKey:
            response.headers.get('Idempotency-Key') ?? idempotencyKey,
          replayed:
            response.headers.get('Idempotency-Replayed')?.toLowerCase() ===
            'true',
        })),
      );
  }

  archiveInventoryLot(
    lotId: string,
    request: ArchivePantryItemRequest = {},
  ): Observable<InventoryLot> {
    return this.http
      .post<ApiInventoryLot>(`${this.inventoryLotsUrl}/${lotId}/archive`, request, {
        withCredentials: true,
      })
      .pipe(map((inventoryLot) => this.normalizeInventoryLot(inventoryLot)));
  }

  restoreInventoryLot(lotId: string): Observable<InventoryLot> {
    return this.http
      .post<ApiInventoryLot>(`${this.inventoryLotsUrl}/${lotId}/restore`, {}, {
        withCredentials: true,
      })
      .pipe(map((inventoryLot) => this.normalizeInventoryLot(inventoryLot)));
  }

  deleteInventoryLot(
    lotId: string,
    request: DeletePantryItemRequest,
  ): Observable<void> {
    return this.http.delete<void>(`${this.inventoryLotsUrl}/${lotId}`, {
      body: request,
      withCredentials: true,
    });
  }

  getArchivedPantryItems(
    query: ArchivedPantryQuery = {},
  ): Observable<ArchivedPantryItems> {
    return this.http.get<ApiArchivedPantryItems>(this.archivedPantryUrl, {
      params: this.toArchivedPantryParams(query),
      withCredentials: true,
    }).pipe(
      map((items) => ({
        productTypes: items.productTypes.map((productType) =>
          this.normalizeProductType(productType),
        ),
        inventoryLots: items.inventoryLots.map((inventoryLot) =>
          this.normalizeInventoryLot(inventoryLot),
        ),
        pagination: items.pagination,
      })),
    );
  }

  exportPantryData(): Observable<ApiPantryExport> {
    return this.http.get<ApiPantryExport>(this.pantryExportUrl, {
      withCredentials: true,
    });
  }

  closeShoppingPurchase(
    request: CloseShoppingPurchaseRequest,
    idempotencyKey: string,
  ): Observable<IdempotentMutationResult<InventoryLot[]>> {
    return this.http
      .post<ApiInventoryLot[]>(this.pantryCheckoutUrl, request, {
        headers: { 'Idempotency-Key': idempotencyKey },
        observe: 'response',
        withCredentials: true,
      })
      .pipe(
        map((response) => ({
          value: (response.body ?? []).map((inventoryLot) =>
            this.normalizeInventoryLot(inventoryLot),
          ),
          idempotencyKey:
            response.headers.get('Idempotency-Key') ?? idempotencyKey,
          replayed:
            response.headers.get('Idempotency-Replayed')?.toLowerCase() ===
            'true',
        })),
      );
  }

  listSavedShoppingLists(): Observable<SavedShoppingList[]> {
    return this.http
      .get<ApiSavedShoppingList[]>(this.pantryShoppingListsUrl, {
        withCredentials: true,
      })
      .pipe(
        map((lists) =>
          lists.map((list) => this.normalizeSavedShoppingList(list)),
        ),
      );
  }

  createSavedShoppingList(
    request: CreateSavedShoppingListRequest,
  ): Observable<SavedShoppingList> {
    return this.http
      .post<ApiSavedShoppingList>(this.pantryShoppingListsUrl, request, {
        withCredentials: true,
      })
      .pipe(map((list) => this.normalizeSavedShoppingList(list)));
  }

  deleteSavedShoppingList(listId: string): Observable<SavedShoppingList> {
    return this.http
      .delete<ApiSavedShoppingList>(
        `${this.pantryShoppingListsUrl}/${encodeURIComponent(listId)}`,
        { withCredentials: true },
      )
      .pipe(map((list) => this.normalizeSavedShoppingList(list)));
  }

  createShoppingShare(
    request: CreateShoppingShareRequest,
  ): Observable<ShoppingShare> {
    return this.http
      .post<ApiShoppingShare>(this.pantryShoppingSharesUrl, request, {
        withCredentials: true,
      })
      .pipe(map((share) => this.normalizeShoppingShare(share)));
  }

  listActiveShoppingShares(): Observable<ShoppingShare[]> {
    return this.http
      .get<ApiShoppingShare[]>(this.pantryShoppingSharesUrl, {
        withCredentials: true,
      })
      .pipe(
        map((shares) =>
          shares.map((share) => this.normalizeShoppingShare(share)),
        ),
      );
  }

  resolveShoppingShare(token: string): Observable<PublicShoppingShare> {
    return this.http
      .get<ApiPublicShoppingShare>(
        `${this.publicShoppingSharesUrl}/${encodeURIComponent(token)}`,
      )
      .pipe(map((share) => this.normalizePublicShoppingShare(share)));
  }

  revokeShoppingShare(token: string): Observable<ShoppingShare> {
    return this.http
      .delete<ApiShoppingShare>(
        `${this.pantryShoppingSharesUrl}/${encodeURIComponent(token)}`,
        {
          withCredentials: true,
        },
      )
      .pipe(map((share) => this.normalizeShoppingShare(share)));
  }

  revokeShoppingShareById(shareId: string): Observable<ShoppingShare> {
    return this.http
      .delete<ApiShoppingShare>(
        `${this.pantryShoppingSharesUrl}/by-id/${encodeURIComponent(shareId)}`,
        {
          withCredentials: true,
        },
      )
      .pipe(map((share) => this.normalizeShoppingShare(share)));
  }

  private normalizeProductType(productType: ApiProductType): ProductType {
    return {
      ...productType,
      defaultDepletionRule: productType.defaultDepletionRule
        ? this.normalizeDepletionRule(productType.defaultDepletionRule)
        : undefined,
      shoppingMetadata: productType.shoppingMetadata
        ? this.normalizeShoppingMetadata(productType.shoppingMetadata)
        : undefined,
      archivedAt: productType.archivedAt ? new Date(productType.archivedAt) : null,
      createdAt: new Date(productType.createdAt),
      updatedAt: new Date(productType.updatedAt),
    };
  }

  private toArchivedPantryParams(
    query: ArchivedPantryQuery,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
  }

  private normalizeInventoryLot(inventoryLot: ApiInventoryLot): InventoryLot {
    return {
      ...inventoryLot,
      expiresAt: inventoryLot.expiresAt ? new Date(inventoryLot.expiresAt) : null,
      purchaseDate: inventoryLot.purchaseDate
        ? new Date(inventoryLot.purchaseDate)
        : null,
      archivedAt: inventoryLot.archivedAt ? new Date(inventoryLot.archivedAt) : null,
      createdAt: new Date(inventoryLot.createdAt),
      updatedAt: new Date(inventoryLot.updatedAt),
    };
  }

  private normalizeShoppingShare(share: ApiShoppingShare): ShoppingShare {
    return {
      id: share.id,
      token: share.token,
      createdAt: new Date(share.createdAt),
      expiresAt: new Date(share.expiresAt),
      revokedAt: share.revokedAt ? new Date(share.revokedAt) : null,
    };
  }

  private normalizePublicShoppingShare(
    share: ApiPublicShoppingShare,
  ): PublicShoppingShare {
    return {
      text: share.text,
      createdAt: new Date(share.createdAt),
      expiresAt: new Date(share.expiresAt),
    };
  }

  private normalizeSavedShoppingList(
    list: ApiSavedShoppingList,
  ): SavedShoppingList {
    return {
      ...list,
      createdAt: new Date(list.createdAt),
      updatedAt: new Date(list.updatedAt),
    };
  }

  private normalizeWasteOverview(overview: ApiWasteOverview): WasteOverview {
    return {
      ...overview,
      generatedAt: new Date(overview.generatedAt),
      recentEvents: overview.recentEvents.map((event) => ({
        ...event,
        occurredAt: new Date(event.occurredAt),
      })),
    };
  }

  private normalizeLotSummary(lot: ApiPantryLotSummary): PantryLotSummary {
    return {
      ...lot,
      expiresAt: lot.expiresAt ? new Date(lot.expiresAt) : null,
      purchaseDate: lot.purchaseDate ? new Date(lot.purchaseDate) : null,
      updatedAt: new Date(lot.updatedAt),
    };
  }

  private normalizePantryOverview(overview: ApiPantryOverview): PantryOverview {
    return {
      userId: overview.userId,
      generatedAt: new Date(overview.generatedAt),
      preferences: overview.preferences,
      items: overview.items.map((item) => this.normalizePantryOverviewItem(item)),
      expiringItems: overview.expiringItems.map((item) => ({
        ...item,
        nextExpirationAt: item.nextExpirationAt
          ? new Date(item.nextExpirationAt)
          : null,
        lots: item.lots.map((lot) => this.normalizeLotSummary(lot)),
      })),
      depletingItems: overview.depletingItems.map((item) =>
        this.normalizeDepletingProductGroup(item),
      ),
      shoppingPlanItems: (overview.shoppingPlanItems ?? []).map((item) =>
        this.normalizeShoppingPlanItem(item),
      ),
      shoppingPlanEstimatedTotal: overview.shoppingPlanEstimatedTotal ?? 0,
      shoppingRouteGroups: (overview.shoppingRouteGroups ?? []).map((group) =>
        this.normalizeShoppingRouteGroup(group),
      ),
      priceReferenceItems: (overview.priceReferenceItems ?? []).map((item) =>
        this.normalizePriceReferenceItem(item),
      ),
      stapleItems: (overview.stapleItems ?? []).map((item) =>
        this.normalizeStapleItem(item),
      ),
      stapleCatalogGroups: (overview.stapleCatalogGroups ?? []).map((group) =>
        this.normalizeStapleCatalogGroup(group),
      ),
      valueInsights: overview.valueInsights ?? {
        stapleCount: 0,
        stapleAttentionCount: 0,
        estimatedShoppingTotal: overview.shoppingPlanEstimatedTotal ?? 0,
        estimatedExpiringValue: 0,
        estimatedWasteAtRisk: 0,
        estimatedStapleRestockTotal: 0,
        pricedShoppingItemCount: 0,
        unpricedShoppingItemCount: 0,
        promoOnlyShoppingItemCount: 0,
        estimatedPromoOnlyTotal: 0,
        duplicatePurchaseWarningCount: 0,
      },
    };
  }

  private normalizePantryOverviewItem(item: ApiPantryOverviewItem): PantryOverviewItem {
    return {
      ...item,
      nextExpirationAt: item.nextExpirationAt ? new Date(item.nextExpirationAt) : null,
      depletionRule: item.depletionRule
        ? this.normalizeDepletionRule(item.depletionRule)
        : undefined,
      estimatedDepletionAt: item.estimatedDepletionAt
        ? new Date(item.estimatedDepletionAt)
        : undefined,
      shoppingMetadata: item.shoppingMetadata
        ? this.normalizeShoppingMetadata(item.shoppingMetadata)
        : undefined,
      lots: item.lots.map((lot) => this.normalizeLotSummary(lot)),
    };
  }

  private normalizeDepletingProductGroup(
    item: ApiDepletingProductGroup,
  ): DepletingProductGroup {
    return {
      ...item,
      estimatedDepletionAt: new Date(item.estimatedDepletionAt),
      depletionRule: this.normalizeDepletionRule(item.depletionRule),
      shoppingMetadata: item.shoppingMetadata
        ? this.normalizeShoppingMetadata(item.shoppingMetadata)
        : undefined,
    };
  }

  private normalizeShoppingPlanItem(item: ApiShoppingPlanItem): ShoppingPlanItem {
    return {
      ...item,
      estimatedDepletionAt: new Date(item.estimatedDepletionAt),
      recommendedPurchaseAt: new Date(item.recommendedPurchaseAt),
      depletionRule: this.normalizeDepletionRule(item.depletionRule),
      shoppingMetadata: item.shoppingMetadata
        ? this.normalizeShoppingMetadata(item.shoppingMetadata)
        : undefined,
    };
  }

  private normalizeShoppingRouteGroup(
    group: ApiShoppingRouteGroup,
  ): ShoppingRouteGroup {
    return {
      ...group,
      nextRecommendedPurchaseAt: new Date(group.nextRecommendedPurchaseAt),
      categoryBreakdown: (group.categoryBreakdown ?? []).map((categoryGroup) =>
        this.normalizeShoppingRouteCategoryGroup(categoryGroup),
      ),
      items: group.items.map((item) => this.normalizeShoppingPlanItem(item)),
    };
  }

  private normalizeShoppingRouteCategoryGroup(
    group: ApiShoppingRouteCategoryGroup,
  ): ShoppingRouteCategoryGroup {
    return {
      ...group,
      items: group.items.map((item) => this.normalizeShoppingPlanItem(item)),
    };
  }

  private normalizePriceReferenceItem(
    item: ApiPriceReferenceItem,
  ): PriceReferenceItem {
    return {
      ...item,
      priceHistory: (item.priceHistory ?? []).map((entry) => ({
        ...entry,
        recordedAt: new Date(entry.recordedAt),
      })),
      updatedAt: new Date(item.updatedAt),
    };
  }

  private normalizeStapleItem(item: ApiPantryStapleItem): PantryStapleItem {
    return {
      ...item,
      shoppingMetadata: item.shoppingMetadata
        ? this.normalizeShoppingMetadata(item.shoppingMetadata)
        : undefined,
    };
  }

  private normalizeStapleCatalogGroup(
    group: ApiPantryStapleCatalogGroup,
  ): PantryStapleCatalogGroup {
    return {
      ...group,
      items: group.items.map((item) => this.normalizeStapleItem(item)),
    };
  }

  private normalizeDepletionRule(
    rule: ApiProductTypeDepletionRule,
  ): ProductTypeDepletionRule {
    return {
      ...rule,
      anchorDate: new Date(rule.anchorDate),
    };
  }

  private normalizeShoppingMetadata(
    metadata: Partial<ProductTypeShoppingMetadata>,
  ): ProductTypeShoppingMetadata {
    const normalized: ProductTypeShoppingMetadata = {
      ...metadata,
      householdStaple: metadata.householdStaple ?? false,
      buyOnlyOnPromo: metadata.buyOnlyOnPromo ?? false,
      replenishWhenLow: metadata.replenishWhenLow ?? true,
    };

    if (metadata.priceHistory) {
      normalized.priceHistory = metadata.priceHistory.map((entry) => ({
        ...entry,
        recordedAt: new Date(entry.recordedAt),
      }));
    }

    return normalized;
  }
}
