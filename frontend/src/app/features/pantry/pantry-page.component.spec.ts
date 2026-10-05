import { HttpClientTestingModule } from '@angular/common/http/testing';
import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
} from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import {
  BehaviorSubject,
  NEVER,
  of,
  Subject,
  throwError,
  TimeoutError,
} from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { Store } from '@ngrx/store';
import { AuthFacade } from '../../core/services/auth.facade';
import { PantryPageComponent, toDateInputValue } from './pantry-page.component';
import { PantryService } from '../../core/services/pantry.service';
import { AuthUser } from '../../shared/models/auth.model';
import {
  InventoryLot,
  PantryLotSummary,
  PantryOverviewItem,
  PantryStapleItem,
  PantryValueInsights,
  PriceReferenceItem,
  ProductType,
  SavedShoppingList,
  ShoppingShare,
  ShoppingPlanItem,
  WasteEventSummary,
} from '../../shared/models/pantry.model';
import {
  selectExpiredEntryAlert,
  selectPantryInitialLoading,
  selectShoppingPlanItems,
} from '../../store/pantry/pantry.selectors';

describe('PantryPageComponent', () => {
  it('keeps Mexico City today separate from stored UTC civil dates', () => {
    const instant = new Date('2026-09-26T04:30:00.000Z');
    expect(toDateInputValue(instant, true)).toBe('2026-09-25');
    expect(toDateInputValue(instant)).toBe('2026-09-26');
  });

  it('uses the Mexico City date when UTC has already reached tomorrow', () => {
    const instant = new Date('2026-10-05T00:30:00.000Z');
    spyOn(instant, 'getDate').and.returnValue(5); // Simulate a browser east of Mexico City.

    expect(toDateInputValue(instant, true)).toBe('2026-10-04');
    expect(toDateInputValue(instant)).toBe('2026-10-05');
  });
  let fixture: ComponentFixture<PantryPageComponent>;
  let component: PantryPageComponent;
  let pantryService: jasmine.SpyObj<PantryService>;
  let authFacade: AuthFacadeStub;
  let store: { select: jasmine.Spy; dispatch: jasmine.Spy };

  beforeEach(async () => {
    clearPantryLocalState();
    pantryService = jasmine.createSpyObj<PantryService>('PantryService', [
      'searchProductTypes',
      'registerLot',
      'consumeInventoryLot',
      'updateProductTypeDepletionRule',
      'updateProductTypePlanningSettings',
      'updateProductTypeShoppingMetadata',
      'archiveProductType',
      'restoreProductType',
      'deleteProductType',
      'archiveInventoryLot',
      'restoreInventoryLot',
      'deleteInventoryLot',
      'getArchivedPantryItems',
      'closeShoppingPurchase',
      'createShoppingShare',
      'listSavedShoppingLists',
      'createSavedShoppingList',
      'deleteSavedShoppingList',
      'listActiveShoppingShares',
      'revokeShoppingShareById',
      'revokeShoppingShare',
      'getWasteOverview',
    ]);
    pantryService.searchProductTypes.and.returnValue(of([]));
    pantryService.registerLot.and.returnValue(of({} as any));
    pantryService.consumeInventoryLot.and.returnValue(of(makeConsumeResult()));
    pantryService.updateProductTypeDepletionRule.and.returnValue(of({} as any));
    pantryService.updateProductTypePlanningSettings.and.returnValue(
      of({} as any),
    );
    pantryService.updateProductTypeShoppingMetadata.and.returnValue(
      of({} as any),
    );
    pantryService.archiveProductType.and.returnValue(of({} as any));
    pantryService.restoreProductType.and.returnValue(of({} as any));
    pantryService.deleteProductType.and.returnValue(of(undefined));
    pantryService.archiveInventoryLot.and.returnValue(of({} as any));
    pantryService.restoreInventoryLot.and.returnValue(of({} as any));
    pantryService.deleteInventoryLot.and.returnValue(of(undefined));
    pantryService.getArchivedPantryItems.and.returnValue(
      of({ productTypes: [], inventoryLots: [] }),
    );
    pantryService.closeShoppingPurchase.and.returnValue(of(makeCheckoutResult()));
    pantryService.listSavedShoppingLists.and.returnValue(of([]));
    pantryService.createSavedShoppingList.and.callFake((request) =>
      of({
        id: 'list-server-1',
        ownerUserId: 'tester',
        ...request,
        createdAt: new Date('2026-06-09T00:00:00.000Z'),
        updatedAt: new Date('2026-06-09T00:00:00.000Z'),
      } as SavedShoppingList),
    );
    pantryService.deleteSavedShoppingList.and.returnValue(
      of({
        id: 'list-server-1',
        ownerUserId: 'tester',
        title: 'Mayoreo semanal',
        createdAt: new Date('2026-06-09T00:00:00.000Z'),
        updatedAt: new Date('2026-06-09T00:00:00.000Z'),
        items: [],
      }),
    );
    pantryService.listActiveShoppingShares.and.returnValue(
      of([
        {
          id: 'share-active-1',
          createdAt: new Date('2026-05-19T00:00:00.000Z'),
          expiresAt: new Date('2026-05-26T18:00:00.000Z'),
          revokedAt: null,
        },
      ]),
    );
    pantryService.createShoppingShare.and.returnValue(
      of({
        id: 'share-active-2',
        token: 'opaque-token',
        createdAt: new Date('2026-05-19T00:00:00.000Z'),
        expiresAt: new Date('2026-05-26T00:00:00.000Z'),
        revokedAt: null,
      }),
    );
    pantryService.revokeShoppingShare.and.returnValue(
      of({
        createdAt: new Date('2026-05-19T00:00:00.000Z'),
        expiresAt: new Date('2026-05-26T00:00:00.000Z'),
        revokedAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    );
    pantryService.revokeShoppingShareById.and.returnValue(
      of({
        id: 'share-active-1',
        createdAt: new Date('2026-05-19T00:00:00.000Z'),
        expiresAt: new Date('2026-05-26T18:00:00.000Z'),
        revokedAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    );
    pantryService.getWasteOverview.and.returnValue(
      of({
        userId: 'tester',
        generatedAt: new Date('2026-06-09T00:00:00.000Z'),
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
            occurredAt: new Date('2026-06-09T00:00:00.000Z'),
          },
        ],
      }),
    );
    authFacade = new AuthFacadeStub();
    store = {
      select: jasmine.createSpy('select').and.returnValue(of(null)),
      dispatch: jasmine.createSpy('dispatch'),
    };

    await TestBed.configureTestingModule({
      declarations: [PantryPageComponent],
      imports: [
        HttpClientTestingModule,
        ReactiveFormsModule,
        RouterTestingModule,
      ],
      providers: [
        {
          provide: PantryService,
          useValue: pantryService,
        },
        {
          provide: AuthFacade,
          useValue: authFacade,
        },
        {
          provide: Store,
          useValue: store,
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    clearPantryLocalState();
  });

  it('resets the unit when switching from an existing type to a new type', () => {
    const existingType: ProductType = {
      id: 'type-1',
      userId: 'tester',
      baseName: 'Atun',
      category: 'food',
      defaultUnit: 'kg',
      planningSettings: {
        planningEnabled: true,
      },
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    component.selectExistingProductType(existingType);
    component.setSelectionMode('new');

    expect(component.selectedExistingType).toBeNull();
    expect(component.lotForm.controls.unit.value).toBe('piezas');
  });

  it('prevents a second consume request while one is already in flight', () => {
    const pendingRequest = new Subject<ReturnType<typeof makeConsumeResult>>();
    pantryService.consumeInventoryLot.and.returnValue(pendingRequest);

    component.consumeLot('lot-1', 1);
    component.consumeLot('lot-2', 1);

    expect(pantryService.consumeInventoryLot.calls.count()).toBe(1);
    expect(pantryService.consumeInventoryLot.calls.argsFor(0)).toEqual([
      'lot-1',
      {
        quantity: 1,
      },
      jasmine.any(String),
    ]);
  });

  it('sends waste metadata when consuming a lot as waste', () => {
    component.consumeLot('lot-1', 1, 'expired', 'Fecha vencida');

    expect(pantryService.consumeInventoryLot).toHaveBeenCalledWith(
      'lot-1',
      {
        quantity: 1,
        wasteReason: 'expired',
        wasteNote: 'Fecha vencida',
      },
      jasmine.any(String),
    );
    expect(pantryService.getWasteOverview).toHaveBeenCalled();
  });

  it('persists and reuses the same consume idempotency key after a timeout', () => {
    pantryService.consumeInventoryLot.and.returnValue(
      throwError(() => new TimeoutError()),
    );

    component.consumeLot('lot-1', 1, 'expired', 'Fecha vencida');
    const firstKey = (pantryService.consumeInventoryLot.calls.argsFor(0) as any[])[2] as
      | string
      | undefined;

    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    pantryService.consumeInventoryLot.and.returnValue(of(makeConsumeResult()));
    component.consumeLot('lot-1', 1, 'expired', 'Fecha vencida');

    expect((pantryService.consumeInventoryLot.calls.argsFor(1) as any[])[2]).toBe(
      firstKey,
    );
  });

  it('refreshes inventory and asks for a new action after an idempotency conflict', () => {
    store.dispatch.calls.reset();
    pantryService.consumeInventoryLot.and.returnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { message: 'Conditional request failed' },
          }),
      ),
    );

    component.consumeLot('lot-1', 1);

    expect(component.consumeErrors['lot-1']).toContain(
      'La despensa cambió mientras realizabas esta acción',
    );
    expect(store.dispatch).toHaveBeenCalled();
  });

  it('requires review before resubmitting an expired consume receipt', () => {
    pantryService.consumeInventoryLot.and.returnValue(throwError(() => new TimeoutError()));
    component.consumeLot('lot-1', 1);
    const pending = (component as any).loadPendingInventoryMutations();
    pending[0].createdAt = new Date(Date.now() - 8 * 86400000);
    (component as any).setLocalValue('despensalista.pendingInventoryMutations', JSON.stringify(pending));
    component.consumeLot('lot-1', 1);
    expect(pantryService.consumeInventoryLot).toHaveBeenCalledTimes(1);
    expect(component.consumeErrors['lot-1']).toContain('siete días');
  });

  it('does not consume when its retry key cannot be persisted', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('quota exceeded');
    component.consumeLot('lot-1', 1);
    expect(pantryService.consumeInventoryLot).not.toHaveBeenCalled();
    expect(component.consumeErrors['lot-1']).toContain('guardar');
  });

  it('shows when a consume result was safely replayed', () => {
    pantryService.consumeInventoryLot.and.returnValue(
      of({
        value: null,
        idempotencyKey: '9b29fb9a-ce30-473f-abaf-f8d987634f55',
        replayed: true,
      } as any),
    );

    component.consumeLot('lot-1', 1);

    expect((component as any).consumeNotices['lot-1']).toContain(
      'ya se había completado',
    );
  });

  it('renders an explicit label for the existing type search input', () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const label = compiled.querySelector('label[for="existingTypeSearch"]');
    const input = compiled.querySelector<HTMLInputElement>(
      '#existingTypeSearch',
    );

    expect(label?.textContent).toContain('Busca el tipo base');
    expect(input).not.toBeNull();
  });

  it('shows an initial loading shell instead of empty pantry states while the overview is loading', () => {
    store.select.and.callFake((selector) => {
      if (selector === selectPantryInitialLoading) {
        return of(true);
      }

      return of(null);
    });

    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('Cargando despensa');
    expect(compiled.textContent).not.toContain(
      'No hay lotes urgentes por ahora.',
    );
  });

  it('shows a neutral lot unit preview until an existing type is selected', () => {
    component.setSelectionMode('existing');
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const unitPreview =
      compiled.querySelector<HTMLInputElement>('#lotUnitPreview');

    expect(unitPreview?.value).toBe('Selecciona un tipo base');
  });

  it('includes a product type depletion rule when registering a new durable product', () => {
    component.setSelectionMode('new');
    component.lotForm.patchValue({
      newBaseName: 'Detergente liquido',
      category: 'cleaning',
      unit: 'lt',
      quantity: 3,
      enableDurability: true,
      depletionConsumeAmount: 1,
      depletionEveryAmount: 1,
      depletionEveryPeriod: 'month',
      depletionAnchorDate: '2026-04-24',
    } as any);

    component.submitLot();

    expect(pantryService.registerLot).toHaveBeenCalledWith(
      jasmine.objectContaining({
        newProductType: jasmine.objectContaining({
          defaultDepletionRule: {
            enabled: true,
            consumeAmount: 1,
            unit: 'lt',
            everyAmount: 1,
            everyPeriod: 'month',
            anchorDate: '2026-04-24',
          },
        }),
      }),
    );
  });

  it('rejects a fractional depletion interval when registering a lot', () => {
    component.setSelectionMode('new');
    component.lotForm.patchValue({
      newBaseName: 'Arroz',
      category: 'food',
      unit: 'kg',
      quantity: 1,
      enableDurability: true,
      depletionEveryAmount: 1.5,
      depletionAnchorDate: '2026-10-04',
    });

    component.submitLot();

    expect(component.registerError).toBe(
      'El intervalo de durabilidad debe ser un número entero mayor a cero.',
    );
    expect(pantryService.registerLot).not.toHaveBeenCalled();
  });

  it('ignores a hidden fractional interval when durability is off', () => {
    component.setSelectionMode('new');
    component.lotForm.patchValue({
      newBaseName: 'Arroz',
      category: 'food',
      unit: 'kg',
      quantity: 1,
      enableDurability: false,
      depletionEveryAmount: 1.5,
    });

    component.submitLot();

    expect(pantryService.registerLot).toHaveBeenCalled();
  });

  it('includes LatAm shopping metadata when registering a new product type', () => {
    component.setSelectionMode('new');
    component.lotForm.patchValue({
      newBaseName: 'Frijol negro',
      category: 'food',
      unit: 'kg',
      quantity: 2,
      storageLocation: 'Despensa',
      shoppingLocation: 'Mercado',
      preferredBrand: 'Marca local',
      substituteBrand: 'Marca propia',
      householdStaple: true,
      buyOnlyOnPromo: true,
      replenishWhenLow: false,
      shoppingNotes: 'Comprar bolsa grande si esta en promo',
      estimatedUnitPrice: 36.5,
    } as any);

    component.submitLot();

    expect(pantryService.registerLot).toHaveBeenCalledWith(
      jasmine.objectContaining({
        newProductType: jasmine.objectContaining({
          shoppingMetadata: {
            storageLocation: 'Despensa',
            shoppingLocation: 'Mercado',
            preferredBrand: 'Marca local',
            substituteBrand: 'Marca propia',
            householdStaple: true,
            buyOnlyOnPromo: true,
            replenishWhenLow: false,
            shoppingNotes: 'Comprar bolsa grande si esta en promo',
            estimatedUnitPrice: 36.5,
          },
        }),
      }),
    );
  });

  it('releases the register button when lot registration times out', fakeAsync(() => {
    pantryService.registerLot.and.returnValue(NEVER);
    component.setSelectionMode('new');
    component.lotForm.patchValue({
      newBaseName: 'QA Codex arroz',
      category: 'food',
      unit: 'piezas',
      quantity: 1,
    } as any);

    component.submitLot();

    expect(component.submittingLot).toBeTrue();

    tick(15001);

    expect(component.submittingLot).toBeFalse();
    expect(component.registerError).toBe(
      'La solicitud tardó demasiado. Revisa tu conexión e intenta de nuevo.',
    );
  }));

  it('opens a product type depletion rule editor with the current rule values', () => {
    const group = makePantryGroup({
      defaultUnit: 'lt',
      depletionRule: {
        enabled: true,
        consumeAmount: 0.5,
        unit: 'lt',
        everyAmount: 2,
        everyPeriod: 'month',
        anchorDate: new Date('2026-04-24T00:00:00.000Z'),
      },
    });

    component.startEditingDepletionRule(group);

    expect(component.editingDepletionProductTypeId).toBe('type-detergent');
    expect(component.depletionRuleForm.getRawValue()).toEqual({
      enabled: true,
      consumeAmount: 0.5,
      everyAmount: 2,
      everyPeriod: 'month',
      anchorDate: '2026-04-24',
    });
  });

  it('saves edited product type depletion rules and reloads the pantry overview', () => {
    const group = makePantryGroup({ defaultUnit: 'lt' });
    component.startEditingDepletionRule(group);
    component.depletionRuleForm.patchValue({
      enabled: true,
      consumeAmount: 0.75,
      everyAmount: 3,
      everyPeriod: 'week',
      anchorDate: '2026-05-01',
    });

    component.saveDepletionRule(group);

    expect(pantryService.updateProductTypeDepletionRule).toHaveBeenCalledWith(
      'type-detergent',
      {
        enabled: true,
        consumeAmount: 0.75,
        unit: 'lt',
        everyAmount: 3,
        everyPeriod: 'week',
        anchorDate: '2026-05-01',
      },
    );
    expect(component.editingDepletionProductTypeId).toBeNull();
    expect(store.dispatch).toHaveBeenCalled();
  });

  it('rejects a fractional interval when editing a depletion rule', () => {
    const group = makePantryGroup({ defaultUnit: 'lt' });
    component.startEditingDepletionRule(group);
    component.depletionRuleForm.patchValue({ everyAmount: 1.5 });

    component.saveDepletionRule(group);

    expect(component.depletionRuleForm.invalid).toBeTrue();
    expect(pantryService.updateProductTypeDepletionRule).not.toHaveBeenCalled();
  });

  it('shows and dismisses the expired entry alert for the current pantry visit', async () => {
    store.select.and.callFake((selector) => {
      if (selector === selectExpiredEntryAlert) {
        return of({
          expiredLotCount: 2,
          expiredQuantity: 3,
        });
      }

      return of(null);
    });
    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    let compiled = fixture.nativeElement as HTMLElement;
    const alert = compiled.querySelector('[data-testid="expired-entry-alert"]');
    expect(alert?.textContent).toContain('Hay productos que ya caducaron');
    expect(alert?.textContent).toContain('2 lotes');

    compiled
      .querySelector<HTMLButtonElement>('[data-testid="dismiss-expired-alert"]')
      ?.click();
    fixture.detectChanges();
    compiled = fixture.nativeElement as HTMLElement;

    expect(
      compiled.querySelector('[data-testid="expired-entry-alert"]'),
    ).toBeNull();
  });

  it('separates expired quantity from upcoming expiration quantity for a base type', () => {
    const group = makePantryGroup({
      lots: [
        {
          lotId: 'lot-expired',
          quantity: 3,
          unit: 'piezas',
          expiresAt: new Date('2026-04-23T00:00:00.000Z'),
          purchaseDate: null,
          expirationStatus: 'expired',
          updatedAt: new Date('2026-04-23T00:00:00.000Z'),
        },
        {
          lotId: 'lot-critical',
          quantity: 1,
          unit: 'piezas',
          expiresAt: new Date('2026-04-29T00:00:00.000Z'),
          purchaseDate: null,
          expirationStatus: 'critical',
          updatedAt: new Date('2026-04-23T00:00:00.000Z'),
        },
        {
          lotId: 'lot-stable',
          quantity: 8,
          unit: 'piezas',
          expiresAt: new Date('2026-05-30T00:00:00.000Z'),
          purchaseDate: null,
          expirationStatus: 'stable',
          updatedAt: new Date('2026-04-23T00:00:00.000Z'),
        },
      ],
    });

    expect(component.getExpiredQuantity(group)).toBe(3);
    expect(component.getPendingExpirationQuantity(group)).toBe(1);
  });

  it('formats one piece in singular Spanish for pantry quantities', () => {
    expect(component.formatQuantity(1, 'piezas')).toBe('1 pieza');
    expect(component.formatQuantity(2, 'piezas')).toBe('2 piezas');
  });

  it('uses action-oriented shopping labels', () => {
    expect(component.shoppingPlanUrgencyLabels.depleted).toBe('Comprar ya');
    expect(component.shoppingPlanUrgencyLabels.critical).toBe(
      'Comprar esta semana',
    );
    expect(component.shoppingPlanUrgencyLabels.upcoming).toBe('Comprar pronto');
  });

  it('builds a WhatsApp-friendly shopping export with budget and LatAm metadata', () => {
    const exportText = component.buildShoppingPlanExportText([
      {
        productTypeId: 'type-detergent',
        baseName: 'Detergente',
        category: 'cleaning',
        defaultUnit: 'lt',
        totalQuantity: 3,
        estimatedCurrentQuantity: 1,
        estimatedConsumedQuantity: 2,
        estimatedDepletionAt: new Date('2026-05-01T00:00:00.000Z'),
        recommendedPurchaseAt: new Date('2026-04-28T00:00:00.000Z'),
        suggestedPurchaseQuantity: 1,
        urgency: 'critical',
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
        effectivePlanningSettings: makePantryGroup().effectivePlanningSettings,
        depletionRule: {
          enabled: true,
          consumeAmount: 1,
          unit: 'lt',
          everyAmount: 1,
          everyPeriod: 'week',
          anchorDate: new Date('2026-04-17T00:00:00.000Z'),
        },
      } as ShoppingPlanItem,
    ]);

    expect(exportText).toContain('Lista de compras Despensa Lista');
    expect(exportText).toContain('Total estimado: 42.50 moneda local');
    expect(exportText).toContain('Mayoreo:');
    expect(exportText).toContain('Subtotal ruta: 42.50 moneda local');
    expect(exportText).toContain('- Detergente: 1 lt');
    expect(exportText).toContain('Marca: Marca hogar');
    expect(exportText).toContain('Solo promo');
    expect(exportText).toContain('Nota: Comprar solo si hay promo');
    expect((component as any).getWhatsAppShoppingUrl(exportText)).toBe(
      `https://wa.me/?text=${encodeURIComponent(exportText)}`,
    );
  });

  it('saves and copies a server-backed shopping list snapshot by store', async () => {
    localStorage.removeItem('despensalista.savedShoppingLists');
    component.savedShoppingListForm.patchValue({
      title: 'Mayoreo semanal',
      occasion: 'Quincena',
      shoppingLocation: 'Mayoreo',
    });

    component.saveShoppingListSnapshot([
      makeShoppingPlanItem({
        shoppingMetadata: {
          shoppingLocation: 'Mayoreo',
          householdStaple: true,
          buyOnlyOnPromo: false,
          replenishWhenLow: true,
        },
      }),
    ]);

    expect(component.savedShoppingLists[0]).toEqual(
      jasmine.objectContaining({
        id: 'list-server-1',
        ownerUserId: 'tester',
        title: 'Mayoreo semanal',
        occasion: 'Quincena',
        shoppingLocation: 'Mayoreo',
      }),
    );
    expect(pantryService.createSavedShoppingList).toHaveBeenCalledWith(
      jasmine.objectContaining({
        title: 'Mayoreo semanal',
        occasion: 'Quincena',
        shoppingLocation: 'Mayoreo',
        items: [
          jasmine.objectContaining({
            productTypeId: 'type-detergent',
            baseName: 'Detergente',
          }),
        ],
      }),
    );

    await component.copySavedShoppingList(component.savedShoppingLists[0]);

    expect(component.shoppingExportText).toContain('Mayoreo semanal');
  });

  it('saves the current smart basket as a master shopping list', () => {
    component.saveMasterShoppingListSnapshot([
      makeShoppingPlanItem({
        baseName: 'Arroz',
        defaultUnit: 'kg',
        suggestedPurchaseQuantity: 2,
      }),
    ]);

    expect(pantryService.createSavedShoppingList).toHaveBeenCalledWith(
      jasmine.objectContaining({
        title: 'Lista maestra',
        occasion: 'Compra recurrente',
        items: [
          jasmine.objectContaining({
            baseName: 'Arroz',
            quantity: 2,
            unit: 'kg',
          }),
        ],
      }),
    );
    expect(component.savedShoppingListStatus).toBe(
      'Lista maestra sincronizada en tu cuenta.',
    );
  });

  it('repeats a saved shopping list in shopping mode even without current recommendations', async () => {
    const list: SavedShoppingList = {
      id: 'list-previous',
      ownerUserId: 'tester',
      title: 'Compra anterior',
      shoppingLocation: 'Mercado',
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
      updatedAt: new Date('2026-06-09T00:00:00.000Z'),
      items: [
        {
          productTypeId: 'type-rice',
          baseName: 'Arroz',
          quantity: 2,
          unit: 'kg',
          shoppingLocation: 'Mercado',
          estimatedUnitPrice: 36,
        },
      ],
    };

    await component.enterShoppingModeFromSavedList(list, []);
    expect(component.shoppingModeSourceList).toBe(list);

    component.closeShoppingTrip([]);

    expect(pantryService.closeShoppingPurchase).toHaveBeenCalledWith(
      {
        items: [
          jasmine.objectContaining({
            productTypeId: 'type-rice',
            quantity: 2,
            unit: 'kg',
            paidUnitPrice: 36,
            shoppingLocation: 'Mercado',
          }),
        ],
      },
      jasmine.any(String),
    );
    expect(component.shoppingModeSourceList).toBeNull();
  });

  it('supports bulk shopping-mode selection for all and urgent items', () => {
    const criticalItem = makeShoppingPlanItem({
      productTypeId: 'type-critical',
      urgency: 'critical',
    });
    const upcomingItem = makeShoppingPlanItem({
      productTypeId: 'type-upcoming',
      urgency: 'upcoming',
    });
    const items = [criticalItem, upcomingItem];

    component.setShoppingTripItemsChecked(items, true);

    expect(component.getShoppingTripSelectedCount(items)).toBe(2);

    component.setUrgentShoppingTripItemsChecked(items);

    expect(component.getShoppingTripItem(criticalItem).checked).toBeTrue();
    expect(component.getShoppingTripItem(upcomingItem).checked).toBeFalse();
  });

  it('toggles a shopping item as a household basic without sending price history', () => {
    const item = makeShoppingPlanItem({
      shoppingMetadata: {
        shoppingLocation: 'Mercado',
        preferredBrand: 'Local',
        householdStaple: false,
        buyOnlyOnPromo: true,
        replenishWhenLow: true,
        estimatedUnitPrice: 36,
        priceHistory: [
          {
            shoppingLocation: 'Mercado',
            unit: 'lt',
            estimatedUnitPrice: 34,
            recordedAt: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    });

    component.toggleShoppingStaple(item);

    expect(pantryService.updateProductTypeShoppingMetadata).toHaveBeenCalledWith(
      'type-detergent',
      {
        storageLocation: undefined,
        shoppingLocation: 'Mercado',
        preferredBrand: 'Local',
        substituteBrand: undefined,
        householdStaple: true,
        buyOnlyOnPromo: true,
        replenishWhenLow: true,
        shoppingNotes: undefined,
        estimatedUnitPrice: 36,
      },
    );
  });

  it('shows the latest paid price summary from price history first', () => {
    const item = makeShoppingPlanItem({
      estimatedUnitPrice: 42,
      shoppingMetadata: {
        householdStaple: false,
        buyOnlyOnPromo: false,
        replenishWhenLow: true,
        estimatedUnitPrice: 42,
        shoppingLocation: 'Mayoreo',
        priceHistory: [
          {
            shoppingLocation: 'Mercado',
            unit: 'lt',
            estimatedUnitPrice: 39,
            recordedAt: new Date('2026-06-08T12:00:00.000Z'),
          },
        ],
      },
    });

    expect(component.getLastPaidPriceSummary(item)).toContain(
      'Último: 39.00 moneda local · Mercado',
    );
  });

  it('deletes a server-backed saved shopping list', () => {
    component.savedShoppingLists = [
      {
        id: 'list-server-1',
        ownerUserId: 'tester',
        title: 'Mayoreo semanal',
        createdAt: new Date('2026-06-09T00:00:00.000Z'),
        updatedAt: new Date('2026-06-09T00:00:00.000Z'),
        items: [],
      },
    ];

    component.deleteSavedShoppingList('list-server-1');

    expect(pantryService.deleteSavedShoppingList).toHaveBeenCalledWith(
      'list-server-1',
    );
    expect(component.savedShoppingLists).toEqual([]);
    expect(component.savedShoppingListStatus).toBe(
      'Lista sincronizada eliminada.',
    );
  });

  it('compares the smart basket against a stored household budget', () => {
    (component as any).saveShoppingBudget(800);

    expect((component as any).shoppingBudget).toBe(800);
    expect((component as any).getBudgetStatusLabel(650)).toBe(
      'Dentro del presupuesto: quedan 150.00 moneda local',
    );
    expect((component as any).getBudgetStatusLabel(925)).toBe(
      'Sobre presupuesto por 125.00 moneda local',
    );
  });

  it('formats missing and non-finite shopping prices without throwing', () => {
    expect(component.formatShoppingPrice(null)).toBe('Sin estimado');
    expect(component.formatShoppingPrice(Number.NaN)).toBe('Sin estimado');
    expect(component.formatShoppingPrice(Number.POSITIVE_INFINITY)).toBe(
      'Sin estimado',
    );
  });

  it('keeps all local shopping state isolated when another account opens the pantry', () => {
    const item = makeShoppingPlanItem();
    component.saveShoppingBudget(800);
    component.quickCaptureForm.setValue({ rawText: 'Arroz | 2 kg' });
    component.saveQuickCaptureDraft();
    (component as any).ensureShoppingTripDraft([item]);
    component.updateShoppingTripChecked(item, {
      target: { checked: true },
    } as unknown as Event);
    component.shoppingModeActive = true;
    component.isOffline = true;
    component.closeShoppingTrip([item]);
    pantryService.createSavedShoppingList.and.returnValue(
      throwError(() => new Error('offline')),
    );
    component.savedShoppingListForm.patchValue({ title: 'Lista de A' });
    component.saveShoppingListSnapshot([item]);

    expect(component.pendingShoppingCheckoutCount).toBe(1);
    expect(component.savedShoppingLists.length).toBe(1);

    fixture.destroy();
    authFacade.setCurrentUser(makeAuthUser('user-b'));
    spyOnProperty(window.navigator, 'onLine', 'get').and.returnValue(false);
    pantryService.closeShoppingPurchase.calls.reset();
    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.shoppingBudget).toBeNull();
    expect(component.quickCaptureDrafts).toEqual([]);
    expect((component as any).shoppingTripDraft).toEqual({});
    expect(component.pendingShoppingCheckoutCount).toBe(0);
    expect(component.savedShoppingLists).toEqual([]);
    expect(pantryService.closeShoppingPurchase).not.toHaveBeenCalled();
  });

  it('migrates only legacy saved lists that identify the current owner', () => {
    fixture.destroy();
    localStorage.setItem(
      'despensalista.savedShoppingLists',
      JSON.stringify([
        makeStoredShoppingList('list-owned', 'Propia', 'tester'),
        makeStoredShoppingList('list-foreign', 'Ajena', 'user-b'),
        makeStoredShoppingList('list-unowned', 'Sin propietario'),
      ]),
    );

    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.savedShoppingLists.map((list) => list.title)).toEqual([
      'Propia',
    ]);

    fixture.destroy();
    localStorage.removeItem('despensalista.savedShoppingLists');
    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.savedShoppingLists.map((list) => list.title)).toEqual([
      'Propia',
    ]);
  });

  it('parses quick capture lines for offline purchase drafts', () => {
    const parsed = (component as any).parseQuickCaptureText(
      'Arroz | 2 kg | Mercado | 35 | 7501001\nShampoo | 1 botella | Farmacia',
    );

    expect(parsed).toEqual([
      {
        name: 'Arroz',
        quantity: 2,
        unit: 'kg',
        shoppingLocation: 'Mercado',
        estimatedUnitPrice: 35,
        barcode: '7501001',
      },
      {
        name: 'Shampoo',
        quantity: 1,
        unit: 'botella',
        shoppingLocation: 'Farmacia',
        estimatedUnitPrice: undefined,
      },
    ]);
  });

  it('imports quick capture CSV with regional semicolon delimiters', () => {
    const parsed = component.parseQuickCaptureCsv(
      'Producto;Cantidad;Unidad;Tienda;Precio;Codigo\nFrijol;2;kg;Mercado;41.5;7502002',
    );

    expect(parsed).toEqual([
      {
        name: 'Frijol',
        quantity: 2,
        unit: 'kg',
        shoppingLocation: 'Mercado',
        estimatedUnitPrice: 41.5,
        barcode: '7502002',
      },
    ]);
  });

  it('exports pantry lots as CSV rows for Excel review', () => {
    const csv = component.buildPantryCsvExport([
      makePantryGroup({
        productTypeId: 'type-rice',
        baseName: 'Arroz integral',
        category: 'food',
        defaultUnit: 'kg',
        totalQuantity: 2,
        lots: [
          makePantryLotSummary({
            lotId: 'lot-rice',
            variantName: 'Bolsa 1kg',
            quantity: 2,
            unit: 'kg',
            purchaseDate: new Date('2026-06-01T00:00:00.000Z'),
            expiresAt: new Date('2026-12-01T00:00:00.000Z'),
          }),
        ],
        shoppingMetadata: {
          storageLocation: 'Despensa',
          shoppingLocation: 'Mercado',
          preferredBrand: 'Marca local',
          householdStaple: true,
          buyOnlyOnPromo: false,
          replenishWhenLow: true,
          estimatedUnitPrice: 38,
        },
      }),
    ]);

    expect(csv).toContain('"Producto","Variante","Categoria"');
    expect(csv).toContain(
      '"Arroz integral","Bolsa 1kg","Comida","2","kg","Despensa","Mercado","Marca local","38","2026-06-01","2026-12-01"',
    );
  });

  it('keeps barcode capture manual before filling the lot form', () => {
    component.confirmQuickCaptureBarcode('7503003');

    expect(component.quickCaptureForm.controls.rawText.value).toContain(
      'Producto 503003 | 1 piezas | | | 7503003',
    );

    component.useQuickCaptureItem({
      name: 'Producto 7503003',
      quantity: 1,
      unit: 'piezas',
      barcode: '7503003',
    });

    expect(component.lotForm.getRawValue()).toEqual(
      jasmine.objectContaining({
        newBaseName: 'Producto 7503003',
        shoppingNotes: 'Código: 7503003',
      }),
    );
  });

  it('summarizes household staple attention and restock estimates', () => {
    const stapleItems: PantryStapleItem[] = [
      {
        productTypeId: 'type-rice',
        baseName: 'Arroz',
        category: 'food',
        defaultUnit: 'kg',
        totalQuantity: 1,
        suggestedPurchaseQuantity: 2,
        estimatedRestockTotal: 60,
        status: 'low',
      },
      {
        productTypeId: 'type-detergent',
        baseName: 'Detergente',
        category: 'cleaning',
        defaultUnit: 'lt',
        totalQuantity: 3,
        suggestedPurchaseQuantity: 1,
        status: 'available',
      },
    ];

    expect(component.getStapleAttentionSummary([...stapleItems])).toBe(
      '1 de 2 básicos por revisar',
    );
    expect(component.getStapleRestockSummary([...stapleItems])).toBe(
      'Reposición estimada: 60.00 moneda local',
    );
  });

  it('summarizes waste risk and savings coverage from value insights', () => {
    const insights: PantryValueInsights = {
      stapleCount: 3,
      stapleAttentionCount: 1,
      estimatedShoppingTotal: 120,
      estimatedExpiringValue: 56,
      estimatedWasteAtRisk: 56,
      estimatedStapleRestockTotal: 60,
      pricedShoppingItemCount: 2,
      unpricedShoppingItemCount: 1,
      promoOnlyShoppingItemCount: 1,
      estimatedPromoOnlyTotal: 42,
    };

    expect(component.getWasteSavingsSummary(insights)).toBe(
      'Riesgo desperdicio: 56.00 moneda local · 2 con precio · 1 sin precio · 1 solo promo',
    );
  });

  it('marks shopping totals as partial when any suggested item has no price estimate', () => {
    const exportText = component.buildShoppingPlanExportText([
      makeShoppingPlanItem({
        baseName: 'Detergente',
        estimatedUnitPrice: 42.5,
        estimatedLineTotal: 42.5,
      }),
      makeShoppingPlanItem({
        productTypeId: 'type-rice',
        baseName: 'Arroz',
        defaultUnit: 'kg',
        estimatedUnitPrice: undefined,
        estimatedLineTotal: undefined,
      }),
    ]);

    expect(
      component.getShoppingPlanTotalLabel([
        makeShoppingPlanItem({ estimatedLineTotal: 42.5 }),
        makeShoppingPlanItem({
          productTypeId: 'type-rice',
          estimatedLineTotal: undefined,
        }),
      ]),
    ).toBe('Total parcial estimado');
    expect(exportText).toContain('Total parcial estimado: 42.50 moneda local');
  });

  it('does not call an unpriced shopping plan a partial total', () => {
    expect(
      component.getShoppingPlanTotalSummary([
        makeShoppingPlanItem({
          estimatedUnitPrice: undefined,
          estimatedLineTotal: undefined,
        }),
      ]),
    ).toBe('Sin precios estimados');
  });

  it('renders an accessible name for the manual shopping export textarea', async () => {
    store.select.and.callFake((selector) => {
      if (selector === selectShoppingPlanItems) {
        return of([makeShoppingPlanItem()]);
      }

      return of(null);
    });
    fixture = TestBed.createComponent(PantryPageComponent);
    component = fixture.componentInstance;
    component.shoppingExportText = 'Lista generada';
    fixture.detectChanges();
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    const textarea = compiled.querySelector<HTMLTextAreaElement>(
      '.shopping-export-text',
    );

    expect(textarea?.getAttribute('aria-label')).toBe(
      'Lista de compras generada',
    );
  });

  it('uses a legacy copy fallback when the Clipboard API rejects the shopping list', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const originalExecCommand = document.execCommand;

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: jasmine
          .createSpy('writeText')
          .and.returnValue(Promise.reject(new Error('denied'))),
      },
    });
    (document as any).execCommand = jasmine
      .createSpy('execCommand')
      .and.returnValue(true);

    try {
      await component.copyShoppingPlan([makeShoppingPlanItem()]);

      expect(document.execCommand).toHaveBeenCalledWith('copy');
      expect(component.shoppingExportStatus).toBe(
        'Lista copiada para WhatsApp.',
      );
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
      }
      (document as any).execCommand = originalExecCommand;
    }
  });

  it('creates a server-backed view-only temporary shopping list link without account access', () => {
    component.createTemporaryShoppingShare([
      makeShoppingPlanItem({
        baseName: 'Arroz',
        shoppingMetadata: {
          shoppingLocation: 'Mercado',
          householdStaple: true,
          buyOnlyOnPromo: false,
          replenishWhenLow: true,
        },
      }),
    ]);

    expect(component.shoppingShareLink).toContain(
      '/shared-shopping-list?token=opaque-token',
    );
    expect(pantryService.createShoppingShare).toHaveBeenCalledWith({
      text: jasmine.stringContaining('Arroz'),
    });
    expect(component.shoppingShareStatus).toBe(
      'Enlace temporal creado. Puedes revocarlo cuando termines.',
    );
    expect(component.shoppingShareExpiresAt).toEqual(
      new Date('2026-05-26T00:00:00.000Z'),
    );

    expect(component.shoppingShareLink).not.toContain('Arroz');
  });

  it('applies staple templates without submitting automatically', () => {
    component.applyStapleTemplate(component.stapleTemplates[2]);

    expect(component.lotForm.getRawValue()).toEqual(
      jasmine.objectContaining({
        selectionMode: 'new',
        newBaseName: 'Paracetamol',
        category: 'hygiene',
        unit: 'piezas',
        storageLocation: 'Botiquin',
        shoppingLocation: 'Farmacia',
        householdStaple: true,
        buyOnlyOnPromo: false,
        replenishWhenLow: false,
        enableDurability: false,
      }),
    );
    expect(pantryService.registerLot).not.toHaveBeenCalled();
  });

  it('applies the prepared leftovers template with a short expiration', () => {
    const leftoversTemplate = component.stapleTemplates.find(
      (template) => template.label === 'Sobras preparadas',
    );

    expect(leftoversTemplate).toBeDefined();

    component.applyStapleTemplate(leftoversTemplate!);
    const rawValue = component.lotForm.getRawValue();

    expect(rawValue).toEqual(
      jasmine.objectContaining({
        selectionMode: 'new',
        newBaseName: 'Sobras de comida',
        storageLocation: 'Sobras',
        shoppingLocation: 'Otro',
        householdStaple: false,
        replenishWhenLow: false,
      }),
    );
    expect(rawValue.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rawValue.purchaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pantryService.registerLot).not.toHaveBeenCalled();
  });

  it('adds template shelf life to the Mexico City day, not the browser day', () => {
    const today = toDateInputValue(new Date(), true);
    const expectedExpiration = new Date(`${today}T00:00:00.000Z`);
    expectedExpiration.setUTCDate(expectedExpiration.getUTCDate() + 3);
    const mexicoDay = Number(today.slice(8));
    spyOn(Date.prototype, 'getDate').and.returnValue(
      mexicoDay < 28 ? mexicoDay + 1 : mexicoDay - 1,
    );

    const leftoversTemplate = component.stapleTemplates.find(
      (template) => template.label === 'Sobras preparadas',
    );
    component.applyStapleTemplate(leftoversTemplate!);

    expect(component.lotForm.controls.purchaseDate.value).toBe(today);
    expect(component.lotForm.controls.expiresAt.value).toBe(
      expectedExpiration.toISOString().slice(0, 10),
    );
  });

  it('builds a use-first list with risk estimates and leftover lots', () => {
    const criticalLot = makePantryLotSummary({
      lotId: 'lot-critical',
      quantity: 2,
      unit: 'lt',
      expiresAt: new Date('2026-06-10T00:00:00.000Z'),
      expirationStatus: 'critical',
    });
    const expiringGroup = {
      productTypeId: 'type-milk',
      baseName: 'Leche',
      category: 'food' as const,
      totalExpiringQuantity: 2,
      nextExpirationAt: new Date('2026-06-10T00:00:00.000Z'),
      lotCount: 1,
      lots: [criticalLot],
    };
    const pantryGroups = [
      makePantryGroup({
        productTypeId: 'type-milk',
        baseName: 'Leche',
        category: 'food',
        defaultUnit: 'lt',
        lots: [criticalLot],
        shoppingMetadata: {
          householdStaple: true,
          buyOnlyOnPromo: false,
          replenishWhenLow: true,
          estimatedUnitPrice: 20,
        },
      }),
      makePantryGroup({
        productTypeId: 'type-leftovers',
        baseName: 'Sobras',
        category: 'food',
        defaultUnit: 'piezas',
        lots: [
          makePantryLotSummary({
            lotId: 'lot-leftovers',
            quantity: 1,
            unit: 'piezas',
            expirationStatus: 'none',
          }),
        ],
        shoppingMetadata: {
          storageLocation: 'Sobras',
          householdStaple: false,
          buyOnlyOnPromo: false,
          replenishWhenLow: false,
        },
      }),
    ];

    const items = component.getUseFirstItems([expiringGroup], pantryGroups);

    expect(items.map((item) => item.lot.lotId)).toEqual([
      'lot-critical',
      'lot-leftovers',
    ]);
    expect(items[0].estimatedLoss).toBe(40);
    expect(component.getUseFirstAction(items[0])).toBe('Usar hoy');
    expect(component.getUseFirstSummary(items)).toBe(
      '2 prioridad(es) para usar primero · 40.00 moneda local en riesgo',
    );
  });

  it('builds monthly staple and waste summaries', () => {
    expect(
      component.getMonthlyStapleReport([
        {
          productTypeId: 'type-rice',
          baseName: 'Arroz',
          category: 'food',
          defaultUnit: 'kg',
          totalQuantity: 1,
          suggestedPurchaseQuantity: 2,
          estimatedRestockTotal: 90,
          status: 'low',
        },
      ]),
    ).toBe('1 por revisar · 90.00 moneda local para reponer');

    expect(
      component.getMonthlyWasteProjection({
        userId: 'tester',
        generatedAt: new Date('2026-06-09T00:00:00.000Z'),
        windowDays: 15,
        eventCount: 2,
        estimatedLossTotal: 50,
        totalQuantityByUnit: [],
        reasonBreakdown: [],
        recentEvents: [],
      }),
    ).toBe('Mes estimado: 100.00 moneda local');
  });

  it('builds a recent pantry timeline from purchases, waste and prices', () => {
    const wasteEvents: WasteEventSummary[] = [
      {
        id: 'waste-1',
        productName: 'Pan',
        quantity: 1,
        unit: 'piezas',
        reason: 'expired',
        estimatedLoss: 18,
        occurredAt: new Date('2026-06-08T12:00:00.000Z'),
      },
    ];
    const priceReferences: PriceReferenceItem[] = [
      {
        productTypeId: 'type-milk',
        baseName: 'Leche',
        category: 'food',
        defaultUnit: 'lt',
        shoppingLocation: 'Supermercado',
        estimatedUnitPrice: 24,
        buyOnlyOnPromo: false,
        updatedAt: new Date('2026-06-09T00:00:00.000Z'),
        priceHistory: [
          {
            shoppingLocation: 'Supermercado',
            unit: 'lt',
            estimatedUnitPrice: 24,
            recordedAt: new Date('2026-06-09T00:00:00.000Z'),
          },
        ],
      },
    ];

    const timeline = component.getPantryTimeline(
      [
        makePantryGroup({
          productTypeId: 'type-milk',
          baseName: 'Leche',
          category: 'food',
          defaultUnit: 'lt',
          lots: [
            makePantryLotSummary({
              lotId: 'lot-milk',
              quantity: 2,
              unit: 'lt',
              purchaseDate: new Date('2026-06-07T12:00:00.000Z'),
            }),
          ],
          shoppingMetadata: {
            householdStaple: true,
            buyOnlyOnPromo: false,
            replenishWhenLow: true,
            estimatedUnitPrice: 24,
          },
        }),
      ],
      wasteEvents,
      priceReferences,
    );

    expect(timeline.map((item) => item.kind)).toEqual([
      'price',
      'waste',
      'purchase',
    ]);
    expect(timeline[0].detail).toContain('Precio 24.00 moneda local');
    expect(timeline[2].amount).toBe(48);
    expect(component.getTimelineKindLabel('purchase')).toBe('Compra');
  });

  it('loads active shopping shares and formats expiry in Central time', () => {
    expect(pantryService.listActiveShoppingShares).toHaveBeenCalled();
    expect(component.activeShoppingShares[0].id).toBe('share-active-1');
    expect(
      component.formatCentralDate(component.activeShoppingShares[0].expiresAt),
    ).toContain('26 may');
  });

  it('revokes an active shopping share from persisted history', () => {
    const share: ShoppingShare = {
      id: 'share-active-1',
      createdAt: new Date('2026-05-19T00:00:00.000Z'),
      expiresAt: new Date('2026-05-26T18:00:00.000Z'),
      revokedAt: null,
    };
    component.activeShoppingShares = [share];

    component.revokeActiveShoppingShare(share);

    expect(pantryService.revokeShoppingShareById).toHaveBeenCalledWith(
      'share-active-1',
    );
    expect(component.activeShoppingShares).toEqual([]);
    expect(component.shoppingShareStatus).toBe('Enlace temporal revocado.');
  });

  it('revokes a server-backed temporary shopping list link', () => {
    component.createTemporaryShoppingShare([makeShoppingPlanItem()]);

    component.revokeTemporaryShoppingShare();

    expect(pantryService.revokeShoppingShare).toHaveBeenCalledWith(
      'opaque-token',
    );
    expect(component.shoppingShareLink).toBeNull();
    expect(component.shoppingShareToken).toBeNull();
    expect(component.shoppingShareStatus).toBe('Enlace temporal revocado.');
  });

  it('saves product type planning overrides and reloads the pantry overview', () => {
    const group = makePantryGroup();
    component.startEditingPlanningSettings(group);
    component.planningSettingsForm.patchValue({
      planningEnabled: true,
      expirationWarningDaysOverride: 14,
      depletionWarningThresholdRatioOverride: 0.75,
      shoppingPlanLeadDaysOverride: 6,
    });

    component.savePlanningSettings(group);

    expect(
      pantryService.updateProductTypePlanningSettings,
    ).toHaveBeenCalledWith('type-detergent', {
      planningEnabled: true,
      expirationWarningDaysOverride: 14,
      depletionWarningThresholdRatioOverride: 0.75,
      shoppingPlanLeadDaysOverride: 6,
    });
    expect(component.editingPlanningProductTypeId).toBeNull();
    expect(store.dispatch).toHaveBeenCalled();
  });

  it('loads archived pantry items when the archived panel is opened', () => {
    component.toggleArchivedPanel();

    expect(pantryService.getArchivedPantryItems).toHaveBeenCalledWith({
      limit: 50,
    });
    expect(component.archivedPanelOpen).toBeTrue();
    expect(component.archivedItems).toEqual({
      productTypes: [],
      inventoryLots: [],
    });
  });

  it('loads more archived pantry items with cursors', () => {
    component.archivedItems = {
      productTypes: [{ id: 'type-1' } as any],
      inventoryLots: [],
      pagination: {
        limit: 50,
        productTypesNextCursor: 'next-types',
        hasMoreProductTypes: true,
        hasMoreInventoryLots: false,
      },
    };
    pantryService.getArchivedPantryItems.and.returnValue(
      of({
        productTypes: [{ id: 'type-2' } as any],
        inventoryLots: [],
        pagination: {
          limit: 50,
          hasMoreProductTypes: false,
          hasMoreInventoryLots: false,
        },
      }),
    );

    component.loadMoreArchivedItems();

    expect(pantryService.getArchivedPantryItems).toHaveBeenCalledWith({
      limit: 50,
      productTypesCursor: 'next-types',
      inventoryLotsCursor: undefined,
      includeProductTypes: true,
      includeInventoryLots: false,
    });
    expect(component.archivedItems.productTypes.map((item) => item.id)).toEqual([
      'type-1',
      'type-2',
    ]);
    expect(component.canLoadMoreArchivedItems()).toBeFalse();
  });

  it('requires inline confirmation before archiving a product type', () => {
    const group = makePantryGroup();

    component.archiveProductType(group);

    expect(component.archiveConfirmationTarget).toEqual({
      kind: 'productType',
      id: 'type-detergent',
      label: 'Detergente',
      message:
        'Se quitara de la despensa activa, busquedas y compras sugeridas. Sus lotes activos tambien dejaran de contarse.',
    });
    expect(pantryService.archiveProductType).not.toHaveBeenCalled();

    component.confirmArchiveConfirmation();

    expect(pantryService.archiveProductType).toHaveBeenCalledWith(
      'type-detergent',
      { reason: 'Archivado desde la despensa' },
    );
    expect(component.archiveConfirmationTarget).toBeNull();
  });

  it('requires inline confirmation before archiving an inventory lot', () => {
    const lot = makePantryLotSummary();

    component.archiveLot(lot);
    component.confirmArchiveConfirmation();

    expect(pantryService.archiveInventoryLot).toHaveBeenCalledWith('lot-1', {
      reason: 'Archivado desde la despensa',
    });
    expect(component.archiveConfirmationTarget).toBeNull();
  });

  it('requires inline confirmation before permanently deleting an archived product type', () => {
    const productType = makeProductType();

    component.deleteArchivedProductType(productType);

    expect(component.deleteConfirmationTarget).toEqual({
      kind: 'productType',
      id: 'type-detergent',
      expectedText: 'Detergente',
    });
    expect(pantryService.deleteProductType).not.toHaveBeenCalled();

    component.updateDeleteConfirmationInput('Detergente equivocado');
    component.confirmDeleteConfirmation();

    expect(component.deleteConfirmationError).toContain('Detergente');
    expect(pantryService.deleteProductType).not.toHaveBeenCalled();

    component.updateDeleteConfirmationInput('Detergente');
    component.confirmDeleteConfirmation();

    expect(pantryService.deleteProductType).toHaveBeenCalledWith(
      'type-detergent',
      { confirmationText: 'Detergente' },
    );
    expect(component.deleteConfirmationTarget).toBeNull();
  });

  it('requires inline confirmation before permanently deleting an archived inventory lot', () => {
    const inventoryLot = makeInventoryLot();

    component.deleteArchivedInventoryLot(inventoryLot);
    component.updateDeleteConfirmationInput('Lote familiar');
    component.confirmDeleteConfirmation();

    expect(pantryService.deleteInventoryLot).toHaveBeenCalledWith('lot-1', {
      confirmationText: 'Lote familiar',
    });
    expect(component.deleteConfirmationTarget).toBeNull();
  });

  it('keeps shopping mode open when an offline checkout cannot be persisted', () => {
    const item = makeShoppingPlanItem();
    component.isOffline = true;
    component.shoppingModeActive = true;
    (component as any).ensureShoppingTripDraft([item]);
    component.updateShoppingTripChecked(item, {
      target: { checked: true },
    } as unknown as Event);
    spyOn(Storage.prototype, 'setItem').and.throwError('quota exceeded');

    component.closeShoppingTrip([item]);

    expect(component.shoppingModeActive).toBeTrue();
    expect(component.shoppingCheckoutStatus).toContain(
      'No se pudo guardar el cierre',
    );
    expect(component.pendingShoppingCheckoutCount).toBe(0);
    expect(pantryService.closeShoppingPurchase).not.toHaveBeenCalled();
  });

  it('queues a selected shopping checkout while offline and syncs it later', () => {
    const item = makeShoppingPlanItem();

    component.isOffline = true;
    (component as any).ensureShoppingTripDraft([item]);
    component.updateShoppingTripChecked(item, {
      target: { checked: true },
    } as unknown as Event);

    component.closeShoppingTrip([item]);

    expect(pantryService.closeShoppingPurchase).not.toHaveBeenCalled();
    expect(component.shoppingModeActive).toBeFalse();
    expect(component.pendingShoppingCheckoutCount).toBe(1);

    component.isOffline = false;
    (component as any).flushPendingShoppingCheckouts();

    expect(pantryService.closeShoppingPurchase).toHaveBeenCalledWith(
      {
        items: [
          jasmine.objectContaining({
            productTypeId: 'type-detergent',
            quantity: 1,
            unit: 'lt',
          }),
        ],
      },
      jasmine.any(String),
    );
    expect(component.pendingShoppingCheckoutCount).toBe(0);
  });

  it('reuses the persisted checkout idempotency key after a failed sync', () => {
    const item = makeShoppingPlanItem();
    component.isOffline = true;
    (component as any).ensureShoppingTripDraft([item]);
    component.updateShoppingTripChecked(item, {
      target: { checked: true },
    } as unknown as Event);
    component.closeShoppingTrip([item]);

    pantryService.closeShoppingPurchase.and.returnValue(
      throwError(() => new TimeoutError()),
    );
    component.isOffline = false;
    (component as any).flushPendingShoppingCheckouts();
    const firstKey = (pantryService.closeShoppingPurchase.calls.argsFor(0) as any[])[1] as
      | string
      | undefined;

    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    pantryService.closeShoppingPurchase.and.returnValue(of(makeCheckoutResult()));
    (component as any).flushPendingShoppingCheckouts();

    expect((pantryService.closeShoppingPurchase.calls.argsFor(1) as any[])[1]).toBe(
      firstKey,
    );
  });

  it('keeps an offline checkout pending when synchronization needs reauthentication', () => {
    const item = makeShoppingPlanItem();
    component.isOffline = true;
    component.setShoppingTripItemsChecked([item], true);
    component.closeShoppingTrip([item]);
    pantryService.closeShoppingPurchase.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 401 })),
    );

    component.isOffline = false;
    (component as any).flushPendingShoppingCheckouts();

    expect(component.pendingShoppingCheckoutCount).toBe(1);
  });

  it('rejects a checkout larger than the atomic limit of 49 lines', () => {
    const items = Array.from({ length: 50 }, (_, index) =>
      makeShoppingPlanItem({ productTypeId: `type-${index}` }),
    );
    component.setShoppingTripItemsChecked(items, true);

    component.closeShoppingTrip(items);

    expect(pantryService.closeShoppingPurchase).not.toHaveBeenCalled();
    expect(component.shoppingCheckoutStatus).toContain('máximo 49');
  });

  it('reuses the key when manually retrying an unresolved online checkout', () => {
    const item = makeShoppingPlanItem();
    component.setShoppingTripItemsChecked([item], true);
    pantryService.closeShoppingPurchase.and.returnValue(throwError(() => new TimeoutError()));
    component.closeShoppingTrip([item]);
    const firstKey = pantryService.closeShoppingPurchase.calls.argsFor(0)[1];
    component.closeShoppingTrip([item]);
    expect(pantryService.closeShoppingPurchase.calls.argsFor(1)[1]).toBe(firstKey);
    expect(component.pendingShoppingCheckoutCount).toBe(1);
  });

  it('drops a permanently rejected online checkout so corrected data can be retried', () => {
    const item = makeShoppingPlanItem();
    component.setShoppingTripItemsChecked([item], true);
    pantryService.closeShoppingPurchase.and.returnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { message: 'Invalid purchase line' },
          }),
      ),
    );

    component.closeShoppingTrip([item]);

    expect(component.pendingShoppingCheckoutCount).toBe(0);
    expect(component.shoppingCheckoutStatus).toContain('Corrige los datos');

    pantryService.closeShoppingPurchase.and.returnValue(of(makeCheckoutResult()));
    component.updateShoppingTripQuantity(item, 2);
    component.closeShoppingTrip([item]);

    expect(pantryService.closeShoppingPurchase).toHaveBeenCalledTimes(2);
    expect(component.pendingShoppingCheckoutCount).toBe(0);
  });

  it('does not automatically replay purchases after the seven-day receipt window', () => {
    const item = makeShoppingPlanItem();
    component.isOffline = true;
    component.setShoppingTripItemsChecked([item], true);
    component.closeShoppingTrip([item]);
    const pending = (component as any).loadPendingShoppingCheckouts();
    pending[0].createdAt = new Date(Date.now() - 8 * 86400000);
    (component as any).persistPendingShoppingCheckouts(pending);
    component.isOffline = false;
    (component as any).flushPendingShoppingCheckouts();
    expect(pantryService.closeShoppingPurchase).not.toHaveBeenCalled();
    expect(component.pendingShoppingCheckoutCount).toBe(1);
    expect(component.shoppingCheckoutStatus).toContain('siete días');
  });

  it('does not start parallel pending checkout syncs', () => {
    const item = makeShoppingPlanItem();
    const pendingRequest = new Subject<ReturnType<typeof makeCheckoutResult>>();
    component.isOffline = true;
    (component as any).ensureShoppingTripDraft([item]);
    component.updateShoppingTripChecked(item, {
      target: { checked: true },
    } as unknown as Event);
    component.closeShoppingTrip([item]);

    pantryService.closeShoppingPurchase.and.returnValue(pendingRequest);
    component.isOffline = false;
    (component as any).flushPendingShoppingCheckouts();
    (component as any).flushPendingShoppingCheckouts();

    expect(pantryService.closeShoppingPurchase).toHaveBeenCalledTimes(1);

    pendingRequest.next(makeCheckoutResult([makeInventoryLot()]));
    pendingRequest.complete();

    expect(component.pendingShoppingCheckoutCount).toBe(0);
  });
});

