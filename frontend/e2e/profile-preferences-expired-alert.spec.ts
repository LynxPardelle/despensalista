import { expect, test } from '@playwright/test';

const effectivePlanningSettings = {
  planningEnabled: true,
  expirationWarningDays: 7,
  depletionWarningThresholdRatio: 1,
  shoppingPlanLeadDays: 3,
  expirationWarningDaysSource: 'profile',
  depletionWarningThresholdRatioSource: 'profile',
  shoppingPlanLeadDaysSource: 'profile',
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        status: 'active',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      }),
    });
  });

  await page.route('**/api/profile', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        status: 'active',
        connectedIdentityCount: 2,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
        preferences: {
          expirationWarningDays: 10,
          showExpiredEntryAlert: true,
          depletionWarningThresholdRatio: 1.5,
          shoppingPlanLeadDays: 5,
          showGuidanceTips: true,
        },
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
        knownDevices: [],
      }),
    });
  });

  await page.route('**/api/household', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        household: {
          id: 'household-1',
          name: 'Hogar de chef',
          ownerUserId: 'user-1',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
        currentMember: {
          householdId: 'household-1',
          userId: 'user-1',
          email: 'chef@example.com',
          username: 'chef',
          role: 'owner',
          joinedAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
        members: [],
        invites: [],
        activities: [],
      }),
    });
  });

  await page.route('**/api/household/access', async (route) => {
    await route.fulfill({ json: {
      householdId: 'household-1', canRedeem: true, grants: [], billingBlocksRedemption: false,
    } });
  });

  await page.route('**/api/pantry/waste-overview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'user-1',
        generatedAt: '2026-04-28T12:00:00.000Z',
        windowDays: 30,
        eventCount: 0,
        estimatedLossTotal: 0,
        totalQuantityByUnit: [],
        reasonBreakdown: [],
        recentEvents: [],
      }),
    });
  });

  await page.route('**/api/pantry/shopping-lists', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });

  await page.route('**/api/pantry/shopping-shares', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });

  await page.route('**/api/profile/preferences', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        expirationWarningDays: 7,
        showExpiredEntryAlert: false,
        depletionWarningThresholdRatio: 1,
        shoppingPlanLeadDays: 3,
        showGuidanceTips: true,
      }),
    });
  });

  await page.route('**/api/pantry/overview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'user-1',
        householdId: 'household-1',
        generatedAt: '2026-04-28T12:00:00.000Z',
        preferences: {
          expirationWarningDays: 7,
          showExpiredEntryAlert: true,
          depletionWarningThresholdRatio: 1,
          shoppingPlanLeadDays: 3,
          showGuidanceTips: true,
        },
        items: [
          {
            productTypeId: 'type-tuna',
            baseName: 'Atun',
            category: 'food',
            defaultUnit: 'piezas',
            totalQuantity: 3,
            lotCount: 2,
            nextExpirationAt: '2026-04-20T00:00:00.000Z',
            expiringSoonQuantity: 3,
            hasDepletionRule: false,
            effectivePlanningSettings,
            variants: ['Dolores'],
            lots: [
              {
                lotId: 'lot-expired',
                variantName: 'Dolores',
                quantity: 2,
                unit: 'piezas',
                expiresAt: '2026-04-20T00:00:00.000Z',
                purchaseDate: null,
                expirationStatus: 'expired',
                updatedAt: '2026-04-21T00:00:00.000Z',
              },
              {
                lotId: 'lot-critical',
                quantity: 1,
                unit: 'piezas',
                expiresAt: '2026-04-28T00:00:00.000Z',
                purchaseDate: null,
                expirationStatus: 'critical',
                updatedAt: '2026-04-21T00:00:00.000Z',
              },
            ],
          },
        ],
        expiringItems: [
          {
            productTypeId: 'type-tuna',
            baseName: 'Atun',
            category: 'food',
            totalExpiringQuantity: 3,
            nextExpirationAt: '2026-04-20T00:00:00.000Z',
            lotCount: 2,
            lots: [
              {
                lotId: 'lot-expired',
                variantName: 'Dolores',
                quantity: 2,
                unit: 'piezas',
                expiresAt: '2026-04-20T00:00:00.000Z',
                purchaseDate: null,
                expirationStatus: 'expired',
                updatedAt: '2026-04-21T00:00:00.000Z',
              },
              {
                lotId: 'lot-critical',
                quantity: 1,
                unit: 'piezas',
                expiresAt: '2026-04-28T00:00:00.000Z',
                purchaseDate: null,
                expirationStatus: 'critical',
                updatedAt: '2026-04-21T00:00:00.000Z',
              },
            ],
          },
        ],
        depletingItems: [],
        shoppingPlanItems: [],
      }),
    });
  });
});

