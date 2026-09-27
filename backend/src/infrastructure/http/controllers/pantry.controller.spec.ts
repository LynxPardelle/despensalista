import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthCookieService } from '../auth/auth-cookie.service';
import { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CloseShoppingPurchaseUseCase } from '../../../application/use-cases/close-shopping-purchase.use-case';
import { GetArchivedPantryItemsUseCase } from '../../../application/use-cases/get-archived-pantry-items.use-case';
import { GetPantryOverviewUseCase } from '../../../application/use-cases/get-pantry-overview.use-case';
import { GetUserProfileUseCase } from '../../../application/use-cases/get-user-profile.use-case';
import { GetWasteOverviewUseCase } from '../../../application/use-cases/get-waste-overview.use-case';
import {
  RecordHouseholdActivityUseCase,
  ResolveHouseholdPantryAccessUseCase,
} from '../../../application/use-cases/household.use-cases';
import {
  CreateShoppingShareUseCase,
  ListActiveShoppingSharesUseCase,
  RevokeShoppingShareByIdUseCase,
  RevokeShoppingShareUseCase,
} from '../../../application/use-cases/shopping-share.use-cases';
import {
  CreateShoppingListUseCase,
  DeleteShoppingListUseCase,
  ListShoppingListsUseCase,
} from '../../../application/use-cases/shopping-list.use-cases';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import { PantryController } from './pantry.controller';