function makeConsumeResult(
  value: InventoryLot | null = null,
  replayed = false,
) {
  return {
    value,
    idempotencyKey: '9b29fb9a-ce30-473f-abaf-f8d987634f55',
    replayed,
  };
}

function makeCheckoutResult(
  value: InventoryLot[] = [],
  replayed = false,
) {
  return {
    value,
    idempotencyKey: 'fb5b1163-9dc5-4db4-b181-9f036f31bd08',
    replayed,
  };
}

class AuthFacadeStub {
  readonly currentUser$ = new BehaviorSubject<AuthUser | null>(
    makeAuthUser('tester'),
  );
  readonly currentUsername$ = of('tester');

  setCurrentUser(user: AuthUser): void {
    this.currentUser$.next(user);
  }

  logout(): void {
    // no-op
  }
}

function makeAuthUser(id: string): AuthUser {
  return {
    id,
    email: `${id}@example.com`,
    username: id,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeStoredShoppingList(
  id: string,
  title: string,
  ownerUserId?: string,
): Record<string, unknown> {
  return {
    id,
    ownerUserId,
    title,
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    items: [],
  };
}

function clearPantryLocalState(): void {
  const pantryStoragePrefixes = [
    'despensalista.shoppingBudget',
    'despensalista.quickCaptureDrafts',
    'despensalista.shoppingTripDraft',
    'despensalista.pendingShoppingCheckouts',
    'despensalista.pendingInventoryMutations',
    'despensalista.savedShoppingLists',
  ];

  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);

    if (key && pantryStoragePrefixes.some((prefix) => key.startsWith(prefix))) {
      localStorage.removeItem(key);
    }
  }
}