test('a fresh invitation survives login and is accepted before any household or pantry read', async ({ page }) => {
  let authenticated = false;
  const prematureReads: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/household' || path === '/api/pantry/overview') prematureReads.push(path);
  });
  await page.route('**/api/auth/me', async route => route.fulfill({
    status: authenticated ? 200 : 401,
    contentType: 'application/json',
    body: JSON.stringify(authenticated ? {
      id: 'user-1', email: 'chef@example.com', username: 'chef', status: 'active',
      createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z',
    } : { message: 'Unauthorized' }),
  }));
  await page.route('**/api/auth/cognito/providers', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ providers: ['COGNITO'] }),
  }));
  await page.route('**/api/auth/cognito/login?**', async route => {
    const destination = new URL(route.request().url()).searchParams.get('redirectTo');
    expect(destination).toBe('/profile?householdInvite=fresh-invite-token');
    authenticated = true;
    await route.fulfill({ status: 302, headers: { location: destination! } });
  });
  await page.route('**/api/household/invites/accept', async route => {
    expect(route.request().postDataJSON()).toEqual({ token: 'fresh-invite-token' });
    expect(prematureReads).toEqual([]);
    const now = '2026-04-01T00:00:00.000Z';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      household: { id: 'invited-household', name: 'Hogar invitado', ownerUserId: 'owner', createdAt: now, updatedAt: now },
      currentMember: { householdId: 'invited-household', userId: 'user-1', email: 'chef@example.com', username: 'chef', role: 'editor', joinedAt: now, updatedAt: now },
      members: [], invites: [], activities: [],
    }) });
  });
  await page.route('**/api/household/access', route => route.fulfill({ json: {
    householdId: 'invited-household', canRedeem: false, grants: [], billingBlocksRedemption: false,
  } }));
  await page.goto('/profile?householdInvite=fresh-invite-token');
  await expect(page).toHaveURL(/\/login\?redirectTo=/);
  await page.getByRole('button', { name: 'Entrar con correo' }).click();
  await expect(page.getByText('Invitacion aceptada.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Hogar invitado\s*·\s*0\s*personas/)).toBeVisible();
  await expect(page).toHaveURL(/\/profile$/);
  expect(prematureReads).toEqual([]);
});

test('redeems a gift for the displayed household and shows lifetime access without opening Checkout', async ({ page }) => {
  const code = 'DL1.browser-test-code';
  let redeemed = false;
  const access = () => ({
    householdId: 'household-1', canRedeem: true, billingBlocksRedemption: false,
    grants: redeemed ? [{ id: 'browser-grant', plan: 'plus', mode: 'plan', startsAt: '2026-01-01T00:00:00.000Z', expiresAt: null }] : [],
  });
  const paymentRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/billing/checkout')) paymentRequests.push(request.url());
  });
  await page.route('**/api/billing/status', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/household/access', route => route.fulfill({ json: access() }));
  await page.route('**/api/household/access/redeem', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ code, householdId: 'household-1' });
    expect(route.request().url()).not.toContain(code);
    redeemed = true;
    await route.fulfill({ json: { ...access(), replayed: false } });
  });

  await page.goto('/profile');
  await page.getByLabel('Código de acceso', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Canjear código', exact: true }).click();
  await expect(page.getByText('Código canjeado.', { exact: false })).toBeVisible();
  await expect(page.getByText('Acceso vitalicio.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Código de acceso', { exact: true })).toHaveValue('');
  expect(paymentRequests).toEqual([]);
  expect(await page.evaluate(value => Object.values(localStorage).some(item => item.includes(value)), code)).toBe(false);
});