describe('PantryController', () => {
  let controller: PantryController;
  let getPantryOverviewUseCase: jest.Mocked<GetPantryOverviewUseCase>;
  let getArchivedPantryItemsUseCase: jest.Mocked<GetArchivedPantryItemsUseCase>;
  let getUserProfileUseCase: jest.Mocked<GetUserProfileUseCase>;
  let getWasteOverviewUseCase: jest.Mocked<GetWasteOverviewUseCase>;
  let closeShoppingPurchaseUseCase: jest.Mocked<CloseShoppingPurchaseUseCase>;
  let createShoppingShareUseCase: jest.Mocked<CreateShoppingShareUseCase>;
  let createShoppingListUseCase: jest.Mocked<CreateShoppingListUseCase>;
  let listActiveShoppingSharesUseCase: jest.Mocked<ListActiveShoppingSharesUseCase>;
  let listShoppingListsUseCase: jest.Mocked<ListShoppingListsUseCase>;
  let revokeShoppingShareByIdUseCase: jest.Mocked<RevokeShoppingShareByIdUseCase>;
  let revokeShoppingShareUseCase: jest.Mocked<RevokeShoppingShareUseCase>;
  let deleteShoppingListUseCase: jest.Mocked<DeleteShoppingListUseCase>;
  let resolveHouseholdPantryAccessUseCase: jest.Mocked<ResolveHouseholdPantryAccessUseCase>;
  let recordHouseholdActivityUseCase: jest.Mocked<RecordHouseholdActivityUseCase>;
  let authCookieService: jest.Mocked<AuthCookieService>;

  beforeEach(() => {
    getPantryOverviewUseCase = {
      execute: jest.fn().mockResolvedValue(makeOverview()),
    } as unknown as jest.Mocked<GetPantryOverviewUseCase>;
    getArchivedPantryItemsUseCase = {
      execute: jest.fn().mockResolvedValue(makeArchivedItems()),
    } as unknown as jest.Mocked<GetArchivedPantryItemsUseCase>;
    getUserProfileUseCase = {
      execute: jest.fn().mockResolvedValue(makeProfile()),
    } as unknown as jest.Mocked<GetUserProfileUseCase>;
    getWasteOverviewUseCase = {
      execute: jest.fn().mockResolvedValue(makeWasteOverview()),
    } as unknown as jest.Mocked<GetWasteOverviewUseCase>;
    closeShoppingPurchaseUseCase = {
      execute: jest.fn().mockResolvedValue({
        value: [makeInventoryLot()],
        replayed: false,
      }),
    } as unknown as jest.Mocked<CloseShoppingPurchaseUseCase>;
    createShoppingShareUseCase = {
      execute: jest.fn().mockResolvedValue({
        share: makeShoppingShare(),
        token: 'opaque-token',
      }),
    } as unknown as jest.Mocked<CreateShoppingShareUseCase>;
    createShoppingListUseCase = {
      execute: jest.fn().mockResolvedValue(makeShoppingList()),
    } as unknown as jest.Mocked<CreateShoppingListUseCase>;
    listActiveShoppingSharesUseCase = {
      execute: jest
        .fn()
        .mockResolvedValue([makeShoppingShare({ id: 'share-active-1' })]),
    } as unknown as jest.Mocked<ListActiveShoppingSharesUseCase>;
    listShoppingListsUseCase = {
      execute: jest
        .fn()
        .mockResolvedValue([makeShoppingList({ id: 'list-1' })]),
    } as unknown as jest.Mocked<ListShoppingListsUseCase>;
    revokeShoppingShareByIdUseCase = {
      execute: jest.fn().mockResolvedValue(
        makeShoppingShare({
          id: 'share-active-1',
          revokedAt: new Date('2026-05-20T00:00:00.000Z'),
          updatedAt: new Date('2026-05-20T00:00:00.000Z'),
        }),
      ),
    } as unknown as jest.Mocked<RevokeShoppingShareByIdUseCase>;
    revokeShoppingShareUseCase = {
      execute: jest.fn().mockResolvedValue(
        makeShoppingShare({
          revokedAt: new Date('2026-05-20T00:00:00.000Z'),
          updatedAt: new Date('2026-05-20T00:00:00.000Z'),
        }),
      ),
    } as unknown as jest.Mocked<RevokeShoppingShareUseCase>;
    deleteShoppingListUseCase = {
      execute: jest.fn().mockResolvedValue(makeShoppingList({ id: 'list-1' })),
    } as unknown as jest.Mocked<DeleteShoppingListUseCase>;
    resolveHouseholdPantryAccessUseCase = {
      executeRead: jest.fn().mockResolvedValue(makeHouseholdAccess()),
      executeWrite: jest.fn().mockResolvedValue(makeHouseholdAccess()),
      executeOwner: jest.fn().mockResolvedValue(makeHouseholdAccess()),
    } as unknown as jest.Mocked<ResolveHouseholdPantryAccessUseCase>;
    recordHouseholdActivityUseCase = {
      execute: jest.fn(),
    } as unknown as jest.Mocked<RecordHouseholdActivityUseCase>;
    authCookieService = {
      ensureXsrfForRequest: jest.fn(),
    } as unknown as jest.Mocked<AuthCookieService>;

    controller = new PantryController(
      getPantryOverviewUseCase,
      getArchivedPantryItemsUseCase,
      getUserProfileUseCase,
      getWasteOverviewUseCase,
      closeShoppingPurchaseUseCase,
      createShoppingShareUseCase,
      createShoppingListUseCase,
      listActiveShoppingSharesUseCase,
      listShoppingListsUseCase,
      revokeShoppingShareByIdUseCase,
      revokeShoppingShareUseCase,
      deleteShoppingListUseCase,
      resolveHouseholdPantryAccessUseCase,
      recordHouseholdActivityUseCase,
      authCookieService,
    );
  });

  it('exports profile, overview, and archived pantry data', async () => {
    const exported = await controller.exportData(makeCurrentUser('user-1'), {
      method: 'GET',
      headers: {
        'x-request-id': 'req-export-1',
      },
    } as unknown as FastifyRequest);

    expect(exported.formatVersion).toBe(1);
    expect(exported.profile.email).toBe('chef@example.com');
    expect(exported.overview.userId).toBe('user-1');
    expect(exported.archived.productTypes[0].baseName).toBe('Detergente');
    expect(exported.archived.inventoryLots[0].variantName).toBe('Botella');
    expect(exported.shoppingLists[0].title).toBe('Mayoreo semanal');
    expect(getUserProfileUseCase.execute).toHaveBeenCalledWith('user-1');
    expect(getPantryOverviewUseCase.execute).toHaveBeenCalledWith('user-1');
    expect(getArchivedPantryItemsUseCase.execute).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('exports query limit metadata for the current data set boundaries', async () => {
    const exported = await controller.exportData(makeCurrentUser('user-1'), {
      method: 'GET',
      headers: {},
    } as unknown as FastifyRequest);

    expect(exported.limits).toEqual({
      activeProductTypesPerUser: 500,
      archivedProductTypesPerUser: 250,
      productTypeSearchResults: 25,
      activeInventoryLotsPerUser: 1000,
      archivedInventoryLotsPerUser: 250,
      archivedPantryPageSize: 50,
      inventoryLotsPerProductType: 500,
      shoppingCheckoutItems: 49,
      savedShoppingListsPerUser: 25,
      savedShoppingListItems: 100,
    });
  });

  it('loads archived pantry items with independent cursors', async () => {
    getArchivedPantryItemsUseCase.execute.mockResolvedValueOnce({
      ...makeArchivedItems(),
      pagination: {
        limit: 10,
        productTypesNextCursor: 'next-types',
        inventoryLotsNextCursor: 'next-lots',
        hasMoreProductTypes: true,
        hasMoreInventoryLots: true,
      },
    });

    const response = await controller.archived(makeCurrentUser('user-1'), {
      limit: 10,
      productTypesCursor: 'types-cursor',
      inventoryLotsCursor: 'lots-cursor',
      includeProductTypes: true,
      includeInventoryLots: false,
    });

    expect(getArchivedPantryItemsUseCase.execute).toHaveBeenCalledWith(
      'user-1',
      {
        limit: 10,
        productTypesCursor: 'types-cursor',
        inventoryLotsCursor: 'lots-cursor',
        includeProductTypes: true,
        includeInventoryLots: false,
      },
    );
    expect(response.pagination).toEqual({
      limit: 10,
      productTypesNextCursor: 'next-types',
      inventoryLotsNextCursor: 'next-lots',
      hasMoreProductTypes: true,
      hasMoreInventoryLots: true,
    });
  });

  it('loads waste overview from the household owner scope', async () => {
    resolveHouseholdPantryAccessUseCase.executeRead.mockResolvedValueOnce(
      makeHouseholdAccess({
        requesterUserId: 'member-user',
        pantryOwnerUserId: 'owner-user',
        role: 'viewer',
      }),
    );

    const response = await controller.wasteOverview(
      makeCurrentUser('member-user'),
    );

    expect(getWasteOverviewUseCase.execute).toHaveBeenCalledWith('owner-user');
    expect(response.eventCount).toBe(1);
  });

  it('logs request ids for overview and export reads', async () => {
    const logSpy = jest
      .spyOn(
        (controller as unknown as { logger: { log: jest.Mock } }).logger,
        'log',
      )
      .mockImplementation();

    await controller.overview(makeCurrentUser('user-1'), {
      method: 'GET',
      headers: {
        'x-request-id': 'req-overview-1',
      },
    } as unknown as FastifyRequest);
    await controller.exportData(makeCurrentUser('user-1'), {
      method: 'GET',
      headers: {
        'x-request-id': 'req-export-2',
      },
    } as unknown as FastifyRequest);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'pantry_overview_requested requestId=req-overview-1',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'pantry_overview_completed requestId=req-overview-1',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pantry_export_requested requestId=req-export-2'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('pantry_export_completed requestId=req-export-2'),
    );
  });

  it('requires XSRF and closes a shopping purchase for the current user', async () => {
    const request = {
      method: 'POST',
      headers: {
        'x-request-id': 'req-checkout-1',
      },
    } as unknown as FastifyRequest;
    const logSpy = jest
      .spyOn(
        (controller as unknown as { logger: { log: jest.Mock } }).logger,
        'log',
      )
      .mockImplementation();

    const response = await controller.checkout(
      makeCurrentUser('user-1'),
      {
        items: [
          {
            productTypeId: 'type-1',
            quantity: 2,
            unit: QuantityUnit.KILOGRAM,
            paidUnitPrice: 35.5,
            shoppingLocation: 'Mercado',
          },
        ],
      },
      request,
      '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
      makeReply(),
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(closeShoppingPurchaseUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      idempotencyKey: '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
      items: [
        {
          productTypeId: 'type-1',
          variantName: undefined,
          quantity: 2,
          unit: QuantityUnit.KILOGRAM,
          paidUnitPrice: 35.5,
          shoppingLocation: 'Mercado',
          expiresAt: undefined,
        },
      ],
    });
    expect(response[0].productTypeId).toBe('type-1');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('requestId=req-checkout-1'),
    );
  });

  it('creates a server-backed temporary shopping share for the current user', async () => {
    const request = {
      method: 'POST',
      headers: {
        'x-request-id': 'req-share-1',
      },
    } as unknown as FastifyRequest;

    const response = await controller.createShoppingShare(
      makeCurrentUser('user-1'),
      { text: 'Lista de compras\n- Arroz' },
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(createShoppingShareUseCase.execute).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      text: 'Lista de compras\n- Arroz',
    });
    expect(recordHouseholdActivityUseCase.execute).toHaveBeenCalledWith({
      householdId: 'household-1',
      type: 'shopping_share_created',
      actorUserId: 'user-1',
    });
    expect(response.token).toBe('opaque-token');
    expect(response.expiresAt).toEqual(new Date('2026-05-26T00:00:00.000Z'));
  });

  it('lists server-backed saved shopping lists for the household owner scope', async () => {
    const response = await controller.listShoppingLists(
      makeCurrentUser('user-1'),
      {
        method: 'GET',
        headers: {
          'x-request-id': 'req-list-shopping-lists-1',
        },
      } as unknown as FastifyRequest,
    );

    expect(listShoppingListsUseCase.execute).toHaveBeenCalledWith('user-1');
    expect(response[0].title).toBe('Mayoreo semanal');
    expect(response[0].items[0].baseName).toBe('Arroz');
  });

  it('saves a server-backed shopping list for the household owner scope', async () => {
    const request = {
      method: 'POST',
      headers: {
        'x-request-id': 'req-save-shopping-list-1',
      },
    } as unknown as FastifyRequest;

    const response = await controller.createShoppingList(
      makeCurrentUser('user-1'),
      {
        title: 'Mayoreo semanal',
        occasion: 'Quincena',
        shoppingLocation: 'Mayoreo',
        items: [
          {
            productTypeId: 'type-rice',
            baseName: 'Arroz',
            quantity: 2,
            unit: QuantityUnit.KILOGRAM,
            shoppingLocation: 'Mayoreo',
            estimatedUnitPrice: 35,
            estimatedLineTotal: 70,
          },
        ],
      },
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(createShoppingListUseCase.execute).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      title: 'Mayoreo semanal',
      occasion: 'Quincena',
      shoppingLocation: 'Mayoreo',
      items: [
        {
          productTypeId: 'type-rice',
          baseName: 'Arroz',
          quantity: 2,
          unit: QuantityUnit.KILOGRAM,
          shoppingLocation: 'Mayoreo',
          estimatedUnitPrice: 35,
          estimatedLineTotal: 70,
        },
      ],
    });
    expect(recordHouseholdActivityUseCase.execute).toHaveBeenCalledWith({
      householdId: 'household-1',
      type: 'shopping_list_saved',
      actorUserId: 'user-1',
      targetLabel: 'Mayoreo semanal',
    });
    expect(response.title).toBe('Mayoreo semanal');
  });

  it('deletes a server-backed shopping list by id', async () => {
    const request = {
      method: 'DELETE',
      headers: {
        'x-request-id': 'req-delete-shopping-list-1',
      },
    } as unknown as FastifyRequest;

    const response = await controller.deleteShoppingList(
      makeCurrentUser('user-1'),
      'list-1',
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(deleteShoppingListUseCase.execute).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      listId: 'list-1',
    });
    expect(recordHouseholdActivityUseCase.execute).toHaveBeenCalledWith({
      householdId: 'household-1',
      type: 'shopping_list_deleted',
      actorUserId: 'user-1',
      targetLabel: 'Mayoreo semanal',
    });
    expect(response.id).toBe('list-1');
  });

  it('lists active temporary shopping shares for the current user without raw tokens', async () => {
    const response = await controller.listActiveShoppingShares(
      makeCurrentUser('user-1'),
      {
        method: 'GET',
        headers: {
          'x-request-id': 'req-share-list-1',
        },
      } as unknown as FastifyRequest,
    );

    expect(listActiveShoppingSharesUseCase.execute).toHaveBeenCalledWith(
      'user-1',
    );
    expect(response).toEqual([
      {
        id: 'share-active-1',
        createdAt: new Date('2026-05-19T00:00:00.000Z'),
        expiresAt: new Date('2026-05-26T00:00:00.000Z'),
        revokedAt: undefined,
      },
    ]);
    expect(response[0].token).toBeUndefined();
  });

  it('revokes a temporary shopping share by id for persisted history controls', async () => {
    const request = {
      method: 'DELETE',
      headers: {
        'x-request-id': 'req-share-id-1',
      },
    } as unknown as FastifyRequest;

    const response = await controller.revokeShoppingShareById(
      makeCurrentUser('user-1'),
      'share-active-1',
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(revokeShoppingShareByIdUseCase.execute).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      shareId: 'share-active-1',
    });
    expect(recordHouseholdActivityUseCase.execute).toHaveBeenCalledWith({
      householdId: 'household-1',
      type: 'shopping_share_revoked',
      actorUserId: 'user-1',
    });
    expect(response.id).toBe('share-active-1');
    expect(response.token).toBeUndefined();
    expect(response.revokedAt).toEqual(new Date('2026-05-20T00:00:00.000Z'));
  });

  it('revokes a temporary shopping share for the current user', async () => {
    const request = {
      method: 'DELETE',
      headers: {
        'x-request-id': 'req-share-2',
      },
    } as unknown as FastifyRequest;

    const response = await controller.revokeShoppingShare(
      makeCurrentUser('user-1'),
      'opaque-token',
      request,
    );

    expect(authCookieService.ensureXsrfForRequest).toHaveBeenCalledWith(
      request,
    );
    expect(revokeShoppingShareUseCase.execute).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      token: 'opaque-token',
    });
    expect(recordHouseholdActivityUseCase.execute).toHaveBeenCalledWith({
      householdId: 'household-1',
      type: 'shopping_share_revoked',
      actorUserId: 'user-1',
    });
    expect(response.token).toBeUndefined();
    expect(response.revokedAt).toEqual(new Date('2026-05-20T00:00:00.000Z'));
  });

  it('reads pantry data from the household owner scope for a member', async () => {
    resolveHouseholdPantryAccessUseCase.executeRead.mockResolvedValueOnce(
      makeHouseholdAccess({
        requesterUserId: 'member-user',
        pantryOwnerUserId: 'owner-user',
        role: 'viewer',
      }),
    );

    await controller.overview(makeCurrentUser('member-user'), {
      method: 'GET',
      headers: {
        'x-request-id': 'req-member-overview-1',
      },
    } as unknown as FastifyRequest);

    expect(
      resolveHouseholdPantryAccessUseCase.executeRead,
    ).toHaveBeenCalledWith('member-user');
    expect(getPantryOverviewUseCase.execute).toHaveBeenCalledWith('owner-user');
  });

  it('writes checkout data to the household owner scope for an editor', async () => {
    resolveHouseholdPantryAccessUseCase.executeWrite.mockResolvedValueOnce(
      makeHouseholdAccess({
        requesterUserId: 'member-user',
        pantryOwnerUserId: 'owner-user',
        role: 'editor',
      }),
    );

    await controller.checkout(
      makeCurrentUser('member-user'),
      {
        items: [
          {
            productTypeId: 'type-1',
            quantity: 1,
            unit: QuantityUnit.PIECE,
          },
        ],
      },
      {
        method: 'POST',
        headers: {},
      } as unknown as FastifyRequest,
      '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
      makeReply(),
    );

    expect(
      resolveHouseholdPantryAccessUseCase.executeWrite,
    ).toHaveBeenCalledWith('member-user');
    expect(closeShoppingPurchaseUseCase.execute).toHaveBeenCalledWith({
      userId: 'owner-user',
      idempotencyKey: '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
      items: [
        {
          productTypeId: 'type-1',
          variantName: undefined,
          quantity: 1,
          unit: QuantityUnit.PIECE,
          paidUnitPrice: undefined,
          shoppingLocation: undefined,
          expiresAt: undefined,
        },
      ],
    });
  });
});