function makePantryGroup(
  overrides: Partial<PantryOverviewItem> = {},
): PantryOverviewItem {
  return {
    productTypeId: 'type-detergent',
    baseName: 'Detergente',
    category: 'cleaning',
    defaultUnit: 'lt',
    totalQuantity: 3,
    lotCount: 1,
    nextExpirationAt: null,
    expiringSoonQuantity: 0,
    hasDepletionRule: Boolean(overrides.depletionRule),
    effectivePlanningSettings: {
      planningEnabled: true,
      expirationWarningDays: 7,
      depletionWarningThresholdRatio: 1,
      shoppingPlanLeadDays: 3,
      expirationWarningDaysSource: 'profile',
      depletionWarningThresholdRatioSource: 'profile',
      shoppingPlanLeadDaysSource: 'profile',
    },
    variants: [],
    lots: [],
    ...overrides,
  };
}

function makePantryLotSummary(
  overrides: Partial<PantryLotSummary> = {},
): PantryLotSummary {
  return {
    lotId: 'lot-1',
    variantName: 'Lote familiar',
    quantity: 1,
    unit: 'piezas',
    expiresAt: null,
    purchaseDate: null,
    expirationStatus: 'none',
    updatedAt: new Date('2026-05-16T12:00:00.000Z'),
    ...overrides,
  };
}