test('switches households only after confirmation and opens the new pantry', async ({ page }) => {
  const seenBodies: unknown[] = [];
  const now = '2026-04-01T00:00:00.000Z';
  await page.route('**/api/household/invites/accept', async (route) => {
    const body = route.request().postDataJSON();
    seenBodies.push(body);
    if (!body.switchFromHouseholdId) {
      await route.fulfill({ status: 400, json: {
        code: 'HOUSEHOLD_ALREADY_MEMBER', role: 'owner',
        householdSwitch: {
          fromHouseholdId: 'household-1', fromName: 'Hogar de chef',
          toName: 'Casa de familia', role: 'editor', closesOriginal: true,
        },
      } });
      return;
    }
    await route.fulfill({ json: {
      household: { id: 'household-2', name: 'Casa de familia', ownerUserId: 'owner', createdAt: now, updatedAt: now },
      currentMember: { householdId: 'household-2', userId: 'user-1', email: 'chef@example.com', username: 'chef', role: 'editor', joinedAt: now, updatedAt: now },
      members: [], invites: [], activities: [],
    } });
  });
  await page.route('**/api/pantry/overview', route => route.fulfill({ json: {
    householdId: 'household-2', userId: 'owner', generatedAt: now,
    preferences: { showGuidanceTips: true },
    items: [], expiringItems: [], depletingItems: [], shoppingPlanItems: [],
  } }));

  await page.goto('/profile?householdInvite=family-invite-token');
  await expect(page.getByRole('heading', { name: 'Cambiar de hogar' })).toBeVisible();
  await expect(page.getByText('Tu hogar personal se cerrará al confirmar.')).toBeVisible();
  expect(seenBodies).toEqual([{ token: 'family-invite-token' }]);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cambiar de hogar' })).toHaveCount(0);
  expect(seenBodies).toHaveLength(1);
  await page.getByRole('button', { name: 'Aceptar invitación' }).click();
  await page.getByRole('button', { name: 'Confirmar cambio de hogar' }).click();
  await expect(page.getByText('Ahora perteneces a Casa de familia.')).toBeVisible();
  await expect(page).toHaveURL(/\/profile$/);
  expect(seenBodies).toEqual([
    { token: 'family-invite-token' }, { token: 'family-invite-token' },
    { token: 'family-invite-token', switchFromHouseholdId: 'household-1' },
  ]);

  const overview = page.waitForResponse('**/api/pantry/overview');
  await page.getByRole('link', { name: 'Ir a la despensa de Casa de familia' }).click();
  expect((await (await overview).json()).householdId).toBe('household-2');
  await expect(page.getByRole('heading', { name: 'Registra tu primera compra' })).toBeVisible();
});

test('loads profile preferences and saves an update', async ({ page }) => {
  await page.goto('/profile');

  await expect(page.getByRole('heading', { name: /Preferencias/ })).toBeVisible();
  await expect(page.getByText('chef@example.com')).toBeVisible();

  await page.getByLabel(/Mostrar alerta/).uncheck();
  await page.getByRole('button', { name: 'Guardar preferencias' }).click();

  await expect(page.getByText('Preferencias guardadas.')).toBeVisible();
});

test('scopes pantry deletion after opening the profile directly', async ({ page }) => {
  const pantryReads: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/pantry/overview') pantryReads.push(request.url());
  });
  await page.route('**/api/profile/pantry-data', async route => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().headers()['x-despensa-household']).toBe('household-1');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    expect(route.request().postDataJSON()).toEqual({ confirmationText: 'ELIMINAR' });
    await route.fulfill({ json: { deletedInventoryLotCount: 0, deletedProductTypeCount: 0,
      deletedShoppingListCount: 0, deletedShoppingShareCount: 0, deletedWasteEventCount: 0 } });
  });

  await page.goto('/profile');
  await page.getByPlaceholder('ELIMINAR', { exact: true }).fill('ELIMINAR');
  await page.getByRole('button', { name: 'Eliminar datos', exact: true }).click();
  await expect(page.getByText(/Datos eliminados: 0 lotes/)).toBeVisible();
  expect(pantryReads).toEqual([]);
});

test('shows and dismisses expired entry alert on pantry entry', async ({
  page,
}) => {
  await page.goto('/pantry');

  const alert = page.getByTestId('expired-entry-alert');
  await expect(alert).toContainText('Hay productos que ya caducaron');
  await expect(alert).toContainText('1 lote');
  await expect(page.getByText('Ya caducó: 2 piezas').first()).toBeVisible();
  await expect(page.getByText('Por caducar: 1 pieza').first()).toBeVisible();
  await expect(page.getByText('Ya caducó el 20 Apr 2026')).toBeVisible();
  await expect(page.getByText('Primero caducó el 20 Apr 2026')).toBeVisible();

  await page.getByTestId('dismiss-expired-alert').click();

  await expect(alert).toHaveCount(0);
});