function makeReply(): FastifyReply {
  return {
    header: jest.fn().mockReturnThis(),
  } as unknown as FastifyReply;
}

function makeProfile() {
  return {
    id: 'user-1',
    email: 'chef@example.com',
    username: 'chef',
    status: 'active' as const,
    connectedIdentityCount: 2,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    retentionPolicy: {
      archivedRecordRetentionDays: 365,
      archivedRecordAutoDeleteEnabled: false,
      temporaryShoppingShareRetentionDays: 7,
      permanentlyDeletedRecords: 'removed_immediately' as const,
      accountDeletion: 'local_and_cognito_delete_requested' as const,
    },
    preferences: makePreferences(),
    knownDevices: [],
  };
}

function makeWasteOverview() {
  return {
    userId: 'user-1',
    generatedAt: new Date('2026-06-09T00:00:00.000Z'),
    windowDays: 30,
    eventCount: 1,
    estimatedLossTotal: 25,
    totalQuantityByUnit: [
      {
        unit: QuantityUnit.PIECE,
        quantity: 1,
      },
    ],
    reasonBreakdown: [
      {
        reason: 'expired' as const,
        eventCount: 1,
        estimatedLossTotal: 25,
      },
    ],
    recentEvents: [
      {
        id: 'waste-1',
        productName: 'Leche',
        quantity: 1,
        unit: QuantityUnit.PIECE,
        reason: 'expired' as const,
        estimatedLoss: 25,
        occurredAt: new Date('2026-06-09T00:00:00.000Z'),
      },
    ],
  };
}