function makeProductType(overrides: Partial<ProductType> = {}): ProductType {
  return {
    id: 'type-detergent',
    userId: 'user-1',
    baseName: 'Detergente',
    category: 'cleaning',
    defaultUnit: 'lt',
    planningSettings: {
      planningEnabled: true,
    },
    archivedAt: new Date('2026-05-16T12:00:00.000Z'),
    createdAt: new Date('2026-05-01T12:00:00.000Z'),
    updatedAt: new Date('2026-05-16T12:00:00.000Z'),
    ...overrides,
  };
}

function makeInventoryLot(overrides: Partial<InventoryLot> = {}): InventoryLot {
  return {
    id: 'lot-1',
    userId: 'user-1',
    productTypeId: 'type-detergent',
    variantName: 'Lote familiar',
    quantity: 1,
    unit: 'piezas',
    expiresAt: null,
    purchaseDate: null,
    archivedAt: new Date('2026-05-16T12:00:00.000Z'),
    expirationStatus: 'none',
    createdAt: new Date('2026-05-01T12:00:00.000Z'),
    updatedAt: new Date('2026-05-16T12:00:00.000Z'),
    ...overrides,
  };
}

function makeShoppingPlanItem(
  overrides: Partial<ShoppingPlanItem> = {},
): ShoppingPlanItem {
  return {
    productTypeId: 'type-detergent',
    baseName: 'Detergente',
    category: 'cleaning',
    defaultUnit: 'lt',
    totalQuantity: 3,
    estimatedCurrentQuantity: 1,
    estimatedConsumedQuantity: 2,
    estimatedDepletionAt: new Date('2026-05-01T00:00:00.000Z'),
    recommendedPurchaseAt: new Date('2026-04-28T00:00:00.000Z'),
    suggestedPurchaseQuantity: 1,
    estimatedUnitPrice: 42.5,
    estimatedLineTotal: 42.5,
    effectivePlanningSettings: makePantryGroup().effectivePlanningSettings,
    shoppingMetadata: {
      householdStaple: false,
      buyOnlyOnPromo: false,
      replenishWhenLow: true,
      estimatedUnitPrice: 42.5,
    },
    urgency: 'critical',
    depletionRule: {
      enabled: true,
      consumeAmount: 1,
      unit: 'lt',
      everyAmount: 1,
      everyPeriod: 'week',
      anchorDate: new Date('2026-04-17T00:00:00.000Z'),
    },
    ...overrides,
  };
}
