import { getUserErrorMessage, UserFacingError } from '../../shared/user-error';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  PLATFORM_ID,
  inject,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, Validators } from '@angular/forms';
import { Store } from '@ngrx/store';
import { BehaviorSubject, Observable, TimeoutError, of } from 'rxjs';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  filter,
  finalize,
  startWith,
  switchMap,
  take,
  timeout,
} from 'rxjs/operators';
import { AuthFacade } from '../../core/services/auth.facade';
import { PantryService } from '../../core/services/pantry.service';
import { AuthUser } from '../../shared/models/auth.model';
import {
  ArchivedPantryItems,
  CloseShoppingPurchaseItemRequest,
  DEPLETION_PERIODS,
  DepletionPeriod,
  ExpirationStatus,
  ExpiringProductGroup,
  InventoryLot,
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  SHOPPING_LOCATION_OPTIONS,
  STORAGE_LOCATION_OPTIONS,
  ProductCategory,
  ProductTypeEffectivePlanningSettings,
  PantryLotSummary,
  PantryOverviewItem,
  PantryStapleItem,
  PantryStapleStatus,
  PantryValueInsights,
  PriceReferenceItem,
  ProductTypeDepletionRuleRequest,
  ProductTypePlanningSettingsRequest,
  ProductTypeShoppingMetadata,
  ProductTypeShoppingMetadataRequest,
  ProductType,
  ProductTypeSelectionMode,
  ProductUnit,
  SavedShoppingList,
  SavedShoppingListItem,
  ShoppingShare,
  ShoppingPlanItem,
  ShoppingPlanUrgency,
  ShoppingRouteGroup,
  WasteOverview,
  WasteReason,
  WasteEventSummary,
} from '../../shared/models/pantry.model';
import * as PantryActions from '../../store/pantry/pantry.actions';
import {
  selectExpiringGroups,
  selectDepletingGroups,
  selectExpiredEntryAlert,
  selectPantryError,
  selectPantryGroupsSorted,
  selectPantryInitialLoading,
  selectPantryLoading,
  selectPantrySummary,
  selectPantryValueInsights,
  selectPriceReferenceItems,
  selectShowGuidanceTips,
  selectShoppingPlanItems,
  selectShoppingRouteGroups,
  selectStapleItems,
} from '../../store/pantry/pantry.selectors';

interface DeleteConfirmationTarget {
  kind: 'productType' | 'inventoryLot';
  id: string;
  expectedText: string;
}

interface ArchiveConfirmationTarget {
  kind: 'productType' | 'inventoryLot';
  id: string;
  label: string;
  message: string;
}

interface QuickCaptureItem {
  name: string;
  quantity: number;
  unit: string;
  shoppingLocation?: string;
  estimatedUnitPrice?: number;
  barcode?: string;
}

interface QuickCaptureDraft {
  id: string;
  createdAt: Date;
  rawText: string;
  items: QuickCaptureItem[];
}

interface ShoppingTripDraftItem {
  productTypeId: string;
  checked: boolean;
  quantity: number;
  unit: ProductUnit;
  paidUnitPrice?: number;
  shoppingLocation?: string;
}

interface ShoppingTripSourceItem {
  productTypeId: string;
  baseName: string;
  category?: ProductCategory;
  defaultUnit: ProductUnit;
  suggestedPurchaseQuantity: number;
  estimatedUnitPrice?: number;
  estimatedLineTotal?: number;
  urgency?: ShoppingPlanUrgency;
  shoppingMetadata?: ProductTypeShoppingMetadata;
}

interface SavedShoppingListSnapshotPayload {
  title: string;
  occasion?: string;
  shoppingLocation?: string;
  items: SavedShoppingListItem[];
}

interface PendingShoppingCheckout {
  id: string;
  idempotencyKey: string;
  ownerUserId: string;
  createdAt: Date;
  items: CloseShoppingPurchaseItemRequest[];
  queuedOffline?: boolean;
}

interface PendingInventoryMutation {
  actionId: string;
  payloadFingerprint: string;
  idempotencyKey: string;
  createdAt: Date;
}

interface UserScopedLocalStateEnvelope {
  version: 1;
  ownerUserId: string;
  payload: string;
}

interface ScreenWakeLock {
  release: () => Promise<void>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
    };
  }>;
}

interface BarcodeDetectionResultLike {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<BarcodeDetectionResultLike[]>;
}

interface BarcodeDetectorConstructorLike {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

interface StapleTemplate {
  label: string;
  baseName: string;
  category: ProductCategory;
  unit: ProductUnit;
  storageLocation: string;
  shoppingLocation: string;
  householdStaple: boolean;
  buyOnlyOnPromo: boolean;
  replenishWhenLow: boolean;
  enableDurability: boolean;
  depletionConsumeAmount: number;
  depletionEveryAmount: number;
  depletionEveryPeriod: DepletionPeriod;
  suggestedShelfLifeDays?: number;
}

interface UseFirstItem {
  productTypeId: string;
  baseName: string;
  category: ProductCategory;
  lot: PantryLotSummary;
  priority: number;
  reason: string;
  estimatedLoss?: number;
}

type PantryTimelineItemKind = 'purchase' | 'waste' | 'price';

interface PantryTimelineItem {
  id: string;
  kind: PantryTimelineItemKind;
  title: string;
  detail: string;
  happenedAt: Date;
  amount?: number;
}

const STAPLE_TEMPLATES: StapleTemplate[] = [
  {
    label: 'Despensa diaria',
    baseName: 'Arroz',
    category: 'food',
    unit: 'kg',
    storageLocation: 'Despensa',
    shoppingLocation: 'Mercado',
    householdStaple: true,
    buyOnlyOnPromo: false,
    replenishWhenLow: true,
    enableDurability: true,
    depletionConsumeAmount: 1,
    depletionEveryAmount: 1,
    depletionEveryPeriod: 'month',
  },
  {
    label: 'Limpieza',
    baseName: 'Detergente liquido',
    category: 'cleaning',
    unit: 'lt',
    storageLocation: 'Limpieza',
    shoppingLocation: 'Limpieza',
    householdStaple: true,
    buyOnlyOnPromo: true,
    replenishWhenLow: true,
    enableDurability: true,
    depletionConsumeAmount: 1,
    depletionEveryAmount: 1,
    depletionEveryPeriod: 'month',
  },
  {
    label: 'Botiquin',
    baseName: 'Paracetamol',
    category: 'hygiene',
    unit: 'piezas',
    storageLocation: 'Botiquin',
    shoppingLocation: 'Farmacia',
    householdStaple: true,
    buyOnlyOnPromo: false,
    replenishWhenLow: false,
    enableDurability: false,
    depletionConsumeAmount: 1,
    depletionEveryAmount: 1,
    depletionEveryPeriod: 'month',
  },
  {
    label: 'Mascotas',
    baseName: 'Croquetas',
    category: 'other',
    unit: 'kg',
    storageLocation: 'Mascotas',
    shoppingLocation: 'Mayoreo',
    householdStaple: true,
    buyOnlyOnPromo: true,
    replenishWhenLow: true,
    enableDurability: true,
    depletionConsumeAmount: 2,
    depletionEveryAmount: 1,
    depletionEveryPeriod: 'month',
  },
  {
    label: 'Sobras preparadas',
    baseName: 'Sobras de comida',
    category: 'food',
    unit: 'piezas',
    storageLocation: 'Sobras',
    shoppingLocation: 'Otro',
    householdStaple: false,
    buyOnlyOnPromo: false,
    replenishWhenLow: false,
    enableDurability: false,
    depletionConsumeAmount: 1,
    depletionEveryAmount: 1,
    depletionEveryPeriod: 'week',
    suggestedShelfLifeDays: 3,
  },
];
const SHOPPING_LOCATION_ORDER = [
  'Supermercado',
  'Mercado',
  'Tiendita',
  'Abarrotes',
  'Mayoreo',
  'Farmacia',
  'Limpieza',
  'Bodega',
  'Otro',
  'Sin tienda definida',
];
const ARCHIVED_PAGE_SIZE = 50;
const SHOPPING_CHECKOUT_MAX_ITEMS = 49;
const IDEMPOTENCY_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-pantry-page',
  templateUrl: './pantry-page.component.html',
  styleUrl: './pantry-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class PantryPageComponent implements OnInit {
  private readonly formBuilder = inject(FormBuilder);
  private readonly authFacade = inject(AuthFacade);
  private readonly pantryService = inject(PantryService);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly lotRegistrationTimeoutMs = 15000;
  private readonly shoppingBudgetStorageKey = 'despensalista.shoppingBudget';
  private readonly archivedPageSize = ARCHIVED_PAGE_SIZE;
  private readonly quickCaptureStorageKey = 'despensalista.quickCaptureDrafts';
  private readonly shoppingTripStorageKey = 'despensalista.shoppingTripDraft';
  private readonly pendingShoppingCheckoutStorageKey =
    'despensalista.pendingShoppingCheckouts';
  private readonly pendingInventoryMutationStorageKey =
    'despensalista.pendingInventoryMutations';
  private readonly savedShoppingListsStorageKey =
    'despensalista.savedShoppingLists';
  private localStateOwnerUserId: string | null = null;

  readonly username$ = this.authFacade.currentUsername$;
  readonly loading$ = this.store.select(selectPantryLoading);
  readonly initialLoading$ = this.store.select(selectPantryInitialLoading);
  readonly error$ = this.store.select(selectPantryError);
  readonly summary$ = this.store.select(selectPantrySummary);
  readonly expiringGroups$ = this.store.select(selectExpiringGroups);
  readonly expiredAlert$ = this.store.select(selectExpiredEntryAlert);
  readonly depletingGroups$ = this.store.select(selectDepletingGroups);
  readonly shoppingPlanItems$ = this.store.select(selectShoppingPlanItems);
  readonly shoppingRouteGroups$ = this.store.select(selectShoppingRouteGroups);
  readonly priceReferenceItems$ = this.store.select(selectPriceReferenceItems);
  readonly stapleItems$ = this.store.select(selectStapleItems);
  readonly valueInsights$ = this.store.select(selectPantryValueInsights);
  readonly pantryGroups$ = this.store.select(selectPantryGroupsSorted);
  readonly showGuidanceTips$ = this.store.select(selectShowGuidanceTips);

  readonly searchingTypeSuggestions$ = new BehaviorSubject(false);
  readonly selectionModeOptions: ProductTypeSelectionMode[] = [
    'existing',
    'new',
  ];
  readonly categoryOptions = PRODUCT_CATEGORIES;
  readonly unitOptions = PRODUCT_UNITS;
  readonly storageLocationOptions = STORAGE_LOCATION_OPTIONS;
  readonly shoppingLocationOptions = SHOPPING_LOCATION_OPTIONS;
  readonly stapleTemplates = STAPLE_TEMPLATES;
  readonly depletionPeriodOptions = DEPLETION_PERIODS;

  readonly categoryLabels: Record<ProductCategory, string> = {
    food: 'Comida',
    cleaning: 'Limpieza',
    hygiene: 'Higiene',
    other: 'Otros',
  };

  readonly expirationLabels: Record<ExpirationStatus, string> = {
    expired: 'Ya caducó',
    critical: 'Crítico',
    soon: 'Próximo',
    stable: 'Estable',
    none: 'Sin caducidad',
  };

  readonly depletionPeriodLabels: Record<DepletionPeriod, string> = {
    day: 'dias',
    week: 'semanas',
    month: 'meses',
  };

  readonly shoppingPlanUrgencyLabels: Record<ShoppingPlanUrgency, string> = {
    depleted: 'Comprar ya',
    critical: 'Comprar esta semana',
    upcoming: 'Comprar pronto',
  };
  readonly stapleStatusLabels: Record<PantryStapleStatus, string> = {
    missing: 'Falta en casa',
    low: 'Revisar pronto',
    available: 'Cubierto',
  };
  readonly wasteReasonOptions: WasteReason[] = [
    'expired',
    'spoiled',
    'not_used',
    'overbought',
    'other',
  ];
  readonly wasteReasonLabels: Record<WasteReason, string> = {
    expired: 'Caducado',
    spoiled: 'Se echó a perder',
    not_used: 'No se usó',
    overbought: 'Compra de más',
    other: 'Otro',
  };

  readonly lotForm = this.formBuilder.nonNullable.group({
    selectionMode: [
      'existing' as ProductTypeSelectionMode,
      Validators.required,
    ],
    existingTypeSearch: [''],
    existingProductTypeId: [''],
    newBaseName: ['', [Validators.maxLength(80)]],
    category: ['food' as ProductCategory, Validators.required],
    unit: ['piezas' as ProductUnit, Validators.required],
    storageLocation: ['', [Validators.maxLength(80)]],
    shoppingLocation: ['', [Validators.maxLength(80)]],
    preferredBrand: ['', [Validators.maxLength(80)]],
    substituteBrand: ['', [Validators.maxLength(80)]],
    householdStaple: [false],
    buyOnlyOnPromo: [false],
    replenishWhenLow: [true],
    shoppingNotes: ['', [Validators.maxLength(160)]],
    estimatedUnitPrice: [
      null as number | null,
      [Validators.min(0.01), Validators.max(1000000)],
    ],
    variantName: ['', [Validators.maxLength(80)]],
    quantity: [1, [Validators.required, Validators.min(0.1)]],
    expiresAt: [''],
    purchaseDate: [''],
    enableDurability: [false],
    depletionConsumeAmount: [1, [Validators.required, Validators.min(0.01)]],
    depletionEveryAmount: [1, [Validators.required, Validators.min(1)]],
    depletionEveryPeriod: ['month' as DepletionPeriod, Validators.required],
    depletionAnchorDate: [toDateInputValue(new Date(), true), Validators.required],
  });

  readonly depletionRuleForm = this.formBuilder.nonNullable.group({
    enabled: [true],
    consumeAmount: [1, [Validators.required, Validators.min(0.01)]],
    everyAmount: [1, [Validators.required, Validators.min(1)]],
    everyPeriod: ['month' as DepletionPeriod, Validators.required],
    anchorDate: [toDateInputValue(new Date(), true), Validators.required],
  });

  readonly planningSettingsForm = this.formBuilder.group({
    planningEnabled: [true],
    expirationWarningDaysOverride: [
      null as number | null,
      [Validators.min(1), Validators.max(60)],
    ],
    depletionWarningThresholdRatioOverride: [
      null as number | null,
      [Validators.min(0.25), Validators.max(4)],
    ],
    shoppingPlanLeadDaysOverride: [
      null as number | null,
      [Validators.min(0), Validators.max(30)],
    ],
  });

  readonly shoppingMetadataForm = this.formBuilder.nonNullable.group({
    storageLocation: ['', [Validators.maxLength(80)]],
    shoppingLocation: ['', [Validators.maxLength(80)]],
    preferredBrand: ['', [Validators.maxLength(80)]],
    substituteBrand: ['', [Validators.maxLength(80)]],
    householdStaple: [false],
    buyOnlyOnPromo: [false],
    replenishWhenLow: [true],
    shoppingNotes: ['', [Validators.maxLength(160)]],
    estimatedUnitPrice: [
      null as number | null,
      [Validators.min(0.01), Validators.max(1000000)],
    ],
  });

  readonly shoppingBudgetForm = this.formBuilder.group({
    amount: [null as number | null, [Validators.min(0)]],
  });

  readonly quickCaptureForm = this.formBuilder.nonNullable.group({
    rawText: [''],
  });

  readonly savedShoppingListForm = this.formBuilder.nonNullable.group({
    title: ['', [Validators.maxLength(80)]],
    occasion: ['', [Validators.maxLength(80)]],
    shoppingLocation: ['', [Validators.maxLength(80)]],
  });

  readonly existingTypeSuggestions$ =
    this.lotForm.controls.selectionMode.valueChanges.pipe(
      startWith(this.lotForm.controls.selectionMode.getRawValue()),
      switchMap((selectionMode) => {
        if (selectionMode !== 'existing') {
          this.searchingTypeSuggestions$.next(false);
          return of([] as ProductType[]);
        }

        return this.lotForm.controls.existingTypeSearch.valueChanges.pipe(
          startWith(this.lotForm.controls.existingTypeSearch.getRawValue()),
          debounceTime(250),
          distinctUntilChanged(),
          switchMap((search) => {
            this.searchingTypeSuggestions$.next(true);

            return this.pantryService.searchProductTypes(search.trim()).pipe(
              finalize(() => this.searchingTypeSuggestions$.next(false)),
              catchError(() => {
                this.searchingTypeSuggestions$.next(false);
                return of([] as ProductType[]);
              })
            );
          })
        );
      })
    );