function makeCurrentUser(userId: string): AuthenticatedUser {
  return {
    userId,
    authSubjectId: `${userId}-subject`,
  };
}

function makeOverview() {
  return {
    userId: 'user-1',
    generatedAt: new Date('2026-05-17T00:00:00.000Z'),
    preferences: makePreferences(),
    items: [],
    expiringItems: [],
    depletingItems: [],
    shoppingPlanItems: [],
    shoppingPlanEstimatedTotal: 0,
    shoppingRouteGroups: [],
    priceReferenceItems: [],
    stapleItems: [],
    stapleCatalogGroups: [],
    valueInsights: {
      stapleCount: 0,
      stapleAttentionCount: 0,
      estimatedShoppingTotal: 0,
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

function makeArchivedItems() {
  const timestamp = new Date('2026-05-10T00:00:00.000Z');

  return {
    productTypes: [
      {
        id: 'type-1',
        userId: 'user-1',
        baseName: 'Detergente',
        category: ProductCategory.CLEANING,
        defaultUnit: QuantityUnit.LITER,
        planningSettings: {
          planningEnabled: true,
        },
        shoppingMetadata: {
          householdStaple: false,
          buyOnlyOnPromo: false,
          replenishWhenLow: true,
        },
        archivedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    inventoryLots: [
      {
        id: 'lot-1',
        userId: 'user-1',
        productTypeId: 'type-1',
        variantName: 'Botella',
        quantity: 1,
        unit: QuantityUnit.LITER,
        archivedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

function makeInventoryLot(): InventoryLot {
  return InventoryLot.fromPrimitives({
    id: 'lot-1',
    userId: 'user-1',
    productTypeId: 'type-1',
    quantity: 2,
    unit: QuantityUnit.KILOGRAM,
    purchaseDate: new Date('2026-05-18T00:00:00.000Z'),
    createdAt: new Date('2026-05-18T00:00:00.000Z'),
    updatedAt: new Date('2026-05-18T00:00:00.000Z'),
  });
}

function makeShoppingShare(
  overrides: Partial<ReturnType<ShoppingShare['toPrimitives']>> = {},
): ShoppingShare {
  return ShoppingShare.fromPrimitives({
    id: 'share-1',
    ownerUserId: 'user-1',
    tokenHash:
      '43d7c60747d45779d55e1dfb8a6f3a88decf9b9830fdd308395650c9b67bb7ea',
    text: 'Lista de compras\n- Arroz',
    createdAt: new Date('2026-05-19T00:00:00.000Z'),
    expiresAt: new Date('2026-05-26T00:00:00.000Z'),
    updatedAt: new Date('2026-05-19T00:00:00.000Z'),
    ...overrides,
  });
}

function makeShoppingList(
  overrides: Partial<ReturnType<ShoppingList['toPrimitives']>> = {},
): ShoppingList {
  return ShoppingList.fromPrimitives({
    id: 'list-1',
    ownerUserId: 'user-1',
    title: 'Mayoreo semanal',
    occasion: 'Quincena',
    shoppingLocation: 'Mayoreo',
    items: [
      {
        productTypeId: 'type-rice',
        baseName: 'Arroz',
        quantity: 2,
        unit: QuantityUnit.KILOGRAM,
        shoppingLocation: 'Mayoreo',
        estimatedUnitPrice: 35,
        estimatedLineTotal: 70,
      },
    ],
    createdAt: new Date('2026-05-19T00:00:00.000Z'),
    updatedAt: new Date('2026-05-19T00:00:00.000Z'),
    ...overrides,
  });
}

function makePreferences() {
  return {
    expirationWarningDays: 7,
    showExpiredEntryAlert: true,
    depletionWarningThresholdRatio: 1,
    shoppingPlanLeadDays: 3,
    showGuidanceTips: true,
  };
}

function makeHouseholdAccess(
  overrides: Partial<{
    requesterUserId: string;
    householdId: string;
    pantryOwnerUserId: string;
    role: 'owner' | 'editor' | 'viewer';
  }> = {},
) {
  return {
    requesterUserId: 'user-1',
    householdId: 'household-1',
    pantryOwnerUserId: 'user-1',
    role: 'owner' as const,
    ...overrides,
  };
}