test('shows replenishment guidance, purchase date, per-type settings, and archive flow', async ({
  page,
}) => {
  let savedPlanningSettings = false;
  let archivedLot = false;

  await page.route('**/api/pantry/overview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: 'user-1',
        householdId: 'household-1',
        generatedAt: '2026-04-29T12:00:00.000Z',
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
            effectivePlanningSettings,
            estimatedCurrentQuantity: 0,
            estimatedConsumedQuantity: 1,
            estimatedDepletionAt: '2026-04-24T00:00:00.000Z',
            variants: ['Botella grande'],
            lots: [
              {
                lotId: 'lot-detergent',
                variantName: 'Botella grande',
                quantity: 1,
                unit: 'lt',
                expiresAt: null,
                purchaseDate: '2026-03-24T00:00:00.000Z',
                expirationStatus: 'none',
                updatedAt: '2026-04-29T00:00:00.000Z',
              },
            ],
          },
        ],
        expiringItems: [],
        depletingItems: [
          {
            productTypeId: 'type-detergent',
            baseName: 'Detergente',
            category: 'cleaning',
            defaultUnit: 'lt',
            totalQuantity: 1,
            estimatedCurrentQuantity: 0,
            estimatedConsumedQuantity: 1,
            estimatedDepletionAt: '2026-04-24T00:00:00.000Z',
            depletionRule: {
              enabled: true,
              consumeAmount: 1,
              unit: 'lt',
              everyAmount: 1,
              everyPeriod: 'month',
              anchorDate: '2026-03-24T00:00:00.000Z',
            },
            effectivePlanningSettings,
          },
        ],
        shoppingPlanItems: [
          {
            productTypeId: 'type-detergent',
            baseName: 'Detergente',
            category: 'cleaning',
            defaultUnit: 'lt',
            totalQuantity: 1,
            estimatedCurrentQuantity: 0,
            estimatedConsumedQuantity: 1,
            estimatedDepletionAt: '2026-04-24T00:00:00.000Z',
            recommendedPurchaseAt: '2026-04-24T00:00:00.000Z',
            suggestedPurchaseQuantity: 1,
            urgency: 'depleted',
            depletionRule: {
              enabled: true,
              consumeAmount: 1,
              unit: 'lt',
              everyAmount: 1,
              everyPeriod: 'month',
              anchorDate: '2026-03-24T00:00:00.000Z',
            },
            effectivePlanningSettings,
          },
        ],
      }),
    });
  });

  await page.route(
    '**/api/product-types/type-detergent/planning-settings',
    async (route) => {
      savedPlanningSettings = true;
      expect(route.request().method()).toBe('PATCH');
      expect(route.request().headers()['x-despensa-household']).toBe('household-1');
      expect(route.request().postDataJSON()).toMatchObject({
        planningEnabled: true,
        shoppingPlanLeadDaysOverride: 5,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'type-detergent',
          userId: 'user-1',
          baseName: 'Detergente',
          category: 'cleaning',
          defaultUnit: 'lt',
          planningSettings: {
            planningEnabled: true,
            shoppingPlanLeadDaysOverride: 5,
          },
          archivedAt: null,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        }),
      });
    },
  );

  await page.route('**/api/inventory-lots/lot-detergent/archive', async (route) => {
    archivedLot = true;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-despensa-household']).toBe('household-1');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'lot-detergent',
        userId: 'user-1',
        productTypeId: 'type-detergent',
        variantName: 'Botella grande',
        quantity: 1,
        unit: 'lt',
        expiresAt: null,
        purchaseDate: '2026-03-24T00:00:00.000Z',
        archivedAt: '2026-04-29T00:00:00.000Z',
        expirationStatus: 'none',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      }),
    });
  });

  await page.route('**/api/pantry/archived**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        productTypes: [],
        inventoryLots: [],
      }),
    });
  });

  await page.goto('/pantry');

  const guidance = page.getByTestId('pantry-guidance-card');
  await expect(guidance).toContainText('Ayuda para usar Despensa Lista');
  await guidance.getByRole('button', { name: 'Ocultar por ahora' }).click();
  await expect(guidance).toHaveCount(0);

  await expect(page.getByText('Comprar ya')).toBeVisible();
  await expect(page.getByText('Queda estimado').first()).toBeVisible();

  await page.getByRole('button', { name: /Detergente/ }).click();
  await expect(page.getByText('Comprado el 24 Mar 2026')).toBeVisible();
  await expect(page.getByText('Ajustes de Detergente')).toBeVisible();

  await page.getByRole('button', { name: 'Ajustar compras y alertas' }).click();
  await page.getByLabel(/D.as antes para comprar/).fill('5');
  await page.getByRole('button', { name: 'Guardar ajustes' }).click();
  expect(savedPlanningSettings).toBe(true);

  await page.getByRole('button', { name: 'Archivar lote' }).click();
  const archiveConfirmation = page.getByRole('group', {
    name: 'Confirmar archivo de Botella grande',
  });
  await expect(archiveConfirmation).toContainText('Archivar Botella grande');
  await archiveConfirmation
    .getByRole('button', { name: 'Confirmar archivo' })
    .click();
  await expect.poll(() => archivedLot).toBe(true);

  await page.getByRole('button', { name: 'Ver archivados' }).click();
  await expect(page.getByText('No hay elementos archivados.')).toBeVisible();
});