  selectedExistingType: ProductType | null = null;
  registerError: string | null = null;
  submittingLot = false;
  consumeBusyLotId: string | null = null;
  editingDepletionProductTypeId: string | null = null;
  depletionRuleSavingProductTypeId: string | null = null;
  depletionRuleError: string | null = null;
  expiredAlertDismissed = false;
  guidanceDismissed = false;
  archivedPanelOpen = false;
  archivedLoading = false;
  archivedError: string | null = null;
  archivedItems: ArchivedPantryItems | null = null;
  mutationBusyKey: string | null = null;
  archiveConfirmationTarget: ArchiveConfirmationTarget | null = null;
  deleteConfirmationTarget: DeleteConfirmationTarget | null = null;
  deleteConfirmationInput = '';
  deleteConfirmationError: string | null = null;
  editingPlanningProductTypeId: string | null = null;
  planningSettingsSavingProductTypeId: string | null = null;
  planningSettingsError: string | null = null;
  editingShoppingMetadataProductTypeId: string | null = null;
  shoppingMetadataSavingProductTypeId: string | null = null;
  shoppingMetadataError: string | null = null;
  shoppingExportStatus: string | null = null;
  shoppingExportText: string | null = null;
  shoppingShareStatus: string | null = null;
  shoppingShareId: string | null = null;
  shoppingShareLink: string | null = null;
  shoppingShareToken: string | null = null;
  shoppingShareExpiresAt: Date | null = null;
  shoppingShareBusy = false;
  activeShoppingShares: ShoppingShare[] = [];
  activeShoppingSharesLoading = false;
  activeShoppingSharesError: string | null = null;
  shoppingBudget: number | null = null;
  shoppingModeActive = false;
  shoppingModeSourceList: SavedShoppingList | null = null;
  shoppingTripDraft: Record<string, ShoppingTripDraftItem> = {};
  shoppingCheckoutStatus: string | null = null;
  shoppingCheckoutBusy = false;
  stapleToggleBusyProductTypeId: string | null = null;
  privacyExportStatus: string | null = null;
  privacyExportBusy = false;
  quickCaptureDrafts: QuickCaptureDraft[] = [];
  quickCaptureStatus: string | null = null;
  quickCapturePhotoName: string | null = null;
  quickCapturePhotoPreviewUrl: string | null = null;
  quickCapturePhotoStatus: string | null = null;
  quickCaptureDetectedBarcode: string | null = null;
  barcodeCaptureSupported = false;
  savedShoppingLists: SavedShoppingList[] = [];
  savedShoppingListStatus: string | null = null;
  wasteOverview: WasteOverview | null = null;
  wasteOverviewLoading = false;
  wasteOverviewError: string | null = null;
  voiceCaptureSupported = false;
  voiceCaptureListening = false;
  voiceCaptureStatus: string | null = null;
  pendingShoppingCheckoutCount = 0;
  readonly shoppingCheckoutMaxItems = SHOPPING_CHECKOUT_MAX_ITEMS;
  isOffline = false;
  readonly consumeErrors: Record<string, string> = {};
  readonly consumeNotices: Record<string, string> = {};
  private readonly expandedProductTypeIds = new Set<string>();
  private shoppingWakeLock: ScreenWakeLock | null = null;
  private pendingShoppingCheckoutSyncing = false;
  private speechRecognition: SpeechRecognitionLike | null = null;

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.loadOverview();
      this.loadWasteOverview();
      this.watchNetworkState();
      this.authFacade.currentUser$
        .pipe(
          filter((user): user is AuthUser => user !== null),
          take(1),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe((user) => {
          this.localStateOwnerUserId = user.id;
          this.loadLocalShoppingSupport();
          this.loadSavedShoppingLists();
        });
      this.setupVoiceCapture();
      this.setupBarcodeCapture();
      this.loadActiveShoppingShares();
      this.destroyRef.onDestroy(() => {
        this.revokeQuickCapturePhotoPreview();
        void this.releaseShoppingWakeLock();
      });
    }

    this.lotForm.controls.existingTypeSearch.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.selectedExistingType) {
          this.selectedExistingType = null;
          this.lotForm.patchValue(
            {
              existingProductTypeId: '',
            },
            { emitEvent: false }
          );
        }
      });

    this.lotForm.controls.selectionMode.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((selectionMode) => {
        this.registerError = null;

        if (selectionMode === 'new') {
          this.selectedExistingType = null;
          this.lotForm.patchValue(
            {
              existingTypeSearch: '',
              existingProductTypeId: '',
              unit: 'piezas',
              enableDurability: false,
              depletionConsumeAmount: 1,
              depletionEveryAmount: 1,
              depletionEveryPeriod: 'month',
              depletionAnchorDate: toDateInputValue(new Date(), true),
            },
            { emitEvent: false }
          );
        }
      });
  }

  setSelectionMode(selectionMode: ProductTypeSelectionMode): void {
    this.lotForm.controls.selectionMode.setValue(selectionMode);
  }

  applyStapleTemplate(template: StapleTemplate): void {
    this.setSelectionMode('new');
    const now = new Date();
    const suggestedExpirationDate =
      template.suggestedShelfLifeDays === undefined
        ? ''
        : toDateInputValue(
            new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate() + template.suggestedShelfLifeDays,
            ),
            true,
          );
    this.lotForm.patchValue(
      {
        newBaseName: template.baseName,
        category: template.category,
        unit: template.unit,
        storageLocation: template.storageLocation,
        shoppingLocation: template.shoppingLocation,
        householdStaple: template.householdStaple,
        buyOnlyOnPromo: template.buyOnlyOnPromo,
        replenishWhenLow: template.replenishWhenLow,
        enableDurability: template.enableDurability,
        depletionConsumeAmount: template.depletionConsumeAmount,
        depletionEveryAmount: template.depletionEveryAmount,
        depletionEveryPeriod: template.depletionEveryPeriod,
        depletionAnchorDate: toDateInputValue(now, true),
        expiresAt: suggestedExpirationDate,
        purchaseDate: template.suggestedShelfLifeDays === undefined
          ? ''
          : toDateInputValue(now, true),
      },
      { emitEvent: false },
    );
    this.registerError = null;
  }

  selectExistingProductType(productType: ProductType): void {
    this.selectedExistingType = productType;
    this.lotForm.patchValue(
      {
        existingTypeSearch: productType.baseName,
        existingProductTypeId: productType.id,
        unit: productType.defaultUnit,
      },
      { emitEvent: false }
    );
    this.patchDepletionRuleControls(productType);
    this.registerError = null;
  }

  isGroupExpanded(productTypeId: string): boolean {
    return this.expandedProductTypeIds.has(productTypeId);
  }

  toggleGroup(productTypeId: string): void {
    if (this.expandedProductTypeIds.has(productTypeId)) {
      this.expandedProductTypeIds.delete(productTypeId);
      return;
    }

    this.expandedProductTypeIds.add(productTypeId);
  }

  getLotUnitPreview(): string {
    if (this.lotForm.controls.selectionMode.value === 'existing') {
      return (
        this.selectedExistingType?.defaultUnit ?? 'Selecciona un tipo base'
      );
    }

    return this.lotForm.controls.unit.value;
  }

  startEditingDepletionRule(group: PantryOverviewItem): void {
    const rule = group.depletionRule;
    this.editingDepletionProductTypeId = group.productTypeId;
    this.depletionRuleError = null;
    this.depletionRuleForm.reset({
      enabled: rule?.enabled ?? true,
      consumeAmount: rule?.consumeAmount ?? 1,
      everyAmount: rule?.everyAmount ?? 1,
      everyPeriod: rule?.everyPeriod ?? 'month',
      anchorDate: rule?.anchorDate
        ? toDateInputValue(rule.anchorDate)
        : toDateInputValue(new Date(), true),
    });
  }

  cancelEditingDepletionRule(): void {
    this.editingDepletionProductTypeId = null;
    this.depletionRuleError = null;
  }

  startEditingPlanningSettings(group: PantryOverviewItem): void {
    const settings = group.effectivePlanningSettings;
    this.editingPlanningProductTypeId = group.productTypeId;
    this.planningSettingsError = null;
    this.planningSettingsForm.reset({
      planningEnabled: settings.planningEnabled,
      expirationWarningDaysOverride:
        settings.expirationWarningDaysSource === 'productType'
          ? settings.expirationWarningDays
          : null,
      depletionWarningThresholdRatioOverride:
        settings.depletionWarningThresholdRatioSource === 'productType'
          ? settings.depletionWarningThresholdRatio
          : null,
      shoppingPlanLeadDaysOverride:
        settings.shoppingPlanLeadDaysSource === 'productType'
          ? settings.shoppingPlanLeadDays
          : null,
    });
  }

  cancelEditingPlanningSettings(): void {
    this.editingPlanningProductTypeId = null;
    this.planningSettingsError = null;
  }

  savePlanningSettings(group: PantryOverviewItem): void {
    if (this.planningSettingsForm.invalid) {
      this.planningSettingsForm.markAllAsTouched();
      this.planningSettingsError =
        'Revisa los rangos antes de guardar estas reglas.';
      return;
    }

    this.planningSettingsSavingProductTypeId = group.productTypeId;
    this.planningSettingsError = null;

    this.pantryService
      .updateProductTypePlanningSettings(
        group.productTypeId,
        this.buildPlanningSettingsRequest()
      )
      .pipe(
        finalize(() => {
          this.planningSettingsSavingProductTypeId = null;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          this.editingPlanningProductTypeId = null;
          this.loadOverview();
        },
        error: (error) => {
          this.planningSettingsError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  startEditingShoppingMetadata(group: PantryOverviewItem): void {
    const metadata = this.resolveShoppingMetadata(group.shoppingMetadata);
    this.editingShoppingMetadataProductTypeId = group.productTypeId;
    this.shoppingMetadataError = null;
    this.shoppingMetadataForm.reset({
      storageLocation: metadata.storageLocation ?? '',
      shoppingLocation: metadata.shoppingLocation ?? '',
      preferredBrand: metadata.preferredBrand ?? '',
      substituteBrand: metadata.substituteBrand ?? '',
      householdStaple: metadata.householdStaple,
      buyOnlyOnPromo: metadata.buyOnlyOnPromo,
      replenishWhenLow: metadata.replenishWhenLow,
      shoppingNotes: metadata.shoppingNotes ?? '',
      estimatedUnitPrice: metadata.estimatedUnitPrice ?? null,
    });
  }

  cancelEditingShoppingMetadata(): void {
    this.editingShoppingMetadataProductTypeId = null;
    this.shoppingMetadataError = null;
  }

  saveShoppingMetadata(group: PantryOverviewItem): void {
    if (this.shoppingMetadataForm.invalid) {
      this.shoppingMetadataForm.markAllAsTouched();
      this.shoppingMetadataError =
        'Revisa los datos de compra antes de guardar.';
      return;
    }

    this.shoppingMetadataSavingProductTypeId = group.productTypeId;
    this.shoppingMetadataError = null;

    this.pantryService
      .updateProductTypeShoppingMetadata(
        group.productTypeId,
        this.buildShoppingMetadataRequest(
          this.shoppingMetadataForm.getRawValue()
        )
      )
      .pipe(
        finalize(() => {
          this.shoppingMetadataSavingProductTypeId = null;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          this.editingShoppingMetadataProductTypeId = null;
          this.loadOverview();
        },
        error: (error) => {
          this.shoppingMetadataError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  saveDepletionRule(group: PantryOverviewItem): void {
    const rule = this.buildEditedDepletionRule(group.defaultUnit);

    if (!rule) {
      return;
    }

    this.depletionRuleSavingProductTypeId = group.productTypeId;
    this.depletionRuleError = null;

    this.pantryService
      .updateProductTypeDepletionRule(group.productTypeId, rule)
      .pipe(
        finalize(() => {
          this.depletionRuleSavingProductTypeId = null;
        })
      )
      .subscribe({
        next: () => {
          this.editingDepletionProductTypeId = null;
          this.loadOverview();
        },
        error: (error) => {
          this.depletionRuleError = this.getErrorMessage(error);
        },
      });
  }

  submitLot(): void {
    if (this.lotForm.invalid) {
      this.lotForm.markAllAsTouched();
      return;
    }

    const rawValue = this.lotForm.getRawValue();
    const quantity = Number(rawValue.quantity);
    const selectionMode = rawValue.selectionMode;

    if (selectionMode === 'existing' && !this.selectedExistingType) {
      this.registerError =
        'Selecciona un tipo base existente antes de registrar el lote.';
      return;
    }

    if (selectionMode === 'new' && !rawValue.newBaseName.trim()) {
      this.registerError = 'Define el tipo base que quieres crear.';
      return;
    }

    this.registerError = null;
    const lotUnit =
      selectionMode === 'existing'
        ? this.selectedExistingType?.defaultUnit ?? rawValue.unit
        : rawValue.unit;
    const defaultDepletionRule = this.buildDefaultDepletionRule(
      rawValue,
      lotUnit
    );

    if (rawValue.enableDurability && !defaultDepletionRule) {
      return;
    }

    this.submittingLot = true;
    this.pantryService
      .registerLot({
        selectionMode,
        existingProductTypeId:
          selectionMode === 'existing'
            ? this.selectedExistingType?.id
            : undefined,
        newProductType:
          selectionMode === 'new'
            ? {
                baseName: rawValue.newBaseName.trim(),
                category: rawValue.category,
                defaultUnit: rawValue.unit,
                defaultDepletionRule,
                shoppingMetadata: this.buildShoppingMetadataRequest(rawValue),
              }
            : undefined,
        defaultDepletionRule:
          selectionMode === 'existing' ? defaultDepletionRule : undefined,
        variantName: rawValue.variantName.trim() || undefined,
        quantity,
        unit: lotUnit,
        expiresAt: rawValue.expiresAt || undefined,
        purchaseDate: rawValue.purchaseDate || undefined,
      })
      .pipe(
        timeout({ first: this.lotRegistrationTimeoutMs }),
        finalize(() => {
          this.submittingLot = false;
        })
      )
      .subscribe({
        next: () => {
          this.resetLotForm();
          this.loadOverview();
        },
        error: (error) => {
          this.registerError = this.getErrorMessage(error);
        },
      });
  }

  consumeLot(
    lotId: string,
    quantity: number,
    wasteReason?: string,
    wasteNote?: string,
  ): void {
    if (this.consumeBusyLotId) {
      return;
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      this.consumeErrors[lotId] = 'Ingresa una cantidad valida para consumir.';
      return;
    }

    delete this.consumeErrors[lotId];
    delete this.consumeNotices[lotId];
    this.consumeBusyLotId = lotId;
    const request = {
      quantity: Number(quantity.toFixed(2)),
      ...(this.toWasteReason(wasteReason)
        ? { wasteReason: this.toWasteReason(wasteReason) }
        : {}),
      ...(this.toOptionalText(wasteNote)
        ? { wasteNote: this.toOptionalText(wasteNote) }
        : {}),
    };

    const actionId = `consume:${lotId}`;
    const payloadFingerprint = JSON.stringify(request);
    let idempotencyKey: string;
    try {
      idempotencyKey = this.getOrCreateInventoryMutationKey(actionId, payloadFingerprint);
    } catch (error) {
      this.consumeBusyLotId = null;
      this.consumeErrors[lotId] = this.getErrorMessage(error);
      this.loadOverview();
      return;
    }

    this.pantryService
      .consumeInventoryLot(lotId, request, idempotencyKey)
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.consumeBusyLotId = null;
        })
      )
      .subscribe({
        next: (result) => {
          this.completeInventoryMutation(actionId, idempotencyKey);
          if (result.replayed) {
            this.consumeNotices[lotId] =
              'Esta acción ya se había completado; actualizamos la despensa sin duplicarla.';
          }
          this.loadOverview();
          if (wasteReason) {
            this.loadWasteOverview();
          }
        },
        error: (error) => {
          if (this.isMutationConflict(error)) {
            this.completeInventoryMutation(actionId, idempotencyKey);
            this.consumeErrors[lotId] =
              'La despensa cambió mientras realizabas esta acción. Ya actualizamos los datos; revísalos y vuelve a intentarlo.';
            this.loadOverview();
            return;
          }

          this.consumeErrors[lotId] = this.getErrorMessage(error);
        },
      });
  }

  dismissExpiredAlert(): void {
    this.expiredAlertDismissed = true;
  }

  dismissGuidance(): void {
    this.guidanceDismissed = true;
  }

  toggleArchivedPanel(): void {
    this.archivedPanelOpen = !this.archivedPanelOpen;

    if (this.archivedPanelOpen && !this.archivedItems) {
      this.loadArchivedItems();
    }
  }

  loadArchivedItems(): void {
    this.archivedLoading = true;
    this.archivedError = null;

    this.pantryService
      .getArchivedPantryItems({
        limit: this.archivedPageSize,
      })
      .pipe(
        finalize(() => {
          this.archivedLoading = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (archivedItems) => {
          this.archivedItems = archivedItems;
        },
        error: (error) => {
          this.archivedError = this.getErrorMessage(error);
        },
      });
  }

  loadMoreArchivedItems(): void {
    const pagination = this.archivedItems?.pagination;

    if (!pagination || !this.canLoadMoreArchivedItems()) {
      return;
    }

    this.archivedLoading = true;
    this.archivedError = null;

    this.pantryService
      .getArchivedPantryItems({
        limit: this.archivedPageSize,
        productTypesCursor: pagination.productTypesNextCursor,
        inventoryLotsCursor: pagination.inventoryLotsNextCursor,
        includeProductTypes: pagination.hasMoreProductTypes,
        includeInventoryLots: pagination.hasMoreInventoryLots,
      })
      .pipe(
        finalize(() => {
          this.archivedLoading = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (archivedItems) => {
          this.archivedItems = this.mergeArchivedItems(
            this.archivedItems,
            archivedItems,
          );
        },
        error: (error) => {
          this.archivedError = this.getErrorMessage(error);
        },
      });
  }

  loadWasteOverview(): void {
    this.wasteOverviewLoading = true;
    this.wasteOverviewError = null;

    this.pantryService
      .getWasteOverview()
      .pipe(
        finalize(() => {
          this.wasteOverviewLoading = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (overview) => {
          this.wasteOverview = overview;
        },
        error: (error) => {
          this.wasteOverviewError = this.getErrorMessage(error);
        },
      });
  }

  canLoadMoreArchivedItems(): boolean {
    return Boolean(
      this.archivedItems?.pagination?.hasMoreProductTypes ||
        this.archivedItems?.pagination?.hasMoreInventoryLots,
    );
  }

  archiveProductType(group: PantryOverviewItem): void {
    this.startArchiveConfirmation({
      kind: 'productType',
      id: group.productTypeId,
      label: group.baseName,
      message:
        'Se quitara de la despensa activa, busquedas y compras sugeridas. Sus lotes activos tambien dejaran de contarse.',
    });
  }

  archiveLot(lot: PantryLotSummary): void {
    const lotName = this.getLotDisplayName(lot);

    this.startArchiveConfirmation({
      kind: 'inventoryLot',
      id: lot.lotId,
      label: lotName,
      message: 'Se quitara del inventario activo y de los calculos.',
    });
  }

  cancelArchiveConfirmation(): void {
    this.clearArchiveConfirmation();
  }

  isArchiveConfirmationOpen(
    kind: ArchiveConfirmationTarget['kind'],
    id: string
  ): boolean {
    return (
      this.archiveConfirmationTarget?.kind === kind &&
      this.archiveConfirmationTarget.id === id
    );
  }

  confirmArchiveConfirmation(): void {
    const target = this.archiveConfirmationTarget;

    if (!target) {
      return;
    }

    const request =
      target.kind === 'productType'
        ? this.pantryService.archiveProductType(target.id, {
            reason: 'Archivado desde la despensa',
          })
        : this.pantryService.archiveInventoryLot(target.id, {
            reason: 'Archivado desde la despensa',
          });
    const busyKey =
      target.kind === 'productType'
        ? `archive-type-${target.id}`
        : `archive-lot-${target.id}`;

    this.clearArchiveConfirmation();

    this.runMutation(busyKey, request, { refreshArchived: true });
  }

  restoreProductType(productType: ProductType): void {
    this.runMutation(
      `restore-type-${productType.id}`,
      this.pantryService.restoreProductType(productType.id),
      { refreshArchived: true }
    );
  }

  restoreInventoryLot(lot: InventoryLot): void {
    this.runMutation(
      `restore-lot-${lot.id}`,
      this.pantryService.restoreInventoryLot(lot.id),
      { refreshArchived: true }
    );
  }

  deleteArchivedProductType(productType: ProductType): void {
    this.startDeleteConfirmation({
      kind: 'productType',
      id: productType.id,
      expectedText: productType.baseName,
    });
  }

  deleteArchivedInventoryLot(lot: InventoryLot): void {
    this.startDeleteConfirmation({
      kind: 'inventoryLot',
      id: lot.id,
      expectedText: this.getInventoryLotDisplayName(lot),
    });
  }

  updateDeleteConfirmationInput(value: string): void {
    this.deleteConfirmationInput = value;
    this.deleteConfirmationError = null;
  }

  cancelDeleteConfirmation(): void {
    this.clearDeleteConfirmation();
  }

  isDeleteConfirmationOpen(
    kind: DeleteConfirmationTarget['kind'],
    id: string
  ): boolean {
    return (
      this.deleteConfirmationTarget?.kind === kind &&
      this.deleteConfirmationTarget.id === id
    );
  }

  canConfirmDelete(
    kind: DeleteConfirmationTarget['kind'],
    id: string
  ): boolean {
    return (
      this.isDeleteConfirmationOpen(kind, id) &&
      this.mutationBusyKey === null &&
      this.deleteConfirmationInput.trim() ===
        this.deleteConfirmationTarget?.expectedText
    );
  }

  confirmDeleteConfirmation(): void {
    const target = this.deleteConfirmationTarget;

    if (!target) {
      return;
    }

    const confirmationText = this.deleteConfirmationInput.trim();

    if (confirmationText !== target.expectedText) {
      this.deleteConfirmationError = `Escribe exactamente "${target.expectedText}" para confirmar.`;
      this.changeDetector.markForCheck();
      return;
    }

    const request =
      target.kind === 'productType'
        ? this.pantryService.deleteProductType(target.id, { confirmationText })
        : this.pantryService.deleteInventoryLot(target.id, {
            confirmationText,
          });
    const busyKey =
      target.kind === 'productType'
        ? `delete-type-${target.id}`
        : `delete-lot-${target.id}`;

    this.clearDeleteConfirmation();

    this.runMutation(busyKey, request, { refreshArchived: true });
  }

  reviewExpiredLots(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    document
      .getElementById('expired-priority-panel')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  logout(): void {
    this.authFacade.logout();
  }

  trackByProductTypeId(
    _: number,
    productType: { productTypeId: string }
  ): string {
    return productType.productTypeId;
  }

  trackByLotId(_: number, lot: { lotId: string }): string {
    return lot.lotId;
  }

  trackByShoppingLocation(_: number, group: ShoppingRouteGroup): string {
    return group.shoppingLocation;
  }

  trackByPriceReferenceId(_: number, item: PriceReferenceItem): string {
    return item.productTypeId;
  }

  trackBySavedShoppingListId(
    _: number,
    list: SavedShoppingList,
  ): string {
    return list.id;
  }

  getExpiredQuantity(group: { lots: PantryLotSummary[] }): number {
    return this.sumLotsByStatus(group.lots, ['expired']);
  }

  getPendingExpirationQuantity(group: { lots: PantryLotSummary[] }): number {
    return this.sumLotsByStatus(group.lots, ['critical', 'soon']);
  }

  getReviewQuantity(group: { lots: PantryLotSummary[] }): number {
    return Number(
      (
        this.getExpiredQuantity(group) +
        this.getPendingExpirationQuantity(group)
      ).toFixed(2)
    );
  }

  formatQuantity(quantity: number, unit: ProductUnit | undefined): string {
    const displayUnit = unit === 'piezas' && quantity === 1 ? 'pieza' : unit;

    return displayUnit ? `${quantity} ${displayUnit}` : `${quantity}`;
  }

  formatShoppingPrice(value: number | null | undefined): string {
    return value == null || !Number.isFinite(value)
      ? 'Sin estimado'
      : `${value.toFixed(2)} moneda local`;
  }

  getWasteQuantitySummary(overview: WasteOverview): string {
    if (overview.totalQuantityByUnit.length === 0) {
      return 'Sin cantidades registradas';
    }

    return overview.totalQuantityByUnit
      .map((entry) => this.formatQuantity(entry.quantity, entry.unit))
      .join(', ');
  }

  getWeeklyWasteLossSummary(overview: WasteOverview): string {
    if (overview.eventCount === 0 || overview.estimatedLossTotal <= 0) {
      return 'Semana estimada: 0.00 moneda local';
    }

    const weeklyLoss = Number(
      ((overview.estimatedLossTotal / overview.windowDays) * 7).toFixed(2)
    );

    return `Semana estimada: ${this.formatShoppingPrice(weeklyLoss)}`;
  }

  getMonthlyWasteProjection(overview: WasteOverview): string {
    if (
      overview.eventCount === 0 ||
      overview.estimatedLossTotal <= 0 ||
      overview.windowDays <= 0
    ) {
      return 'Mes estimado: 0.00 moneda local';
    }

    const monthlyLoss = Number(
      ((overview.estimatedLossTotal / overview.windowDays) * 30).toFixed(2)
    );

    return `Mes estimado: ${this.formatShoppingPrice(monthlyLoss)}`;
  }

  getUseFirstItems(
    expiringGroups: ExpiringProductGroup[],
    pantryGroups: PantryOverviewItem[]
  ): UseFirstItem[] {
    const pantryGroupsByProductType = new Map(
      pantryGroups.map((group) => [group.productTypeId, group])
    );
    const itemsByLotId = new Map<string, UseFirstItem>();

    for (const group of expiringGroups) {
      const pantryGroup = pantryGroupsByProductType.get(group.productTypeId);

      for (const lot of group.lots) {
        if (!['expired', 'critical', 'soon'].includes(lot.expirationStatus)) {
          continue;
        }

        itemsByLotId.set(lot.lotId, {
          productTypeId: group.productTypeId,
          baseName: group.baseName,
          category: group.category,
          lot,
          priority: this.getUseFirstPriority(lot.expirationStatus),
          reason: this.getUseFirstReason(lot),
          estimatedLoss: this.getEstimatedLotValue(pantryGroup, lot),
        });
      }
    }

    for (const group of pantryGroups) {
      const storageLocation =
        this.resolveShoppingMetadata(group.shoppingMetadata).storageLocation ??
        '';

      if (storageLocation.toLocaleLowerCase('es') !== 'sobras') {
        continue;
      }

      for (const lot of group.lots) {
        if (itemsByLotId.has(lot.lotId)) {
          continue;
        }

        itemsByLotId.set(lot.lotId, {
          productTypeId: group.productTypeId,
          baseName: group.baseName,
          category: group.category,
          lot,
          priority: 4,
          reason: 'Sobra registrada',
          estimatedLoss: this.getEstimatedLotValue(group, lot),
        });
      }
    }

    return Array.from(itemsByLotId.values())
      .sort((left, right) => {
        const priorityDifference = left.priority - right.priority;

        if (priorityDifference !== 0) {
          return priorityDifference;
        }

        const leftExpiration =
          left.lot.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const rightExpiration =
          right.lot.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;

        if (leftExpiration !== rightExpiration) {
          return leftExpiration - rightExpiration;
        }

        return left.baseName.localeCompare(right.baseName, 'es', {
          sensitivity: 'base',
        });
      })
      .slice(0, 8);
  }

  getUseFirstSummary(items: UseFirstItem[]): string {
    if (items.length === 0) {
      return 'Sin acciones urgentes de uso.';
    }

    const estimatedLoss = Number(
      items
        .reduce((sum, item) => sum + (item.estimatedLoss ?? 0), 0)
        .toFixed(2)
    );
    const lossCopy =
      estimatedLoss > 0
        ? ` · ${this.formatShoppingPrice(estimatedLoss)} en riesgo`
        : '';

    return `${items.length} prioridad(es) para usar primero${lossCopy}`;
  }

  getUseFirstAction(item: UseFirstItem): string {
    if (item.lot.expirationStatus === 'expired') {
      return 'Separar o registrar merma';
    }

    if (item.lot.expirationStatus === 'critical') {
      return 'Usar hoy';
    }

    if (item.lot.expirationStatus === 'soon') {
      return 'Planear esta semana';
    }

    return 'Revisar antes de comprar más';
  }

  openUseFirstLot(item: UseFirstItem): void {
    this.expandedProductTypeIds.add(item.productTypeId);
    this.changeDetector.markForCheck();

    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    setTimeout(() => {
      document
        .getElementById(`group-panel-${item.productTypeId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  getDuplicatePurchaseWarningCount(items: ShoppingPlanItem[]): number {
    return items.filter((item) => item.totalQuantity > 0 && item.urgency !== 'depleted')
      .length;
  }

  getDuplicatePurchaseSummary(items: ShoppingPlanItem[]): string {
    const warningCount = this.getDuplicatePurchaseWarningCount(items);

    return warningCount === 1
      ? '1 producto sugerido todavía tiene stock físico.'
      : `${warningCount} productos sugeridos todavía tienen stock físico.`;
  }

  getShoppingPlanEstimatedTotal(items: ShoppingPlanItem[]): number {
    return Number(
      items
        .reduce((sum, item) => sum + (item.estimatedLineTotal ?? 0), 0)
        .toFixed(2)
    );
  }

  getShoppingPlanTotalLabel(items: ShoppingPlanItem[]): string {
    if (!this.hasShoppingPriceEstimate(items)) {
      return 'Sin precios estimados';
    }

    return this.hasMissingShoppingPrices(items)
      ? 'Total parcial estimado'
      : 'Total estimado';
  }

  getShoppingPlanTotalSummary(items: ShoppingPlanItem[]): string {
    if (!this.hasShoppingPriceEstimate(items)) {
      return this.getShoppingPlanTotalLabel(items);
    }

    const totalValue = this.formatShoppingPrice(
      this.getShoppingPlanEstimatedTotal(items)
    );

    return `${this.getShoppingPlanTotalLabel(items)}: ${totalValue}`;
  }

  getStapleAttentionSummary(items: PantryStapleItem[]): string {
    const attentionCount = items.filter(
      (item) => item.status !== 'available'
    ).length;

    if (items.length === 0) {
      return 'Sin básicos marcados';
    }

    return attentionCount === 0
      ? `${items.length} básicos cubiertos`
      : `${attentionCount} de ${items.length} básicos por revisar`;
  }

  getStapleRestockSummary(items: PantryStapleItem[]): string {
    const total = Number(
      items
        .reduce((sum, item) => sum + (item.estimatedRestockTotal ?? 0), 0)
        .toFixed(2)
    );

    return total > 0
      ? `Reposición estimada: ${this.formatShoppingPrice(total)}`
      : 'Sin reposición estimada';
  }

  getMonthlyStapleReport(items: PantryStapleItem[]): string {
    if (items.length === 0) {
      return 'Sin básicos para reporte mensual';
    }

    const attentionCount = items.filter(
      (item) => item.status !== 'available'
    ).length;
    const restockTotal = Number(
      items
        .reduce((sum, item) => sum + (item.estimatedRestockTotal ?? 0), 0)
        .toFixed(2)
    );

    return `${attentionCount} por revisar · ${this.formatShoppingPrice(
      restockTotal
    )} para reponer`;
  }

  getPantryTimeline(
    pantryGroups: PantryOverviewItem[],
    wasteEvents: WasteEventSummary[] = [],
    priceReferences: PriceReferenceItem[] = []
  ): PantryTimelineItem[] {
    const timeline: PantryTimelineItem[] = [];

    for (const group of pantryGroups) {
      for (const lot of group.lots) {
        if (!lot.purchaseDate) {
          continue;
        }

        timeline.push({
          id: `purchase-${lot.lotId}`,
          kind: 'purchase',
          title: group.baseName,
          detail: `${this.formatQuantity(lot.quantity, lot.unit)} comprado`,
          happenedAt: lot.purchaseDate,
          amount: this.getEstimatedLotValue(group, lot),
        });
      }
    }

    for (const event of wasteEvents) {
      timeline.push({
        id: `waste-${event.id}`,
        kind: 'waste',
        title: event.productName,
        detail: `${this.wasteReasonLabels[event.reason]} · ${this.formatQuantity(
          event.quantity,
          event.unit
        )}`,
        happenedAt: event.occurredAt,
        amount: event.estimatedLoss,
      });
    }

    for (const item of priceReferences) {
      const latestPrice = item.priceHistory
        .slice()
        .sort(
          (left, right) =>
            right.recordedAt.getTime() - left.recordedAt.getTime()
        )[0];

      if (!latestPrice) {
        continue;
      }

      timeline.push({
        id: `price-${item.productTypeId}-${latestPrice.recordedAt.getTime()}`,
        kind: 'price',
        title: item.baseName,
        detail: `Precio ${this.formatShoppingPrice(
          latestPrice.estimatedUnitPrice
        )}${
          latestPrice.shoppingLocation
            ? ` · ${latestPrice.shoppingLocation}`
            : ''
        }`,
        happenedAt: latestPrice.recordedAt,
        amount: latestPrice.estimatedUnitPrice,
      });
    }

    return timeline
      .sort(
        (left, right) =>
          right.happenedAt.getTime() - left.happenedAt.getTime()
      )
      .slice(0, 10);
  }

  getTimelineKindLabel(kind: PantryTimelineItemKind): string {
    const labels: Record<PantryTimelineItemKind, string> = {
      purchase: 'Compra',
      waste: 'Merma',
      price: 'Precio',
    };

    return labels[kind];
  }

  buildShoppingPlanExportText(items: ShoppingPlanItem[]): string {
    if (items.length === 0) {
      return 'Lista de compras Despensa Lista\nSin compras sugeridas.';
    }

    const lines = [
      'Lista de compras Despensa Lista',
      this.getShoppingPlanTotalSummary(items),
      '',
    ];

    for (const group of this.groupShoppingPlanByRoute(items)) {
      lines.push(`${group.location}:`);
      lines.push(`Subtotal ruta: ${this.getRouteTotalSummary(group.items)}`);

      const missingPriceCount = group.items.filter(
        (item) => item.estimatedLineTotal === undefined
      ).length;

      if (missingPriceCount > 0) {
        lines.push(
          `Precios pendientes: ${missingPriceCount} ${
            missingPriceCount === 1 ? 'producto' : 'productos'
          }`
        );
      }

      for (const item of group.items) {
        const metadata = this.resolveShoppingMetadata(item.shoppingMetadata);
        lines.push(
          `- ${item.baseName}: ${this.formatQuantity(
            item.suggestedPurchaseQuantity,
            item.defaultUnit
          )}`
        );

        if (item.estimatedLineTotal !== undefined) {
          lines.push(
            `  Aprox: ${this.formatShoppingPrice(item.estimatedLineTotal)}`
          );
        }

        if (metadata.preferredBrand) {
          lines.push(`  Marca: ${metadata.preferredBrand}`);
        }

        if (metadata.substituteBrand) {
          lines.push(`  Sustituto: ${metadata.substituteBrand}`);
        }

        if (metadata.buyOnlyOnPromo) {
          lines.push('  Solo promo');
        }

        if (metadata.shoppingNotes) {
          lines.push(`  Nota: ${metadata.shoppingNotes}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  saveShoppingListSnapshot(items: ShoppingPlanItem[]): void {
    const listPayload = this.buildShoppingListSnapshotPayload(
      items,
      this.savedShoppingListForm.getRawValue(),
    );

    if (!listPayload) {
      return;
    }

    this.persistShoppingListSnapshot(
      listPayload,
      'Lista sincronizada en tu cuenta.',
    );
  }

  saveMasterShoppingListSnapshot(items: ShoppingPlanItem[]): void {
    const listPayload = this.buildShoppingListSnapshotPayload(items, {
      title: 'Lista maestra',
      occasion: 'Compra recurrente',
      shoppingLocation: '',
    });

    if (!listPayload) {
      return;
    }

    this.persistShoppingListSnapshot(
      listPayload,
      'Lista maestra sincronizada en tu cuenta.',
    );
  }

  private buildShoppingListSnapshotPayload(
    items: ShoppingPlanItem[],
    rawValue: { title?: string; occasion?: string; shoppingLocation?: string },
  ): SavedShoppingListSnapshotPayload | null {
    if (items.length === 0) {
      this.savedShoppingListStatus = 'No hay compras sugeridas para guardar.';
      return null;
    }

    const shoppingLocation = this.toOptionalText(rawValue.shoppingLocation);
    const filteredItems = shoppingLocation
      ? items.filter((item) => {
          const metadata = this.resolveShoppingMetadata(item.shoppingMetadata);
          return metadata.shoppingLocation === shoppingLocation;
        })
      : items;

    if (filteredItems.length === 0) {
      this.savedShoppingListStatus =
        'No hay productos para esa tienda en la lista actual.';
      return null;
    }

    return {
      title:
        this.toOptionalText(rawValue.title) ??
        `Lista ${this.savedShoppingLists.length + 1}`,
      occasion: this.toOptionalText(rawValue.occasion),
      shoppingLocation,
      items: filteredItems.map((item) => ({
        productTypeId: item.productTypeId,
        baseName: item.baseName,
        quantity: item.suggestedPurchaseQuantity,
        unit: item.defaultUnit,
        shoppingLocation: this.resolveShoppingMetadata(item.shoppingMetadata)
          .shoppingLocation,
        estimatedUnitPrice: item.estimatedUnitPrice,
        estimatedLineTotal: item.estimatedLineTotal,
      })),
    };
  }

  private persistShoppingListSnapshot(
    listPayload: SavedShoppingListSnapshotPayload,
    successMessage: string,
  ): void {
    this.savedShoppingListStatus = 'Guardando lista...';
    this.pantryService.createSavedShoppingList(listPayload).subscribe({
      next: (list) => {
        this.savedShoppingLists = [list, ...this.savedShoppingLists]
          .filter(
            (candidate, index, lists) =>
              lists.findIndex((entry) => entry.id === candidate.id) === index,
          )
          .slice(0, 25);
        this.savedShoppingListStatus = successMessage;
        this.resetSavedShoppingListForm();
        this.persistSavedShoppingLists();
        this.changeDetector.markForCheck();
      },
      error: (error) => {
        const now = new Date();
        const localList: SavedShoppingList = {
          id: `local-${now.getTime()}`,
          ownerUserId: this.localStateOwnerUserId ?? undefined,
          ...listPayload,
          createdAt: now,
          updatedAt: now,
        };
        this.savedShoppingLists = [localList, ...this.savedShoppingLists].slice(
          0,
          25,
        );
        this.savedShoppingListStatus = `${this.getErrorMessage(error)} Lista guardada solo en este navegador.`;
        this.resetSavedShoppingListForm();
        this.persistSavedShoppingLists();
        this.changeDetector.markForCheck();
      },
    });
  }

  getMasterShoppingList(): SavedShoppingList | null {
    return (
      this.savedShoppingLists.find(
        (list) => list.title.trim().toLocaleLowerCase('es') === 'lista maestra',
      ) ?? null
    );
  }

  async copySavedShoppingList(list: SavedShoppingList): Promise<void> {
    const exportText = this.buildSavedShoppingListExportText(list);
    const copyResult = await this.copyTextToClipboard(exportText);

    this.shoppingExportText = exportText;
    this.savedShoppingListStatus =
      copyResult === 'manual'
        ? 'Lista lista para copiar manualmente.'
        : 'Lista guardada copiada.';
    this.changeDetector.markForCheck();
  }

  deleteSavedShoppingList(listId: string): void {
    const list = this.savedShoppingLists.find((entry) => entry.id === listId);

    if (!list) {
      return;
    }

    if (!list.ownerUserId) {
      this.removeSavedShoppingList(listId);
      this.savedShoppingListStatus = 'Lista local eliminada.';
      return;
    }

    this.savedShoppingListStatus = 'Eliminando lista...';
    this.pantryService.deleteSavedShoppingList(listId).subscribe({
      next: () => {
        this.removeSavedShoppingList(listId);
        this.savedShoppingListStatus = 'Lista sincronizada eliminada.';
        this.changeDetector.markForCheck();
      },
      error: (error) => {
        this.savedShoppingListStatus = this.getErrorMessage(error);
        this.changeDetector.markForCheck();
      },
    });
  }

  buildSavedShoppingListExportText(list: SavedShoppingList): string {
    const lines = [
      `Despensa Lista: ${list.title}`,
      list.occasion ? `Ocasión: ${list.occasion}` : '',
      list.shoppingLocation ? `Tienda: ${list.shoppingLocation}` : '',
      '',
    ].filter((line) => line !== '');

    for (const item of list.items) {
      lines.push(`- ${item.baseName}: ${this.formatQuantity(item.quantity, item.unit)}`);
      if (item.estimatedLineTotal !== undefined) {
        lines.push(`  Aprox: ${this.formatShoppingPrice(item.estimatedLineTotal)}`);
      }
    }

    return lines.join('\n');
  }

  async copyShoppingPlan(items: ShoppingPlanItem[]): Promise<void> {
    const exportText = this.buildShoppingPlanExportText(items);
    this.shoppingExportText = exportText;

    const copyResult = await this.copyTextToClipboard(exportText);

    if (copyResult === 'native' || copyResult === 'legacy') {
      this.shoppingExportStatus = 'Lista copiada para WhatsApp.';
    } else {
      this.shoppingExportStatus = 'Lista generada para copiar manualmente.';
    }

    this.changeDetector.markForCheck();
  }

  async shareShoppingPlan(items: ShoppingPlanItem[]): Promise<void> {
    const exportText = this.buildShoppingPlanExportText(items);
    this.shoppingExportText = exportText;

    if (!isPlatformBrowser(this.platformId)) {
      this.shoppingExportStatus = 'Lista generada para compartir manualmente.';
      this.changeDetector.markForCheck();
      return;
    }

    const shareNavigator = navigator as Navigator & {
      share?: (data: { title?: string; text: string }) => Promise<void>;
    };

    if (shareNavigator.share) {
      try {
        await shareNavigator.share({
          title: 'Despensa Lista',
          text: exportText,
        });
        this.shoppingExportStatus = 'Lista lista para compartir.';
        this.changeDetector.markForCheck();
        return;
      } catch {
        this.shoppingExportStatus =
          'No se pudo abrir compartir; usa copia o WhatsApp.';
      }
    }

    await this.copyShoppingPlan(items);
  }

  createTemporaryShoppingShare(items: ShoppingPlanItem[]): void {
    const exportText = this.buildShoppingPlanExportText(items);
    this.shoppingExportText = exportText;

    if (!isPlatformBrowser(this.platformId)) {
      this.shoppingShareStatus = 'Enlace disponible solo en navegador.';
      this.shoppingShareId = null;
      this.shoppingShareLink = null;
      this.shoppingShareToken = null;
      this.shoppingShareExpiresAt = null;
      return;
    }

    this.shoppingShareBusy = true;
    this.shoppingShareStatus = 'Creando enlace temporal...';
    this.shoppingShareId = null;
    this.shoppingShareLink = null;
    this.shoppingShareToken = null;
    this.shoppingShareExpiresAt = null;
    this.pantryService
      .createShoppingShare({ text: exportText })
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.shoppingShareBusy = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (share) => {
          if (!share.token) {
            this.shoppingShareStatus = 'No se pudo crear el enlace temporal.';
            return;
          }

          this.shoppingShareId = share.id ?? null;
          this.shoppingShareToken = share.token;
          this.shoppingShareExpiresAt = share.expiresAt;
          this.shoppingShareLink = `${window.location.origin}/shared-shopping-list?token=${encodeURIComponent(share.token)}`;
          this.activeShoppingShares = share.id
            ? [
                share,
                ...this.activeShoppingShares.filter(
                  (activeShare) => activeShare.id !== share.id
                ),
              ]
            : this.activeShoppingShares;
          this.shoppingShareStatus =
            'Enlace temporal creado. Puedes revocarlo cuando termines.';
        },
        error: (error) => {
          this.shoppingShareStatus = this.getErrorMessage(error);
        },
      });
  }

  revokeTemporaryShoppingShare(): void {
    if (!this.shoppingShareToken || this.shoppingShareBusy) {
      return;
    }

    this.shoppingShareBusy = true;
    this.shoppingShareStatus = 'Revocando enlace temporal...';
    this.pantryService
      .revokeShoppingShare(this.shoppingShareToken)
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.shoppingShareBusy = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          this.shoppingShareLink = null;
          this.shoppingShareId = null;
          this.shoppingShareToken = null;
          this.shoppingShareExpiresAt = null;
          this.shoppingShareStatus = 'Enlace temporal revocado.';
          this.loadActiveShoppingShares();
        },
        error: (error) => {
          this.shoppingShareStatus = this.getErrorMessage(error);
        },
      });
  }

  revokeActiveShoppingShare(share: ShoppingShare): void {
    if (!share.id || this.shoppingShareBusy) {
      return;
    }

    this.shoppingShareBusy = true;
    this.shoppingShareStatus = 'Revocando enlace temporal...';
    this.pantryService
      .revokeShoppingShareById(share.id)
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.shoppingShareBusy = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          this.activeShoppingShares = this.activeShoppingShares.filter(
            (activeShare) => activeShare.id !== share.id
          );
          if (share.id === this.shoppingShareId) {
            this.shoppingShareLink = null;
            this.shoppingShareId = null;
            this.shoppingShareToken = null;
            this.shoppingShareExpiresAt = null;
          }
          this.shoppingShareStatus = 'Enlace temporal revocado.';
        },
        error: (error) => {
          this.shoppingShareStatus = this.getErrorMessage(error);
        },
      });
  }

  loadActiveShoppingShares(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.activeShoppingSharesLoading = true;
    this.activeShoppingSharesError = null;
    this.pantryService
      .listActiveShoppingShares()
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.activeShoppingSharesLoading = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (shares) => {
          this.activeShoppingShares = shares;
        },
        error: (error) => {
          this.activeShoppingSharesError = this.getErrorMessage(error);
        },
      });
  }

  formatCentralDate(date: Date): string {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Mexico_City',
    }).format(date);
  }

  getWhatsAppShoppingUrl(exportText: string): string {
    return `https://wa.me/?text=${encodeURIComponent(exportText)}`;
  }

  private async copyTextToClipboard(
    text: string,
  ): Promise<'native' | 'legacy' | 'manual'> {
    if (!isPlatformBrowser(this.platformId)) {
      return 'manual';
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return 'native';
      } catch {
        // Fall through to the legacy browser copy path.
      }
    }

    return this.copyTextWithLegacyCommand(text) ? 'legacy' : 'manual';
  }

  private copyTextWithLegacyCommand(text: string): boolean {
    if (typeof document.execCommand !== 'function') {
      return false;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }

  downloadPantryExport(): void {
    if (!isPlatformBrowser(this.platformId)) {
      this.privacyExportStatus = 'Export disponible solo en navegador.';
      return;
    }

    this.privacyExportBusy = true;
    this.privacyExportStatus = null;

    this.pantryService
      .exportPantryData()
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.privacyExportBusy = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (exportData) => {
          const blob = new Blob([JSON.stringify(exportData, null, 2)], {
            type: 'application/json',
          });
          const downloadUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = downloadUrl;
          anchor.download = `despensalista-export-${toDateInputValue(
            new Date()
          )}.json`;
          anchor.click();
          URL.revokeObjectURL(downloadUrl);
          this.privacyExportStatus = 'Export descargado en este navegador.';
        },
        error: (error) => {
          this.privacyExportStatus = this.getErrorMessage(error);
        },
      });
  }

  async enterShoppingMode(items: ShoppingPlanItem[]): Promise<void> {
    this.shoppingModeSourceList = null;
    this.ensureShoppingTripDraft(items);
    this.shoppingModeActive = true;
    this.shoppingCheckoutStatus = this.isOffline
      ? 'Modo compra sin conexion; el cierre queda pendiente.'
      : 'Modo compra activo.';
    await this.requestShoppingWakeLock();
    this.changeDetector.markForCheck();
  }

  async enterShoppingModeFromSavedList(
    list: SavedShoppingList,
    planItems: ShoppingPlanItem[],
  ): Promise<void> {
    const sourceItems = this.buildShoppingTripRowsFromSavedList(
      list,
      planItems,
    );

    if (sourceItems.length === 0) {
      this.savedShoppingListStatus = 'Esta lista guardada no tiene productos.';
      return;
    }

    this.shoppingModeSourceList = list;
    this.shoppingTripDraft = sourceItems.reduce<
      Record<string, ShoppingTripDraftItem>
    >(
      (draft, item) => ({
        ...draft,
        [item.productTypeId]: {
          productTypeId: item.productTypeId,
          checked: true,
          quantity: item.suggestedPurchaseQuantity,
          unit: item.defaultUnit,
          paidUnitPrice: item.estimatedUnitPrice,
          shoppingLocation: this.resolveShoppingMetadata(item.shoppingMetadata)
            .shoppingLocation,
        },
      }),
      {},
    );
    this.persistShoppingTripDraft();
    this.shoppingModeActive = true;
    this.savedShoppingListStatus = `Repitiendo ${list.title}.`;
    this.shoppingCheckoutStatus = this.isOffline
      ? 'Modo compra sin conexion; el cierre queda pendiente.'
      : 'Lista cargada en modo compra.';
    await this.requestShoppingWakeLock();
    this.changeDetector.markForCheck();
  }

  exitShoppingMode(): void {
    this.shoppingModeActive = false;
    this.shoppingModeSourceList = null;
    this.shoppingCheckoutStatus = null;
    void this.releaseShoppingWakeLock();
    this.persistShoppingTripDraft();
  }

  getShoppingModeRows(items: ShoppingPlanItem[]): ShoppingTripSourceItem[] {
    if (this.shoppingModeSourceList) {
      return this.buildShoppingTripRowsFromSavedList(
        this.shoppingModeSourceList,
        items,
      );
    }

    return items;
  }

  getShoppingTripItem(item: ShoppingTripSourceItem): ShoppingTripDraftItem {
    return {
      ...this.buildDefaultShoppingTripItem(item),
      ...this.shoppingTripDraft[item.productTypeId],
      unit: item.defaultUnit,
    };
  }

  updateShoppingTripChecked(item: ShoppingTripSourceItem, event: Event): void {
    const input = event.target as HTMLInputElement;
    this.updateShoppingTripDraftItem(item, { checked: input.checked });
  }

  updateShoppingTripQuantity(
    item: ShoppingTripSourceItem,
    value: string | number | null
  ): void {
    const quantity = this.toOptionalNumber(value);

    if (quantity === undefined || quantity <= 0) {
      this.shoppingCheckoutStatus = 'Cantidad invalida para cerrar compra.';
      return;
    }

    this.updateShoppingTripDraftItem(item, {
      quantity: Number(quantity.toFixed(2)),
    });
  }

  updateShoppingTripPaidUnitPrice(
    item: ShoppingTripSourceItem,
    value: string | number | null
  ): void {
    const paidUnitPrice = this.toOptionalNumber(value);

    this.updateShoppingTripDraftItem(item, {
      paidUnitPrice:
        paidUnitPrice === undefined || paidUnitPrice <= 0
          ? undefined
          : Number(paidUnitPrice.toFixed(2)),
    });
  }

  updateShoppingTripLocation(item: ShoppingTripSourceItem, value: string): void {
    this.updateShoppingTripDraftItem(item, {
      shoppingLocation: this.toOptionalText(value),
    });
  }

  closeShoppingTrip(items: ShoppingPlanItem[]): void {
    if (this.shoppingCheckoutBusy || this.pendingShoppingCheckoutSyncing) {
      return;
    }
    const selectedItems = this.getSelectedShoppingTripItems(
      this.getShoppingModeRows(items),
    );

    if (selectedItems.length === 0) {
      this.shoppingCheckoutStatus = 'Marca al menos un producto comprado.';
      return;
    }

    const requestItems = this.buildCloseShoppingPurchaseItems(selectedItems);

    if (requestItems.length > SHOPPING_CHECKOUT_MAX_ITEMS) {
      this.shoppingCheckoutStatus =
        `El cierre atómico admite como máximo ${SHOPPING_CHECKOUT_MAX_ITEMS} productos por compra.`;
      return;
    }

    const pendingCheckout = this.enqueuePendingShoppingCheckout(requestItems);

    if (!pendingCheckout) {
      this.shoppingCheckoutStatus =
        'No se pudo guardar el cierre en este navegador. Mantén el modo compra abierto e intenta de nuevo.';
      return;
    }

    if (this.isOffline) {
      this.shoppingCheckoutStatus =
        'Sin conexion. Cierre guardado para sincronizar despues.';
      this.shoppingModeActive = false;
      this.shoppingModeSourceList = null;
      this.persistShoppingTripDraft();
      void this.releaseShoppingWakeLock();
      return;
    }

    this.shoppingCheckoutBusy = true;
    this.shoppingCheckoutStatus = null;

    this.pantryService
      .closeShoppingPurchase(
        { items: requestItems },
        pendingCheckout.idempotencyKey,
      )
      .pipe(
        timeout(this.lotRegistrationTimeoutMs),
        finalize(() => {
          this.shoppingCheckoutBusy = false;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: (result) => {
          this.removePendingShoppingCheckout(pendingCheckout.id);
          this.shoppingCheckoutStatus = result.replayed
            ? `Compra recuperada sin duplicados: ${result.value.length} lotes registrados.`
            : `Compra cerrada: ${result.value.length} lotes registrados.`;
          this.shoppingModeActive = false;
          this.shoppingModeSourceList = null;
          this.shoppingTripDraft = {};
          this.removeLocalValue(this.shoppingTripStorageKey);
          void this.releaseShoppingWakeLock();
          this.loadOverview();
        },
        error: (error) => {
          if (this.isMutationConflict(error)) {
            this.removePendingShoppingCheckout(pendingCheckout.id);
            this.shoppingCheckoutStatus =
              'La despensa cambió mientras cerrabas la compra. Ya actualizamos los datos; revisa la selección y vuelve a intentarlo.';
            this.loadOverview();
            return;
          }

          this.shoppingCheckoutStatus = this.getErrorMessage(error);
          this.persistShoppingTripDraft();
        },
      });
  }

  clearShoppingTripDraft(items: ShoppingPlanItem[]): void {
    this.shoppingTripDraft = {};
    this.ensureShoppingTripDraft(this.getShoppingModeRows(items));
    this.shoppingCheckoutStatus = 'Borrador de compra reiniciado.';
  }

  getShoppingTripSelectedCount(items: ShoppingPlanItem[]): number {
    return this.getSelectedShoppingTripItems(
      this.getShoppingModeRows(items),
    ).length;
  }

  getShoppingTripPlannedTotal(items: ShoppingPlanItem[]): number {
    return Number(
      this.getSelectedShoppingTripItems(this.getShoppingModeRows(items))
        .reduce(
          (sum, selection) =>
            sum + (selection.planItem.estimatedLineTotal ?? 0),
          0
        )
        .toFixed(2)
    );
  }

  getShoppingTripActualTotal(items: ShoppingPlanItem[]): number {
    return Number(
      this.getSelectedShoppingTripItems(this.getShoppingModeRows(items))
        .reduce((sum, selection) => {
          const unitPrice =
            selection.draft.paidUnitPrice ??
            selection.planItem.estimatedUnitPrice ??
            0;
          return sum + unitPrice * selection.draft.quantity;
        }, 0)
        .toFixed(2)
    );
  }

  getShoppingTripActualDifferenceLabel(items: ShoppingPlanItem[]): string {
    const plannedTotal = this.getShoppingTripPlannedTotal(items);
    const actualTotal = this.getShoppingTripActualTotal(items);
    const difference = Number((actualTotal - plannedTotal).toFixed(2));

    if (difference === 0) {
      return 'Real igual al plan.';
    }

    return difference > 0
      ? `Real sobre plan por ${this.formatShoppingPrice(difference)}`
      : `Real bajo plan por ${this.formatShoppingPrice(Math.abs(difference))}`;
  }

  getLastPaidPriceSummary(item: ShoppingTripSourceItem): string {
    const metadata = this.resolveShoppingMetadata(item.shoppingMetadata);
    const latestPrice = metadata.priceHistory?.[0];
    const estimatedUnitPrice =
      latestPrice?.estimatedUnitPrice ??
      metadata.estimatedUnitPrice ??
      item.estimatedUnitPrice;

    if (estimatedUnitPrice === undefined) {
      return 'Sin precio pagado';
    }

    const parts = [`Último: ${this.formatShoppingPrice(estimatedUnitPrice)}`];
    const shoppingLocation =
      latestPrice?.shoppingLocation ?? metadata.shoppingLocation;

    if (shoppingLocation) {
      parts.push(shoppingLocation);
    }

    if (latestPrice?.recordedAt) {
      parts.push(this.formatCentralDate(latestPrice.recordedAt));
    }

    return parts.join(' · ');
  }

  isShoppingStaple(item: ShoppingTripSourceItem): boolean {
    return this.resolveShoppingMetadata(item.shoppingMetadata).householdStaple;
  }

  toggleShoppingStaple(item: ShoppingTripSourceItem): void {
    if (this.stapleToggleBusyProductTypeId) {
      return;
    }

    const metadata = this.resolveShoppingMetadata(item.shoppingMetadata);
    this.stapleToggleBusyProductTypeId = item.productTypeId;
    this.pantryService
      .updateProductTypeShoppingMetadata(
        item.productTypeId,
        this.buildShoppingMetadataRequest({
          ...metadata,
          householdStaple: !metadata.householdStaple,
        }),
      )
      .pipe(
        finalize(() => {
          this.stapleToggleBusyProductTypeId = null;
          this.changeDetector.markForCheck();
        }),
      )
      .subscribe({
        next: () => {
          this.shoppingCheckoutStatus = metadata.householdStaple
            ? `${item.baseName} ya no está marcado como básico.`
            : `${item.baseName} marcado como básico.`;
          this.loadOverview();
        },
        error: (error) => {
          this.shoppingCheckoutStatus = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  setShoppingTripItemsChecked(
    items: ShoppingPlanItem[],
    checked: boolean,
  ): void {
    const sourceItems = this.getShoppingModeRows(items);
    this.shoppingTripDraft = sourceItems.reduce<
      Record<string, ShoppingTripDraftItem>
    >(
      (draft, item) => ({
        ...draft,
        [item.productTypeId]: {
          ...this.getShoppingTripItem(item),
          checked,
        },
      }),
      {},
    );
    this.persistShoppingTripDraft();
    this.shoppingCheckoutStatus = checked
      ? 'Todos los productos marcados.'
      : 'Todos los productos desmarcados.';
  }

  setUrgentShoppingTripItemsChecked(items: ShoppingPlanItem[]): void {
    const sourceItems = this.getShoppingModeRows(items);
    this.shoppingTripDraft = sourceItems.reduce<
      Record<string, ShoppingTripDraftItem>
    >(
      (draft, item) => ({
        ...draft,
        [item.productTypeId]: {
          ...this.getShoppingTripItem(item),
          checked: item.urgency === 'depleted' || item.urgency === 'critical',
        },
      }),
      {},
    );
    this.persistShoppingTripDraft();
    this.shoppingCheckoutStatus = 'Solo urgentes marcados.';
  }

  getRouteTotalSummary(items: ShoppingPlanItem[]): string {
    if (!this.hasShoppingPriceEstimate(items)) {
      return 'sin precios estimados';
    }

    return this.formatShoppingPrice(this.getShoppingPlanEstimatedTotal(items));
  }

  getWasteSavingsSummary(insights: PantryValueInsights): string {
    return [
      `Riesgo desperdicio: ${this.formatShoppingPrice(
        insights.estimatedWasteAtRisk
      )}`,
      `${insights.pricedShoppingItemCount} con precio`,
      `${insights.unpricedShoppingItemCount} sin precio`,
      `${insights.promoOnlyShoppingItemCount} solo promo`,
    ].join(' · ');
  }

  saveShoppingBudget(amount?: number | null): void {
    const rawAmount = amount ?? this.shoppingBudgetForm.controls.amount.value;
    const parsedAmount = this.toOptionalNumber(rawAmount);

    if (parsedAmount === undefined || parsedAmount < 0) {
      this.shoppingBudget = null;
      this.removeLocalValue(this.shoppingBudgetStorageKey);
      this.shoppingBudgetForm.patchValue(
        { amount: null },
        { emitEvent: false }
      );
      return;
    }

    this.shoppingBudget = Number(parsedAmount.toFixed(2));
    this.shoppingBudgetForm.patchValue(
      { amount: this.shoppingBudget },
      { emitEvent: false }
    );
    this.setLocalValue(
      this.shoppingBudgetStorageKey,
      JSON.stringify(this.shoppingBudget)
    );
  }

  clearShoppingBudget(): void {
    this.shoppingBudget = null;
    this.shoppingBudgetForm.patchValue({ amount: null }, { emitEvent: false });
    this.removeLocalValue(this.shoppingBudgetStorageKey);
  }

  getBudgetStatusLabel(total: number): string {
    if (this.shoppingBudget === null) {
      return 'Sin presupuesto definido';
    }

    const difference = Number((this.shoppingBudget - total).toFixed(2));

    return difference >= 0
      ? `Dentro del presupuesto: quedan ${this.formatShoppingPrice(difference)}`
      : `Sobre presupuesto por ${this.formatShoppingPrice(
          Math.abs(difference)
        )}`;
  }

  getBudgetStatusTone(total: number): 'unset' | 'ok' | 'over' {
    if (this.shoppingBudget === null) {
      return 'unset';
    }

    return total <= this.shoppingBudget ? 'ok' : 'over';
  }

  parseQuickCaptureText(rawText: string): QuickCaptureItem[] {
    return rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => this.parseQuickCaptureLine(line))
      .filter((item): item is QuickCaptureItem => item !== null);
  }

  parseQuickCaptureCsv(rawCsv: string): QuickCaptureItem[] {
    const normalizedCsv = rawCsv.replace(/^\uFEFF/, '');
    const rows = this.parseCsvRows(
      normalizedCsv,
      this.detectCsvDelimiter(normalizedCsv)
    ).filter((row) => row.some((cell) => cell.trim()));

    if (rows.length === 0) {
      return [];
    }

    const normalizedHeader = rows[0].map((cell) =>
      this.normalizeCsvHeader(cell)
    );
    const hasHeader = normalizedHeader.some((cell) =>
      [
        'producto',
        'product',
        'nombre',
        'name',
        'cantidad',
        'quantity',
        'precio',
        'price',
        'barcode',
        'codigo',
      ].includes(cell)
    );
    const dataRows = hasHeader ? rows.slice(1) : rows;

    return dataRows
      .map((row) =>
        hasHeader
          ? this.parseQuickCaptureCsvHeaderRow(row, normalizedHeader)
          : this.parseQuickCaptureCsvIndexRow(row)
      )
      .filter((item): item is QuickCaptureItem => item !== null);
  }

  getQuickCapturePreviewItems(rawText: string): QuickCaptureItem[] {
    return this.parseQuickCaptureText(rawText).slice(0, 8);
  }

  handleQuickCaptureCsvImport(event: Event): void {
    if (!isPlatformBrowser(this.platformId)) {
      this.quickCaptureStatus = 'Import disponible solo en navegador.';
      return;
    }

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
      return;
    }

    if (file.size > 512_000) {
      this.quickCaptureStatus = 'CSV demasiado grande para import local.';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const items = this.parseQuickCaptureCsv(String(reader.result ?? ''));

      if (items.length === 0) {
        this.quickCaptureStatus = 'CSV sin productos reconocibles.';
        this.changeDetector.markForCheck();
        return;
      }

      this.quickCaptureForm.patchValue({
        rawText: this.buildQuickCaptureText(items),
      });
      this.quickCaptureStatus = `CSV importado: ${items.length} producto(s). Revisa antes de guardar.`;
      this.changeDetector.markForCheck();
    };
    reader.onerror = () => {
      this.quickCaptureStatus = 'No se pudo leer el CSV.';
      this.changeDetector.markForCheck();
    };
    reader.readAsText(file);
  }

  downloadPantryCsv(pantryGroups: PantryOverviewItem[]): void {
    if (!isPlatformBrowser(this.platformId)) {
      this.quickCaptureStatus = 'Export CSV disponible solo en navegador.';
      return;
    }

    if (pantryGroups.length === 0) {
      this.quickCaptureStatus = 'No hay despensa activa para exportar.';
      return;
    }

    this.downloadTextFile(
      this.buildPantryCsvExport(pantryGroups),
      `despensalista-despensa-${toDateInputValue(new Date(), true)}.csv`,
      'text/csv;charset=utf-8'
    );
    this.quickCaptureStatus = 'CSV exportado para Excel.';
  }

  buildPantryCsvExport(pantryGroups: PantryOverviewItem[]): string {
    const rows = [
      [
        'Producto',
        'Variante',
        'Categoria',
        'Cantidad',
        'Unidad',
        'Ubicacion',
        'Tienda',
        'Marca preferida',
        'Precio estimado',
        'Compra',
        'Caducidad',
      ],
    ];

    for (const group of pantryGroups) {
      const metadata = this.resolveShoppingMetadata(group.shoppingMetadata);
      const lots =
        group.lots.length > 0
          ? group.lots
          : [
              {
                lotId: group.productTypeId,
                variantName: '',
                quantity: group.totalQuantity,
                unit: group.defaultUnit,
                expiresAt: null,
                purchaseDate: null,
                expirationStatus: 'none' as ExpirationStatus,
                updatedAt: new Date(),
              },
            ];

      for (const lot of lots) {
        rows.push([
          group.baseName,
          lot.variantName ?? '',
          this.categoryLabels[group.category],
          `${lot.quantity}`,
          lot.unit,
          metadata.storageLocation ?? '',
          metadata.shoppingLocation ?? '',
          metadata.preferredBrand ?? '',
          metadata.estimatedUnitPrice === undefined
            ? ''
            : `${metadata.estimatedUnitPrice}`,
          lot.purchaseDate ? toDateInputValue(lot.purchaseDate) : '',
          lot.expiresAt ? toDateInputValue(lot.expiresAt) : '',
        ]);
      }
    }

    return rows
      .map((row) => row.map((cell) => this.escapeCsvCell(cell)).join(','))
      .join('\r\n');
  }

  async handleQuickCapturePhotoChange(event: Event): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      this.quickCapturePhotoStatus = 'Foto disponible solo en navegador.';
      return;
    }

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      this.quickCapturePhotoStatus = 'Selecciona una imagen.';
      return;
    }

    if (file.size > 2_000_000) {
      this.quickCapturePhotoStatus = 'Imagen demasiado grande para vista local.';
      return;
    }

    this.revokeQuickCapturePhotoPreview();
    this.quickCapturePhotoPreviewUrl = URL.createObjectURL(file);
    this.quickCapturePhotoName = file.name;
    this.quickCaptureDetectedBarcode = null;

    if (!this.barcodeCaptureSupported) {
      this.quickCapturePhotoStatus =
        'Foto local lista. Escaneo de código no disponible en este navegador.';
      return;
    }

    try {
      this.quickCaptureDetectedBarcode = await this.detectBarcodeFromImage(
        this.quickCapturePhotoPreviewUrl
      );
      this.quickCapturePhotoStatus = this.quickCaptureDetectedBarcode
        ? `Código detectado: ${this.quickCaptureDetectedBarcode}`
        : 'Foto local lista. No se detectó código.';
    } catch {
      this.quickCapturePhotoStatus =
        'Foto local lista. No se pudo escanear código.';
    } finally {
      this.changeDetector.markForCheck();
    }
  }

  confirmQuickCaptureBarcode(rawBarcode: string | null | undefined): void {
    const barcode = rawBarcode?.trim();

    if (!barcode) {
      this.quickCapturePhotoStatus = 'Escribe o detecta un código primero.';
      return;
    }

    const currentText = this.quickCaptureForm.controls.rawText.value.trim();
    const barcodeLine = `Producto ${barcode.slice(-6)} | 1 piezas | | | ${barcode}`;
    this.quickCaptureForm.patchValue({
      rawText: currentText ? `${currentText}\n${barcodeLine}` : barcodeLine,
    });
    this.quickCapturePhotoStatus =
      'Código agregado al borrador. Revisa el nombre antes de guardar.';
  }

  toggleQuickCaptureVoice(): void {
    if (!this.voiceCaptureSupported || !this.speechRecognition) {
      this.voiceCaptureStatus = 'Dictado no disponible en este navegador.';
      return;
    }

    if (this.voiceCaptureListening) {
      this.speechRecognition.stop();
      return;
    }

    this.voiceCaptureListening = true;
    this.voiceCaptureStatus = 'Escuchando...';

    try {
      this.speechRecognition.start();
    } catch {
      this.voiceCaptureListening = false;
      this.voiceCaptureStatus = 'No se pudo iniciar dictado.';
    }
  }

  saveQuickCaptureDraft(): void {
    const rawText = this.quickCaptureForm.controls.rawText.value.trim();
    const items = this.parseQuickCaptureText(rawText);

    if (items.length === 0) {
      this.quickCaptureStatus =
        'Escribe al menos un producto para guardar el borrador.';
      return;
    }

    const draft: QuickCaptureDraft = {
      id: `${Date.now()}`,
      createdAt: new Date(),
      rawText,
      items,
    };

    this.quickCaptureDrafts = [draft, ...this.quickCaptureDrafts].slice(0, 8);
    this.quickCaptureForm.reset({ rawText: '' });
    this.quickCaptureStatus = this.isOffline
      ? 'Borrador guardado sin conexion.'
      : 'Borrador guardado para capturar cuando convenga.';
    this.persistQuickCaptureDrafts();
  }

  clearQuickCaptureDrafts(): void {
    this.quickCaptureDrafts = [];
    this.quickCaptureStatus = 'Borradores locales eliminados.';
    this.removeLocalValue(this.quickCaptureStorageKey);
  }

  useQuickCaptureItem(item: QuickCaptureItem): void {
    this.setSelectionMode('new');
    this.lotForm.patchValue(
      {
        newBaseName: item.name,
        unit: this.toKnownProductUnit(item.unit),
        quantity: item.quantity,
        shoppingLocation: item.shoppingLocation ?? '',
        estimatedUnitPrice: item.estimatedUnitPrice ?? null,
        shoppingNotes: item.barcode ? `Código: ${item.barcode}` : '',
        purchaseDate: toDateInputValue(new Date(), true),
      },
      { emitEvent: false }
    );

    if (isPlatformBrowser(this.platformId)) {
      document
        .querySelector('.register-panel')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  getQuickCaptureTotal(items: QuickCaptureItem[]): number {
    return Number(
      items
        .reduce(
          (sum, item) => sum + (item.estimatedUnitPrice ?? 0) * item.quantity,
          0
        )
        .toFixed(2)
    );
  }

  getPlanningSourceLabel(
    settings: ProductTypeEffectivePlanningSettings,
    key:
      | 'expirationWarningDays'
      | 'depletionWarningThresholdRatio'
      | 'shoppingPlanLeadDays'
  ): string {
    const source = settings[`${key}Source`];
    return source === 'productType' ? 'Este tipo' : 'Perfil';
  }

  getLotDisplayName(lot: PantryLotSummary): string {
    return lot.variantName?.trim() || `Lote ${lot.lotId}`;
  }

  getInventoryLotDisplayName(lot: InventoryLot): string {
    return lot.variantName?.trim() || `Lote ${lot.id}`;
  }

  private parseQuickCaptureLine(line: string): QuickCaptureItem | null {
    const [namePart, quantityPart, locationPart, pricePart, barcodePart] = line
      .split('|')
      .map((part) => part.trim());
    const name = namePart?.trim();

    if (!name) {
      return null;
    }

    const quantityMatch = (quantityPart ?? '').match(
      /^(\d+(?:[\.,]\d+)?)\s*(.*)$/
    );
    const quantity = quantityMatch
      ? Number(quantityMatch[1].replace(',', '.'))
      : 1;
    const unit = quantityMatch?.[2]?.trim() || 'piezas';
    const estimatedUnitPrice = this.toOptionalNumber(pricePart);
    const barcode = this.toOptionalText(barcodePart);

    const item: QuickCaptureItem = {
      name,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      unit,
      shoppingLocation: this.toOptionalText(locationPart),
      estimatedUnitPrice:
        estimatedUnitPrice === undefined
          ? undefined
          : Number(estimatedUnitPrice.toFixed(2)),
    };

    if (barcode) {
      item.barcode = barcode;
    }

    return item;
  }

  private parseQuickCaptureCsvHeaderRow(
    row: string[],
    header: string[]
  ): QuickCaptureItem | null {
    const getCell = (...names: string[]) => {
      const index = header.findIndex((cell) => names.includes(cell));
      return index === -1 ? '' : row[index]?.trim() ?? '';
    };
    const name = getCell('producto', 'product', 'nombre', 'name', 'item');

    if (!name) {
      return null;
    }

    const quantityText = getCell('cantidad', 'quantity');
    const unitText = getCell('unidad', 'unit');
    const quantityAndUnit = this.parseQuantityAndUnit(
      unitText ? `${quantityText} ${unitText}` : quantityText
    );
    const estimatedUnitPrice = this.toOptionalNumber(
      getCell('precio', 'price', 'precioestimado', 'estimatedunitprice')
    );
    const item: QuickCaptureItem = {
      name,
      quantity: quantityAndUnit.quantity,
      unit: quantityAndUnit.unit,
      shoppingLocation: this.toOptionalText(
        getCell('tienda', 'store', 'shoppinglocation')
      ),
      estimatedUnitPrice:
        estimatedUnitPrice === undefined
          ? undefined
          : Number(estimatedUnitPrice.toFixed(2)),
    };
    const barcode = this.toOptionalText(
      getCell('codigo', 'código', 'barcode', 'codigodebarras')
    );

    if (barcode) {
      item.barcode = barcode;
    }

    return item;
  }

  private parseQuickCaptureCsvIndexRow(row: string[]): QuickCaptureItem | null {
    const name = row[0]?.trim();

    if (!name) {
      return null;
    }

    const quantityAndUnit = this.parseQuantityAndUnit(
      row[2]?.trim() ? `${row[1] ?? ''} ${row[2]}` : row[1] ?? ''
    );
    const estimatedUnitPrice = this.toOptionalNumber(row[4]?.trim());
    const item: QuickCaptureItem = {
      name,
      quantity: quantityAndUnit.quantity,
      unit: quantityAndUnit.unit,
      shoppingLocation: this.toOptionalText(row[3]?.trim()),
      estimatedUnitPrice:
        estimatedUnitPrice === undefined
          ? undefined
          : Number(estimatedUnitPrice.toFixed(2)),
    };
    const barcode = this.toOptionalText(row[5]?.trim());

    if (barcode) {
      item.barcode = barcode;
    }

    return item;
  }

  private parseQuantityAndUnit(rawValue: string): {
    quantity: number;
    unit: string;
  } {
    const quantityMatch = rawValue
      .trim()
      .match(/^(\d+(?:[\.,]\d+)?)\s*(.*)$/);
    const quantity = quantityMatch
      ? Number(quantityMatch[1].replace(',', '.'))
      : 1;

    return {
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      unit: quantityMatch?.[2]?.trim() || 'piezas',
    };
  }

  private parseCsvRows(rawCsv: string, delimiter: ',' | ';'): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let insideQuotes = false;

    for (let index = 0; index < rawCsv.length; index += 1) {
      const char = rawCsv[index];
      const nextChar = rawCsv[index + 1];

      if (char === '"' && insideQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
        continue;
      }

      if (char === '"') {
        insideQuotes = !insideQuotes;
        continue;
      }

      if (char === delimiter && !insideQuotes) {
        row.push(cell);
        cell = '';
        continue;
      }

      if ((char === '\n' || char === '\r') && !insideQuotes) {
        if (char === '\r' && nextChar === '\n') {
          index += 1;
        }
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        continue;
      }

      cell += char;
    }

    row.push(cell);
    rows.push(row);

    return rows;
  }

  private detectCsvDelimiter(rawCsv: string): ',' | ';' {
    const firstLine = rawCsv.split(/\r?\n/, 1)[0] ?? '';
    const commaCount = (firstLine.match(/,/g) ?? []).length;
    const semicolonCount = (firstLine.match(/;/g) ?? []).length;

    return semicolonCount > commaCount ? ';' : ',';
  }

  private normalizeCsvHeader(value: string): string {
    return value
      .trim()
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  private buildQuickCaptureText(items: QuickCaptureItem[]): string {
    return items
      .map((item) => {
        const parts = [
          item.name,
          `${item.quantity} ${item.unit}`,
          item.shoppingLocation ?? '',
          item.estimatedUnitPrice === undefined
            ? ''
            : `${item.estimatedUnitPrice}`,
        ];

        if (item.barcode) {
          parts.push(item.barcode);
        }

        return parts.join(' | ');
      })
      .join('\n');
  }

  private escapeCsvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private downloadTextFile(
    content: string,
    filename: string,
    type: string
  ): void {
    const blob = new Blob([content], { type });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
  }

  private loadLocalShoppingSupport(): void {
    const storedBudget = this.getLocalValue(this.shoppingBudgetStorageKey);

    if (storedBudget) {
      try {
        const parsedBudget = Number(JSON.parse(storedBudget));

        if (Number.isFinite(parsedBudget) && parsedBudget >= 0) {
          this.shoppingBudget = Number(parsedBudget.toFixed(2));
          this.shoppingBudgetForm.patchValue(
            { amount: this.shoppingBudget },
            { emitEvent: false }
          );
        }
      } catch {
        this.shoppingBudget = null;
      }
    }

    const storedDrafts = this.getLocalValue(this.quickCaptureStorageKey);

    if (storedDrafts) {
      try {
        const parsedDrafts = JSON.parse(storedDrafts) as Array<
          Omit<QuickCaptureDraft, 'createdAt'> & { createdAt: string }
        >;
        this.quickCaptureDrafts = parsedDrafts.map((draft) => ({
          ...draft,
          createdAt: new Date(draft.createdAt),
        }));
      } catch {
        this.quickCaptureDrafts = [];
      }
    }

    const storedSavedLists = this.getLocalValue(
      this.savedShoppingListsStorageKey
    );

    if (storedSavedLists) {
      try {
        const parsedLists = JSON.parse(storedSavedLists) as Array<
          Omit<SavedShoppingList, 'createdAt' | 'updatedAt'> & {
            createdAt: string;
            updatedAt?: string;
          }
        >;
        this.savedShoppingLists = parsedLists
          .filter(
            (list) => list.ownerUserId === this.localStateOwnerUserId,
          )
          .map((list) => ({
            ...list,
            createdAt: new Date(list.createdAt),
            updatedAt: list.updatedAt
              ? new Date(list.updatedAt)
              : new Date(list.createdAt),
          }));
      } catch {
        this.savedShoppingLists = [];
      }
    }

    const storedTripDraft = this.getLocalValue(this.shoppingTripStorageKey);

    if (storedTripDraft) {
      try {
        const parsedItems = JSON.parse(
          storedTripDraft
        ) as ShoppingTripDraftItem[];
        this.shoppingTripDraft = parsedItems.reduce<
          Record<string, ShoppingTripDraftItem>
        >(
          (draft, item) => ({
            ...draft,
            [item.productTypeId]: item,
          }),
          {}
        );
      } catch {
        this.shoppingTripDraft = {};
      }
    }

    this.pendingShoppingCheckoutCount =
      this.loadPendingShoppingCheckouts().length;

    if (!this.isOffline) {
      this.flushPendingShoppingCheckouts();
    }
  }

  private loadSavedShoppingLists(): void {
    this.pantryService.listSavedShoppingLists().subscribe({
      next: (serverLists) => {
        const ownedServerLists = serverLists
          .filter(
            (list) =>
              !list.ownerUserId ||
              list.ownerUserId === this.localStateOwnerUserId,
          )
          .map((list) => ({
            ...list,
            ownerUserId:
              list.ownerUserId ?? this.localStateOwnerUserId ?? undefined,
          }));
        const localOnlyLists = this.savedShoppingLists.filter(
          (list) =>
            list.ownerUserId === this.localStateOwnerUserId &&
            !ownedServerLists.some((serverList) => serverList.id === list.id),
        );
        this.savedShoppingLists = [...ownedServerLists, ...localOnlyLists].slice(
          0,
          25,
        );
        this.persistSavedShoppingLists();
        this.changeDetector.markForCheck();
      },
      error: (error) => {
        this.savedShoppingListStatus = this.savedShoppingLists.length
          ? 'Listas locales disponibles; sincronización no disponible.'
          : this.getErrorMessage(error);
        this.changeDetector.markForCheck();
      },
    });
  }

  private setupVoiceCapture(): void {
    const recognitionWindow = window as Window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const recognitionConstructor =
      recognitionWindow.SpeechRecognition ??
      recognitionWindow.webkitSpeechRecognition;

    if (!recognitionConstructor) {
      this.voiceCaptureSupported = false;
      return;
    }

    this.speechRecognition = new recognitionConstructor();
    this.speechRecognition.lang = 'es-MX';
    this.speechRecognition.interimResults = false;
    this.speechRecognition.continuous = false;
    this.speechRecognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript.trim())
        .filter(Boolean)
        .join('\n');

      if (transcript) {
        const currentText = this.quickCaptureForm.controls.rawText.value.trim();
        this.quickCaptureForm.patchValue({
          rawText: currentText ? `${currentText}\n${transcript}` : transcript,
        });
        this.voiceCaptureStatus = 'Dictado agregado.';
      }

      this.changeDetector.markForCheck();
    };
    this.speechRecognition.onerror = () => {
      this.voiceCaptureListening = false;
      this.voiceCaptureStatus = 'No se pudo completar dictado.';
      this.changeDetector.markForCheck();
    };
    this.speechRecognition.onend = () => {
      this.voiceCaptureListening = false;
      this.changeDetector.markForCheck();
    };
    this.voiceCaptureSupported = true;
  }

  private setupBarcodeCapture(): void {
    const barcodeWindow = window as Window & {
      BarcodeDetector?: BarcodeDetectorConstructorLike;
    };

    this.barcodeCaptureSupported = Boolean(barcodeWindow.BarcodeDetector);
  }

  private async detectBarcodeFromImage(
    imageUrl: string
  ): Promise<string | null> {
    const barcodeWindow = window as Window & {
      BarcodeDetector?: BarcodeDetectorConstructorLike;
    };
    const BarcodeDetectorConstructor = barcodeWindow.BarcodeDetector;

    if (!BarcodeDetectorConstructor) {
      return null;
    }

    const image = await this.loadImageElement(imageUrl);
    const detector = new BarcodeDetectorConstructor({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'],
    });
    const results = await detector.detect(image);

    return results[0]?.rawValue?.trim() || null;
  }

  private loadImageElement(imageUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image_load_failed'));
      image.src = imageUrl;
    });
  }

  private revokeQuickCapturePhotoPreview(): void {
    if (!this.quickCapturePhotoPreviewUrl) {
      return;
    }

    URL.revokeObjectURL(this.quickCapturePhotoPreviewUrl);
    this.quickCapturePhotoPreviewUrl = null;
  }

  private watchNetworkState(): void {
    this.isOffline =
      typeof navigator !== 'undefined' ? !navigator.onLine : false;

    const setOnline = () => {
      this.isOffline = false;
      this.flushPendingShoppingCheckouts();
      this.changeDetector.markForCheck();
    };
    const setOffline = () => {
      this.isOffline = true;
      this.changeDetector.markForCheck();
    };

    window.addEventListener('online', setOnline);
    window.addEventListener('offline', setOffline);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', setOnline);
      window.removeEventListener('offline', setOffline);
    });
  }

  private persistQuickCaptureDrafts(): void {
    this.setLocalValue(
      this.quickCaptureStorageKey,
      JSON.stringify(this.quickCaptureDrafts)
    );
  }

  private persistSavedShoppingLists(): void {
    const ownedLists = this.savedShoppingLists.filter(
      (list) => list.ownerUserId === this.localStateOwnerUserId,
    );

    if (ownedLists.length === 0) {
      this.removeLocalValue(this.savedShoppingListsStorageKey);
      return;
    }

    this.setLocalValue(
      this.savedShoppingListsStorageKey,
      JSON.stringify(ownedLists),
    );
  }

  private resetSavedShoppingListForm(): void {
    this.savedShoppingListForm.reset({
      title: '',
      occasion: '',
      shoppingLocation: '',
    });
  }

  private removeSavedShoppingList(listId: string): void {
    this.savedShoppingLists = this.savedShoppingLists.filter(
      (list) => list.id !== listId,
    );
    this.persistSavedShoppingLists();
  }

  private ensureShoppingTripDraft(items: ShoppingTripSourceItem[]): void {
    this.shoppingTripDraft = items.reduce<
      Record<string, ShoppingTripDraftItem>
    >(
      (draft, item) => ({
        ...draft,
        [item.productTypeId]: this.getShoppingTripItem(item),
      }),
      {}
    );
    this.persistShoppingTripDraft();
  }

  private updateShoppingTripDraftItem(
    item: ShoppingTripSourceItem,
    patch: Partial<ShoppingTripDraftItem>
  ): void {
    this.shoppingTripDraft = {
      ...this.shoppingTripDraft,
      [item.productTypeId]: {
        ...this.getShoppingTripItem(item),
        ...patch,
        productTypeId: item.productTypeId,
        unit: item.defaultUnit,
      },
    };
    this.persistShoppingTripDraft();
  }

  private buildDefaultShoppingTripItem(
    item: ShoppingTripSourceItem
  ): ShoppingTripDraftItem {
    const metadata = this.resolveShoppingMetadata(item.shoppingMetadata);

    return {
      productTypeId: item.productTypeId,
      checked: false,
      quantity: item.suggestedPurchaseQuantity,
      unit: item.defaultUnit,
      paidUnitPrice: item.estimatedUnitPrice,
      shoppingLocation: metadata.shoppingLocation,
    };
  }

  private getSelectedShoppingTripItems(
    items: ShoppingTripSourceItem[]
  ): { planItem: ShoppingTripSourceItem; draft: ShoppingTripDraftItem }[] {
    return items
      .map((planItem) => ({
        planItem,
        draft: this.getShoppingTripItem(planItem),
      }))
      .filter((selection) => selection.draft.checked);
  }

  private buildShoppingTripRowsFromSavedList(
    list: SavedShoppingList,
    planItems: ShoppingPlanItem[],
  ): ShoppingTripSourceItem[] {
    return list.items.map((listItem) => {
      const matchingPlanItem = planItems.find(
        (item) => item.productTypeId === listItem.productTypeId,
      );
      const metadata = this.resolveShoppingMetadata(
        matchingPlanItem?.shoppingMetadata,
      );
      const shoppingLocation =
        listItem.shoppingLocation ?? list.shoppingLocation ?? metadata.shoppingLocation;
      const estimatedUnitPrice =
        listItem.estimatedUnitPrice ?? matchingPlanItem?.estimatedUnitPrice;
      const estimatedLineTotal =
        listItem.estimatedLineTotal ??
        (estimatedUnitPrice === undefined
          ? undefined
          : Number((estimatedUnitPrice * listItem.quantity).toFixed(2)));

      return {
        productTypeId: listItem.productTypeId,
        baseName: listItem.baseName,
        category: matchingPlanItem?.category,
        defaultUnit: listItem.unit,
        suggestedPurchaseQuantity: listItem.quantity,
        estimatedUnitPrice,
        estimatedLineTotal,
        urgency: matchingPlanItem?.urgency,
        shoppingMetadata: {
          ...metadata,
          shoppingLocation,
          estimatedUnitPrice,
        },
      };
    });
  }

  private persistShoppingTripDraft(): void {
    const draftItems = Object.values(this.shoppingTripDraft);

    if (draftItems.length === 0) {
      this.removeLocalValue(this.shoppingTripStorageKey);
      return;
    }

    this.setLocalValue(this.shoppingTripStorageKey, JSON.stringify(draftItems));
  }

  private buildCloseShoppingPurchaseItems(
    selectedItems: { draft: ShoppingTripDraftItem }[]
  ): CloseShoppingPurchaseItemRequest[] {
    return selectedItems.map(({ draft }) => ({
      productTypeId: draft.productTypeId,
      quantity: draft.quantity,
      unit: draft.unit,
      paidUnitPrice: draft.paidUnitPrice,
      shoppingLocation: draft.shoppingLocation,
    }));
  }

  private enqueuePendingShoppingCheckout(
    items: CloseShoppingPurchaseItemRequest[]
  ): PendingShoppingCheckout | null {
    if (!this.localStateOwnerUserId) {
      return null;
    }

    const pending = this.loadPendingShoppingCheckouts();
    const unresolved = pending.find(checkout => !checkout.queuedOffline);
    if (unresolved) {
      return !this.isExpiredMutation(unresolved.createdAt) &&
        JSON.stringify(unresolved.items) === JSON.stringify(items)
        ? unresolved
        : null;
    }

    const idempotencyKey = this.createIdempotencyKey();
    const pendingCheckout: PendingShoppingCheckout = {
      id: idempotencyKey,
      idempotencyKey,
      ownerUserId: this.localStateOwnerUserId,
      createdAt: new Date(),
      items,
      queuedOffline: this.isOffline,
    };

    const pendingCheckouts = [
      ...pending,
      pendingCheckout,
    ];

    if (
      !this.setLocalValue(
        this.pendingShoppingCheckoutStorageKey,
        JSON.stringify(pendingCheckouts),
      )
    ) {
      return null;
    }

    this.pendingShoppingCheckoutCount = pendingCheckouts.length;
    return pendingCheckout;
  }

  private flushPendingShoppingCheckouts(): void {
    if (this.isOffline || this.pendingShoppingCheckoutSyncing || this.shoppingCheckoutBusy) {
      return;
    }

    const pending = this.loadPendingShoppingCheckouts();
    const nextCheckout = pending.find(checkout => !this.isExpiredMutation(checkout.createdAt));

    if (!nextCheckout) {
      this.pendingShoppingCheckoutCount = pending.length;
      if (pending.length) {
        this.shoppingCheckoutStatus =
          'Hay cierres pendientes de hace más de siete días. Revisa la despensa antes de descartarlos y registrar lo que falte.';
      }
      return;
    }

    this.pendingShoppingCheckoutSyncing = true;
    this.pantryService
      .closeShoppingPurchase(
        { items: nextCheckout.items },
        nextCheckout.idempotencyKey,
      )
      .pipe(timeout(this.lotRegistrationTimeoutMs))
      .subscribe({
        next: (result) => {
          this.removePendingShoppingCheckout(nextCheckout.id);
          const remainingCheckouts = this.loadPendingShoppingCheckouts();
          if (remainingCheckouts.length === 0) {
            this.shoppingTripDraft = {};
            this.removeLocalValue(this.shoppingTripStorageKey);
          }
          this.shoppingCheckoutStatus = result.replayed
            ? 'Compra pendiente recuperada sin duplicados.'
            : remainingCheckouts.length
            ? `Compra sincronizada. Quedan ${remainingCheckouts.length} pendientes.`
            : 'Compra pendiente sincronizada.';
          this.loadOverview();
          this.pendingShoppingCheckoutSyncing = false;
          this.flushPendingShoppingCheckouts();
          this.changeDetector.markForCheck();
        },
        error: (error) => {
          this.pendingShoppingCheckoutSyncing = false;
          if (this.isMutationConflict(error)) {
            this.removePendingShoppingCheckout(nextCheckout.id);
            this.shoppingCheckoutStatus =
              'Una compra pendiente entró en conflicto con la despensa actual y no se reintentará automáticamente.';
            this.loadOverview();
            this.changeDetector.markForCheck();
            return;
          }

          this.shoppingCheckoutStatus = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  private loadPendingShoppingCheckouts(): PendingShoppingCheckout[] {
    const storedCheckouts = this.getLocalValue(
      this.pendingShoppingCheckoutStorageKey
    );

    if (!storedCheckouts) {
      return [];
    }

    try {
      const parsedCheckouts = JSON.parse(storedCheckouts) as Array<
        Omit<PendingShoppingCheckout, 'createdAt'> & { createdAt: string }
      >;

      return parsedCheckouts
        .filter(
          (checkout) =>
            checkout.ownerUserId === this.localStateOwnerUserId &&
            this.isUuid(checkout.idempotencyKey) && Array.isArray(checkout.items),
        )
        .map((checkout) => ({
          ...checkout,
          createdAt: new Date(checkout.createdAt),
        }));
    } catch {
      return [];
    }
  }

  private persistPendingShoppingCheckouts(
    checkouts: PendingShoppingCheckout[]
  ): void {
    this.pendingShoppingCheckoutCount = checkouts.length;

    if (checkouts.length === 0) {
      this.removeLocalValue(this.pendingShoppingCheckoutStorageKey);
      return;
    }

    this.setLocalValue(
      this.pendingShoppingCheckoutStorageKey,
      JSON.stringify(checkouts)
    );
  }

  private async requestShoppingWakeLock(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    const wakeLockNavigator = navigator as Navigator & {
      wakeLock?: {
        request: (type: 'screen') => Promise<ScreenWakeLock>;
      };
    };

    if (!wakeLockNavigator.wakeLock) {
      return;
    }

    try {
      this.shoppingWakeLock = await wakeLockNavigator.wakeLock.request(
        'screen'
      );
    } catch {
      this.shoppingCheckoutStatus =
        'Modo compra activo; este navegador puede bloquear pantalla.';
    }
  }

  private async releaseShoppingWakeLock(): Promise<void> {
    if (!this.shoppingWakeLock) {
      return;
    }

    try {
      await this.shoppingWakeLock.release();
    } catch {
      // Wake Lock is best effort only.
    } finally {
      this.shoppingWakeLock = null;
    }
  }

  private getLocalValue(key: string): string | null {
    const scopedKey = this.getUserScopedStorageKey(key);

    if (!isPlatformBrowser(this.platformId) || !scopedKey) {
      return null;
    }

    try {
      const storedValue = localStorage.getItem(scopedKey);

      if (storedValue !== null) {
        return this.readOwnedLocalStateEnvelope(storedValue);
      }

      return this.migrateOwnedLegacyLocalValue(key);
    } catch {
      return null;
    }
  }

  private removePendingShoppingCheckout(checkoutId: string): void {
    this.persistPendingShoppingCheckouts(
      this.loadPendingShoppingCheckouts().filter(
        (checkout) => checkout.id !== checkoutId,
      ),
    );
  }

  private getOrCreateInventoryMutationKey(
    actionId: string,
    payloadFingerprint: string,
  ): string {
    const pendingMutations = this.loadPendingInventoryMutations();
    const existingMutation = pendingMutations.find(
      (mutation) =>
        mutation.actionId === actionId,
    );

    if (existingMutation) {
      if (this.isExpiredMutation(existingMutation.createdAt)) {
        this.completeInventoryMutation(actionId, existingMutation.idempotencyKey);
        throw new UserFacingError('Este intento tiene más de siete días. Revisa el inventario actualizado antes de realizar una nueva acción.');
      }
      if (existingMutation.payloadFingerprint !== payloadFingerprint) {
        this.completeInventoryMutation(actionId, existingMutation.idempotencyKey);
        throw new UserFacingError('La acción anterior no está confirmada. Revisa el inventario actualizado antes de cambiar la cantidad.');
      }
      return existingMutation.idempotencyKey;
    }

    const idempotencyKey = this.createIdempotencyKey();
    const nextMutations = [
      ...pendingMutations.filter((mutation) => mutation.actionId !== actionId),
      {
        actionId,
        payloadFingerprint,
        idempotencyKey,
        createdAt: new Date(),
      },
    ];
    if (!this.setLocalValue(
      this.pendingInventoryMutationStorageKey,
      JSON.stringify(nextMutations),
    )) {
      throw new UserFacingError('No se pudo guardar el intento en este navegador. Revisa el almacenamiento e intenta de nuevo.');
    }

    return idempotencyKey;
  }

  private completeInventoryMutation(
    actionId: string,
    idempotencyKey: string,
  ): void {
    const remainingMutations = this.loadPendingInventoryMutations().filter(
      (mutation) =>
        mutation.actionId !== actionId ||
        mutation.idempotencyKey !== idempotencyKey,
    );

    if (remainingMutations.length === 0) {
      this.removeLocalValue(this.pendingInventoryMutationStorageKey);
      return;
    }

    this.setLocalValue(
      this.pendingInventoryMutationStorageKey,
      JSON.stringify(remainingMutations),
    );
  }

  private loadPendingInventoryMutations(): PendingInventoryMutation[] {
    const storedMutations = this.getLocalValue(
      this.pendingInventoryMutationStorageKey,
    );

    if (!storedMutations) {
      return [];
    }

    try {
      const parsedMutations = JSON.parse(storedMutations) as Array<
        Omit<PendingInventoryMutation, 'createdAt'> & { createdAt: string }
      >;

      return parsedMutations
        .filter(
          (mutation) =>
            typeof mutation.actionId === 'string' &&
            typeof mutation.payloadFingerprint === 'string' &&
            this.isUuid(mutation.idempotencyKey),
        )
        .map((mutation) => ({
          ...mutation,
          createdAt: new Date(mutation.createdAt),
        }));
    } catch {
      return [];
    }
  }

  get hasExpiredPendingCheckouts(): boolean {
    return this.loadPendingShoppingCheckouts().some(checkout => this.isExpiredMutation(checkout.createdAt));
  }

  discardExpiredPendingCheckouts(): void {
    this.persistPendingShoppingCheckouts(
      this.loadPendingShoppingCheckouts().filter(checkout => !this.isExpiredMutation(checkout.createdAt)),
    );
    this.shoppingCheckoutStatus = 'Cierres vencidos descartados. Registra solo los productos que falten en tu despensa.';
    this.loadOverview();
  }

  private isExpiredMutation(createdAt: Date): boolean {
    const age = Date.now() - createdAt.getTime();
    return !Number.isFinite(age) || age < 0 || age >= IDEMPOTENCY_RECEIPT_TTL_MS;
  }

  private createIdempotencyKey(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  private isUuid(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    );
  }

  private setLocalValue(key: string, value: string): boolean {
    const scopedKey = this.getUserScopedStorageKey(key);

    if (!isPlatformBrowser(this.platformId) || !scopedKey) {
      return false;
    }

    try {
      const envelope: UserScopedLocalStateEnvelope = {
        version: 1,
        ownerUserId: this.localStateOwnerUserId!,
        payload: value,
      };
      localStorage.setItem(scopedKey, JSON.stringify(envelope));
      return true;
    } catch {
      this.quickCaptureStatus =
        'No se pudo guardar en este navegador; conserva el texto manualmente.';
      return false;
    }
  }

  private removeLocalValue(key: string): void {
    const scopedKey = this.getUserScopedStorageKey(key);

    if (!isPlatformBrowser(this.platformId) || !scopedKey) {
      return;
    }

    try {
      localStorage.removeItem(scopedKey);
    } catch {
      // Local persistence is a convenience; failing closed keeps the app usable.
    }
  }

  private getUserScopedStorageKey(key: string): string | null {
    return this.localStateOwnerUserId
      ? `${key}.v2.${encodeURIComponent(this.localStateOwnerUserId)}`
      : null;
  }

  private readOwnedLocalStateEnvelope(rawValue: string): string | null {
    try {
      const envelope = JSON.parse(
        rawValue,
      ) as Partial<UserScopedLocalStateEnvelope>;

      return envelope.version === 1 &&
        envelope.ownerUserId === this.localStateOwnerUserId &&
        typeof envelope.payload === 'string'
        ? envelope.payload
        : null;
    } catch {
      return null;
    }
  }

  private migrateOwnedLegacyLocalValue(key: string): string | null {
    const legacyValue = localStorage.getItem(key);

    if (legacyValue === null) {
      return null;
    }

    try {
      const parsedValue: unknown = JSON.parse(legacyValue);

      if (this.isUserScopedLocalStateEnvelope(parsedValue)) {
        if (parsedValue.ownerUserId !== this.localStateOwnerUserId) {
          return null;
        }

        this.setLocalValue(key, parsedValue.payload);
        return parsedValue.payload;
      }

      if (
        Array.isArray(parsedValue) &&
        (key === this.savedShoppingListsStorageKey ||
          key === this.pendingShoppingCheckoutStorageKey)
      ) {
        const ownedEntries = parsedValue.filter(
          (entry) =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            (entry as { ownerUserId?: unknown }).ownerUserId ===
              this.localStateOwnerUserId,
        );

        if (ownedEntries.length > 0) {
          const ownedPayload = JSON.stringify(ownedEntries);
          this.setLocalValue(key, ownedPayload);
          return ownedPayload;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private isUserScopedLocalStateEnvelope(
    value: unknown,
  ): value is UserScopedLocalStateEnvelope {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const envelope = value as Partial<UserScopedLocalStateEnvelope>;
    return (
      envelope.version === 1 &&
      typeof envelope.ownerUserId === 'string' &&
      typeof envelope.payload === 'string'
    );
  }

  private toKnownProductUnit(unit: string): ProductUnit {
    return PRODUCT_UNITS.includes(unit as ProductUnit)
      ? (unit as ProductUnit)
      : 'piezas';
  }

  private resetLotForm(): void {
    this.selectedExistingType = null;
    this.lotForm.reset({
      selectionMode: 'existing',
      existingTypeSearch: '',
      existingProductTypeId: '',
      newBaseName: '',
      category: 'food',
      unit: 'piezas',
      storageLocation: '',
      shoppingLocation: '',
      preferredBrand: '',
      substituteBrand: '',
      householdStaple: false,
      buyOnlyOnPromo: false,
      replenishWhenLow: true,
      shoppingNotes: '',
      estimatedUnitPrice: null,
      variantName: '',
      quantity: 1,
      expiresAt: '',
      purchaseDate: '',
      enableDurability: false,
      depletionConsumeAmount: 1,
      depletionEveryAmount: 1,
      depletionEveryPeriod: 'month',
      depletionAnchorDate: toDateInputValue(new Date(), true),
    });
  }

  private loadOverview(): void {
    this.store.dispatch(PantryActions.loadPantryOverview());
  }

  private buildPlanningSettingsRequest(): ProductTypePlanningSettingsRequest {
    const rawValue = this.planningSettingsForm.getRawValue();

    return {
      planningEnabled: rawValue.planningEnabled ?? true,
      expirationWarningDaysOverride: this.toOptionalNumber(
        rawValue.expirationWarningDaysOverride
      ),
      depletionWarningThresholdRatioOverride: this.toOptionalNumber(
        rawValue.depletionWarningThresholdRatioOverride
      ),
      shoppingPlanLeadDaysOverride: this.toOptionalNumber(
        rawValue.shoppingPlanLeadDaysOverride
      ),
    };
  }

  private buildShoppingMetadataRequest(rawValue: {
    storageLocation?: string;
    shoppingLocation?: string;
    preferredBrand?: string;
    substituteBrand?: string;
    householdStaple?: boolean;
    buyOnlyOnPromo?: boolean;
    replenishWhenLow?: boolean;
    shoppingNotes?: string;
    estimatedUnitPrice?: number | string | null;
  }): ProductTypeShoppingMetadataRequest {
    const estimatedUnitPrice = this.toOptionalNumber(
      rawValue.estimatedUnitPrice
    );
    const metadata: ProductTypeShoppingMetadataRequest = {
      storageLocation: this.toOptionalText(rawValue.storageLocation),
      shoppingLocation: this.toOptionalText(rawValue.shoppingLocation),
      preferredBrand: this.toOptionalText(rawValue.preferredBrand),
      substituteBrand: this.toOptionalText(rawValue.substituteBrand),
      householdStaple: rawValue.householdStaple ?? false,
      buyOnlyOnPromo: rawValue.buyOnlyOnPromo ?? false,
      replenishWhenLow: rawValue.replenishWhenLow ?? true,
      shoppingNotes: this.toOptionalText(rawValue.shoppingNotes),
    };

    if (estimatedUnitPrice !== undefined) {
      metadata.estimatedUnitPrice = Number(estimatedUnitPrice.toFixed(2));
    }

    return metadata;
  }

  private buildDefaultDepletionRule(
    rawValue: ReturnType<typeof this.lotForm.getRawValue>,
    unit: ProductUnit
  ): ProductTypeDepletionRuleRequest | undefined {
    if (!rawValue.enableDurability) {
      return undefined;
    }

    const consumeAmount = Number(rawValue.depletionConsumeAmount);
    const everyAmount = Number(rawValue.depletionEveryAmount);

    if (!Number.isFinite(consumeAmount) || consumeAmount <= 0) {
      this.submittingLot = false;
      this.registerError = 'La cantidad de durabilidad debe ser mayor a cero.';
      return undefined;
    }

    if (!Number.isFinite(everyAmount) || everyAmount <= 0) {
      this.submittingLot = false;
      this.registerError = 'El intervalo de durabilidad debe ser mayor a cero.';
      return undefined;
    }

    if (!rawValue.depletionAnchorDate) {
      this.submittingLot = false;
      this.registerError = 'Define desde que fecha empieza la durabilidad.';
      return undefined;
    }

    return {
      enabled: true,
      consumeAmount: Number(consumeAmount.toFixed(2)),
      unit,
      everyAmount,
      everyPeriod: rawValue.depletionEveryPeriod,
      anchorDate: rawValue.depletionAnchorDate,
    };
  }

  private buildEditedDepletionRule(
    unit: ProductUnit
  ): ProductTypeDepletionRuleRequest | undefined {
    const rawValue = this.depletionRuleForm.getRawValue();

    if (!rawValue.enabled) {
      return {
        enabled: false,
        consumeAmount: 1,
        unit,
        everyAmount: 1,
        everyPeriod: 'month',
        anchorDate: rawValue.anchorDate || toDateInputValue(new Date(), true),
      };
    }

    if (this.depletionRuleForm.invalid) {
      this.depletionRuleForm.markAllAsTouched();
      this.depletionRuleError = 'Revisa la durabilidad antes de guardarla.';
      return undefined;
    }

    const consumeAmount = Number(rawValue.consumeAmount);
    const everyAmount = Number(rawValue.everyAmount);

    if (!Number.isFinite(consumeAmount) || consumeAmount <= 0) {
      this.depletionRuleError =
        'La cantidad de durabilidad debe ser mayor a cero.';
      return undefined;
    }

    if (!Number.isFinite(everyAmount) || everyAmount <= 0) {
      this.depletionRuleError =
        'El intervalo de durabilidad debe ser mayor a cero.';
      return undefined;
    }

    return {
      enabled: true,
      consumeAmount: Number(consumeAmount.toFixed(2)),
      unit,
      everyAmount,
      everyPeriod: rawValue.everyPeriod,
      anchorDate: rawValue.anchorDate,
    };
  }

  private patchDepletionRuleControls(productType: ProductType): void {
    const rule = productType.defaultDepletionRule;

    this.lotForm.patchValue(
      {
        enableDurability: Boolean(rule?.enabled),
        depletionConsumeAmount: rule?.consumeAmount ?? 1,
        depletionEveryAmount: rule?.everyAmount ?? 1,
        depletionEveryPeriod: rule?.everyPeriod ?? 'month',
        depletionAnchorDate: rule?.anchorDate
          ? toDateInputValue(rule.anchorDate)
          : toDateInputValue(new Date(), true),
      },
      { emitEvent: false }
    );
  }

  private getErrorMessage(error: unknown): string {
    return getUserErrorMessage(error);
  }

  private isMutationConflict(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 409;
  }

  private runMutation(
    busyKey: string,
    request: Observable<unknown>,
    options: { refreshArchived?: boolean } = {}
  ): void {
    if (this.mutationBusyKey) {
      return;
    }

    this.mutationBusyKey = busyKey;
    this.archivedError = null;

    request
      .pipe(
        finalize(() => {
          this.mutationBusyKey = null;
          this.changeDetector.markForCheck();
        })
      )
      .subscribe({
        next: () => {
          this.loadOverview();

          if (options.refreshArchived || this.archivedPanelOpen) {
            this.loadArchivedItems();
          }
        },
        error: (error) => {
          this.archivedError = this.getErrorMessage(error);
          this.changeDetector.markForCheck();
        },
      });
  }

  private startArchiveConfirmation(target: ArchiveConfirmationTarget): void {
    this.archiveConfirmationTarget = target;
    this.archivedError = null;
  }

  private clearArchiveConfirmation(): void {
    this.archiveConfirmationTarget = null;
  }

  private mergeArchivedItems(
    current: ArchivedPantryItems | null,
    next: ArchivedPantryItems,
  ): ArchivedPantryItems {
    if (!current) {
      return next;
    }

    return {
      productTypes: [...current.productTypes, ...next.productTypes],
      inventoryLots: [...current.inventoryLots, ...next.inventoryLots],
      pagination: next.pagination,
    };
  }

  private startDeleteConfirmation(target: DeleteConfirmationTarget): void {
    this.deleteConfirmationTarget = target;
    this.deleteConfirmationInput = '';
    this.deleteConfirmationError = null;
    this.archivedError = null;
  }

  private clearDeleteConfirmation(): void {
    this.deleteConfirmationTarget = null;
    this.deleteConfirmationInput = '';
    this.deleteConfirmationError = null;
  }

  private toOptionalNumber(
    value: number | string | null | undefined
  ): number | undefined {
    if (value === null || value === undefined || value === '') {
      return undefined;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  private toOptionalText(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private toWasteReason(value: string | undefined): WasteReason | undefined {
    return this.wasteReasonOptions.includes(value as WasteReason)
      ? (value as WasteReason)
      : undefined;
  }

  private resolveShoppingMetadata(
    metadata: ProductTypeShoppingMetadata | undefined
  ): ProductTypeShoppingMetadata {
    return {
      ...metadata,
      householdStaple: metadata?.householdStaple ?? false,
      buyOnlyOnPromo: metadata?.buyOnlyOnPromo ?? false,
      replenishWhenLow: metadata?.replenishWhenLow ?? true,
    };
  }

  private groupShoppingPlanByRoute(
    items: ShoppingPlanItem[]
  ): { location: string; items: ShoppingPlanItem[] }[] {
    const grouped = new Map<string, ShoppingPlanItem[]>();

    for (const item of items) {
      const location =
        this.resolveShoppingMetadata(item.shoppingMetadata).shoppingLocation ||
        'Sin tienda definida';
      grouped.set(location, [...(grouped.get(location) ?? []), item]);
    }

    return Array.from(grouped.entries())
      .map(([location, groupedItems]) => ({
        location,
        items: groupedItems,
      }))
      .sort((left, right) => {
        const rankDifference =
          this.getShoppingLocationRank(left.location) -
          this.getShoppingLocationRank(right.location);

        if (rankDifference !== 0) {
          return rankDifference;
        }

        return left.location.localeCompare(right.location, 'es', {
          sensitivity: 'base',
        });
      });
  }

  private getShoppingLocationRank(location: string): number {
    const normalized = location.trim().toLocaleLowerCase('es');
    const index = SHOPPING_LOCATION_ORDER.findIndex(
      (candidate) => candidate.trim().toLocaleLowerCase('es') === normalized,
    );

    return index === -1 ? SHOPPING_LOCATION_ORDER.length : index;
  }

  private hasShoppingPriceEstimate(items: ShoppingPlanItem[]): boolean {
    return items.some((item) => item.estimatedLineTotal !== undefined);
  }

  private hasMissingShoppingPrices(items: ShoppingPlanItem[]): boolean {
    return items.some((item) => item.estimatedLineTotal === undefined);
  }

  private getUseFirstPriority(status: ExpirationStatus): number {
    switch (status) {
      case 'expired':
        return 0;
      case 'critical':
        return 1;
      case 'soon':
        return 2;
      default:
        return 3;
    }
  }

  private getUseFirstReason(lot: PantryLotSummary): string {
    switch (lot.expirationStatus) {
      case 'expired':
        return 'Ya caducó';
      case 'critical':
        return 'Caduca hoy';
      case 'soon':
        return 'Caduca pronto';
      default:
        return 'Revisar';
    }
  }

  private getEstimatedLotValue(
    group: PantryOverviewItem | undefined,
    lot: PantryLotSummary
  ): number | undefined {
    const estimatedUnitPrice = group?.shoppingMetadata?.estimatedUnitPrice;

    return estimatedUnitPrice === undefined
      ? undefined
      : Number((estimatedUnitPrice * lot.quantity).toFixed(2));
  }

  private sumLotsByStatus(
    lots: PantryLotSummary[],
    statuses: ExpirationStatus[]
  ): number {
    return Number(
      lots
        .filter((lot) => statuses.includes(lot.expirationStatus))
        .reduce(
          (sum, lot) =>
            Number.isFinite(lot.quantity) ? sum + lot.quantity : sum,
          0
        )
        .toFixed(2)
    );
  }
}

export function toDateInputValue(date: Date, localDate = false): string {
  if (localDate) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  return date.toISOString().slice(0, 10);
}
