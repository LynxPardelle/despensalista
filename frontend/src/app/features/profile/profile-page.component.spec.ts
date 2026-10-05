import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterTestingModule } from '@angular/router/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthFacade } from '../../core/services/auth.facade';
import { PantryService } from '../../core/services/pantry.service';
import { ProfileService } from '../../core/services/profile.service';
import { ProfilePageComponent } from './profile-page.component';

describe('ProfilePageComponent', () => {
  let fixture: ComponentFixture<ProfilePageComponent>;
  let component: ProfilePageComponent;
  let authFacade: jasmine.SpyObj<AuthFacade>;
  let profileService: jasmine.SpyObj<ProfileService>;
  let pantryService: jasmine.SpyObj<PantryService>;

  beforeEach(async () => {
    window.localStorage.removeItem(
      'despensalista.monetizationDiscoveryEvents.v1',
    );
    window.localStorage.removeItem(
      'despensalista.pendingPantryDeletionIdempotencyKey.v1',
    );

    authFacade = jasmine.createSpyObj<AuthFacade>('AuthFacade', ['logout']);
    profileService = jasmine.createSpyObj<ProfileService>('ProfileService', [
      'getProfile',
      'updatePreferences',
      'deletePantryData',
      'deleteAccount',
      'signOutAllSessions',
      'getHouseholdWorkspace',
      'createHouseholdInvite',
      'acceptHouseholdInvite',
      'revokeHouseholdInvite',
      'removeHouseholdMember',
    ]);
    profileService.getProfile.and.returnValue(
      of({
        id: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        status: 'active',
        connectedIdentityCount: 2,
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
        updatedAt: new Date('2026-04-02T00:00:00.000Z'),
        preferences: {
          expirationWarningDays: 10,
          showExpiredEntryAlert: false,
          depletionWarningThresholdRatio: 1.5,
          shoppingPlanLeadDays: 5,
          showGuidanceTips: false,
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
        knownDevices: [
          {
            id: 'device-hash-1',
            label: 'Chrome en Windows',
            userAgentSummary: 'Chrome en Windows',
            firstSeenAt: new Date('2026-06-08T00:00:00.000Z'),
            lastSeenAt: new Date('2026-06-08T00:01:00.000Z'),
            seenCount: 2,
            current: true,
          },
        ],
      }),
    );
    profileService.updatePreferences.and.returnValue(
      of({
        expirationWarningDays: 7,
        showExpiredEntryAlert: true,
        depletionWarningThresholdRatio: 1,
        shoppingPlanLeadDays: 3,
        showGuidanceTips: true,
      }),
    );
    profileService.deletePantryData.and.returnValue(
      of({
        deletedInventoryLotCount: 5,
        deletedProductTypeCount: 3,
        deletedShoppingListCount: 1,
        deletedShoppingShareCount: 2,
        deletedWasteEventCount: 1,
      }),
    );
    profileService.deleteAccount.and.returnValue(
      of({
        deletedInventoryLotCount: 5,
        deletedProductTypeCount: 3,
        deletedShoppingListCount: 1,
        deletedShoppingShareCount: 2,
        deletedWasteEventCount: 1,
        deletedKnownDeviceCount: 1,
        deletedCognitoIdentityCount: 1,
      }),
    );
    profileService.signOutAllSessions.and.returnValue(
      of({
        revokedCognitoSessionCount: 1,
        localSessionCleared: true,
      }),
    );
    profileService.getHouseholdWorkspace.and.returnValue(
      of(makeHouseholdWorkspace()),
    );
    profileService.createHouseholdInvite.and.returnValue(
      of({
        invite: makeHouseholdWorkspace().invites[0],
        token: 'invite-token-safe-123',
      }),
    );
    profileService.acceptHouseholdInvite.and.returnValue(
      of(makeHouseholdWorkspace()),
    );
    profileService.revokeHouseholdInvite.and.returnValue(
      of(makeHouseholdWorkspace().invites[0]),
    );
    profileService.removeHouseholdMember.and.returnValue(
      of({
        ...makeHouseholdWorkspace(),
        members: [makeHouseholdWorkspace().members[0]],
      }),
    );
    pantryService = jasmine.createSpyObj<PantryService>('PantryService', [
      'exportPantryData',
    ]);
    pantryService.exportPantryData.and.returnValue(
      of({
        formatVersion: 1,
        exportedAt: '2026-05-17T00:00:00.000Z',
        profile: {
          id: 'user-1',
          email: 'chef@example.com',
          username: 'chef',
          status: 'active',
          connectedIdentityCount: 2,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
          preferences: {
            expirationWarningDays: 10,
            showExpiredEntryAlert: false,
            depletionWarningThresholdRatio: 1.5,
            shoppingPlanLeadDays: 5,
            showGuidanceTips: false,
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
          knownDevices: [
            {
              id: 'device-hash-1',
              label: 'Chrome en Windows',
              userAgentSummary: 'Chrome en Windows',
              firstSeenAt: '2026-06-08T00:00:00.000Z',
              lastSeenAt: '2026-06-08T00:01:00.000Z',
              seenCount: 2,
              current: true,
            },
          ],
        },
        overview: {
          userId: 'user-1',
          generatedAt: '2026-05-17T00:00:00.000Z',
          preferences: {
            expirationWarningDays: 10,
            showExpiredEntryAlert: false,
            depletionWarningThresholdRatio: 1.5,
            shoppingPlanLeadDays: 5,
            showGuidanceTips: false,
          },
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
        },
        archived: {
          productTypes: [],
          inventoryLots: [],
        },
        shoppingLists: [],
        limits: {
          activeProductTypesPerUser: 500,
          archivedProductTypesPerUser: 250,
          productTypeSearchResults: 25,
          activeInventoryLotsPerUser: 1000,
          archivedInventoryLotsPerUser: 250,
          archivedPantryPageSize: 50,
          inventoryLotsPerProductType: 500,
          shoppingCheckoutItems: 50,
          savedShoppingListsPerUser: 25,
          savedShoppingListItems: 100,
        },
      }),
    );

    await TestBed.configureTestingModule({
      imports: [ProfilePageComponent, ReactiveFormsModule, RouterTestingModule],
      providers: [
        {
          provide: AuthFacade,
          useValue: authFacade,
        },
        {
          provide: ProfileService,
          useValue: profileService,
        },
        {
          provide: PantryService,
          useValue: pantryService,
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProfilePageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders account summary and loaded preferences', () => {
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('chef@example.com');
    expect(component.preferencesForm.getRawValue()).toEqual({
      expirationWarningDays: 10,
      showExpiredEntryAlert: false,
      depletionWarningThresholdRatio: 1.5,
      shoppingPlanLeadDays: 5,
      showGuidanceTips: false,
    });
  });

  it('accepts a fresh invite before a household read can create a personal household', () => {
    const route = TestBed.inject(ActivatedRoute);
    spyOnProperty(route.snapshot, 'queryParamMap', 'get').and.returnValue(
      convertToParamMap({ householdInvite: 'fresh-invite-token' }),
    );
    profileService.getHouseholdWorkspace.calls.reset();
    profileService.acceptHouseholdInvite.calls.reset();
    component.ngOnInit();
    expect(profileService.acceptHouseholdInvite).toHaveBeenCalledWith(
      'fresh-invite-token',
    );
    expect(profileService.getHouseholdWorkspace).not.toHaveBeenCalled();
    expect(component.householdMessage).toBe('Invitacion aceptada.');
  });

  it('preserves the existing household when joining another is rejected', () => {
    const current = component.householdWorkspace;
    profileService.acceptHouseholdInvite.and.returnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { message: 'User already belongs to a household' },
          }),
      ),
    );
    component.householdAcceptForm.setValue({ token: 'other-household-token' });
    component.acceptHouseholdInvite();
    expect(component.householdWorkspace).toBe(current);
    expect(component.householdMessage).toBeNull();
    expect(component.householdError).toBeTruthy();
  });

  it('renders clear privacy and data lifecycle boundaries', () => {
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('Ciclo de vida de datos');
    expect(compiled.textContent).toContain(
      'Borrar cuenta elimina datos locales',
    );
    expect(compiled.textContent).toContain(
      'Exportar datos no crea permisos compartidos',
    );
    expect(compiled.textContent).toContain('Archivados se conservan');
    expect(compiled.textContent).toContain('Step-up esta preparado');
    expect(compiled.textContent).toContain('Dispositivos vistos');
    expect(compiled.textContent).toContain('Chrome en Windows');
  });

  it('renders Stripe monetization discovery without real checkout', () => {
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('Plan y Stripe');
    expect(compiled.textContent).toContain('Stripe');
    expect(compiled.textContent).toContain('Checkout Sessions');
    expect(compiled.textContent).toContain('Billing + Prices');
    expect(compiled.textContent).toContain('Customer Portal');
    expect(compiled.textContent).toContain('Sin checkout real en esta tanda');
  });

  it('records local monetization interest without profile or payment data', () => {
    component.registerMonetizationInterest('plus-household');

    const rawEvents = window.localStorage.getItem(
      'despensalista.monetizationDiscoveryEvents.v1',
    );
    const events = JSON.parse(rawEvents ?? '[]');

    expect(component.monetizationStatus).toContain('Stripe');
    expect(events).toEqual([
      jasmine.objectContaining({
        planId: 'plus-household',
        provider: 'stripe',
        eventType: 'checkout_interest',
      }),
    ]);
    expect(events[0].email).toBeUndefined();
    expect(events[0].stripeCustomerId).toBeUndefined();
    expect(events[0].paymentMethod).toBeUndefined();
  });

  it('clears local monetization discovery events', () => {
    component.registerMonetizationInterest('ai-capture-credits');

    expect(component.monetizationEvents.length).toBe(1);

    component.clearMonetizationDiscoveryEvents();

    expect(component.monetizationEvents.length).toBe(0);
    expect(
      window.localStorage.getItem(
        'despensalista.monetizationDiscoveryEvents.v1',
      ),
    ).toBeNull();
  });

  it('loads the household workspace and renders collaboration controls', () => {
    const compiled = fixture.nativeElement as HTMLElement;

    expect(profileService.getHouseholdWorkspace).toHaveBeenCalled();
    expect(component.householdWorkspace?.household.name).toBe('Hogar de chef');
    expect(compiled.textContent).toContain('Colaboración');
    expect(compiled.textContent).toContain('familia@example.com');
    expect(compiled.textContent).toContain('Actividad reciente');
    expect(compiled.textContent).toContain('Hogar creado');
  });

  it('prevents saving invalid preference ranges', () => {
    component.preferencesForm.patchValue({
      expirationWarningDays: 0,
    });

    component.savePreferences();

    expect(profileService.updatePreferences).not.toHaveBeenCalled();
    expect(component.saveError).toContain('Revisa');
  });

  it('delegates logout to the auth facade', () => {
    component.logout();

    expect(authFacade.logout).toHaveBeenCalled();
  });

  it('keeps the form editable when the preference update fails', () => {
    profileService.updatePreferences.and.returnValue(
      throwError(() => new Error('API failed')),
    );

    component.preferencesForm.patchValue({
      shoppingPlanLeadDays: 6,
    });
    component.savePreferences();

    expect(component.preferencesForm.enabled).toBeTrue();
    expect(component.saveError).toContain('No se pudo completar');
  });

  it('downloads a portable pantry export', () => {
    spyOn(window.URL, 'createObjectURL').and.returnValue('blob:pantry-export');
    spyOn(window.URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click').and.stub();

    component.exportPantryData();

    expect(pantryService.exportPantryData).toHaveBeenCalled();
    expect(component.exportMessage).toBe('Export listo.');
  });

  it('creates a household invite and exposes a shareable link', () => {
    component.householdInviteForm.patchValue({
      email: 'familia@example.com',
      role: 'editor',
    });

    component.createHouseholdInvite();

    expect(profileService.createHouseholdInvite).toHaveBeenCalledWith({
      email: 'familia@example.com',
      role: 'editor',
    });
    expect(component.householdInviteToken).toBe('invite-token-safe-123');
    expect(component.householdInviteLink).toContain(
      '/profile?householdInvite=invite-token-safe-123',
    );
  });

  it('accepts invites and lets owners revoke invites or remove members', () => {
    component.householdAcceptForm.patchValue({
      token: 'invite-token-safe-123',
    });
    component.acceptHouseholdInvite();

    expect(profileService.acceptHouseholdInvite).toHaveBeenCalledWith(
      'invite-token-safe-123',
    );
    expect(component.householdMessage).toBe('Invitacion aceptada.');

    component.revokeHouseholdInvite(makeHouseholdWorkspace().invites[0]);

    expect(profileService.revokeHouseholdInvite).toHaveBeenCalledWith(
      'invite-1',
    );

    component.removeHouseholdMember('member-1');

    expect(profileService.removeHouseholdMember).toHaveBeenCalledWith(
      'member-1',
    );
  });

  it('shows an error when pantry export fails', () => {
    pantryService.exportPantryData.and.returnValue(
      throwError(() => new Error('Export failed')),
    );

    component.exportPantryData();

    expect(component.exportError).toContain('No se pudo completar');
  });

  it('shows an error when pantry export download cannot be prepared', () => {
    spyOn(window.URL, 'createObjectURL').and.throwError('Blob failed');

    component.exportPantryData();

    expect(component.exportMessage).toBeNull();
    expect(component.exportError).toContain('No se pudo completar');
  });

  it('requires ELIMINAR confirmation before deleting local pantry data', () => {
    expect(component.canDeletePantryData).toBeFalse();

    component.deletePantryDataForm.patchValue({
      confirmationText: 'BORRAR',
    });

    expect(component.canDeletePantryData).toBeFalse();

    component.deletePantryData();

    expect(profileService.deletePantryData).not.toHaveBeenCalled();
    expect(component.deleteError).toContain('ELIMINAR');

    component.deletePantryDataForm.patchValue({
      confirmationText: 'ELIMINAR',
    });

    expect(component.canDeletePantryData).toBeTrue();

    component.deletePantryData();

    expect(profileService.deletePantryData).toHaveBeenCalledWith(
      { confirmationText: 'ELIMINAR' },
      jasmine.any(String),
    );
    expect(component.deleteMessage).toBe(
      'Datos eliminados: 5 lotes, 3 tipos base, 1 listas guardadas, 2 enlaces compartidos y 1 eventos de merma.',
    );
  });

  it('persists and reuses the pantry deletion key until a retry succeeds', () => {
    profileService.deletePantryData.and.returnValues(
      throwError(() => new Error('response lost')),
      of({
        deletedInventoryLotCount: 5,
        deletedProductTypeCount: 3,
        deletedShoppingListCount: 1,
        deletedShoppingShareCount: 2,
        deletedWasteEventCount: 1,
      }),
    );
    component.deletePantryDataForm.patchValue({
      confirmationText: 'ELIMINAR',
    });

    component.deletePantryData();
    const firstKey = profileService.deletePantryData.calls.argsFor(0)[1];
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      JSON.parse(
        window.localStorage.getItem(
          'despensalista.pendingPantryDeletionIdempotencyKey.v1',
        )!,
      ),
    ).toEqual(
      jasmine.objectContaining({
        ownerUserId: 'user-1',
        key: firstKey,
        createdAt: jasmine.any(String),
      }),
    );

    component.deletePantryData();

    expect(profileService.deletePantryData.calls.argsFor(1)[1]).toBe(firstKey);
    expect(
      window.localStorage.getItem(
        'despensalista.pendingPantryDeletionIdempotencyKey.v1',
      ),
    ).toBeNull();
  });

  it('does not reuse a pending pantry deletion key across accounts', () => {
    profileService.deletePantryData.and.returnValues(
      throwError(() => new Error('response lost for account A')),
      throwError(() => new Error('response lost for account B')),
    );
    component.deletePantryDataForm.patchValue({
      confirmationText: 'ELIMINAR',
    });

    component.deletePantryData();
    const accountAKey = profileService.deletePantryData.calls.argsFor(0)[1];
    component.profile = { ...component.profile!, id: 'user-2' };
    component.deletePantryData();
    const accountBKey = profileService.deletePantryData.calls.argsFor(1)[1];

    expect(accountBKey).not.toBe(accountAKey);
    expect(
      JSON.parse(
        window.localStorage.getItem(
          'despensalista.pendingPantryDeletionIdempotencyKey.v1',
        )!,
      ),
    ).toEqual(
      jasmine.objectContaining({
        ownerUserId: 'user-2',
        key: accountBKey,
      }),
    );
  });

  it('replaces a pending pantry deletion key after the receipt window expires', () => {
    const expiredKey = '9b29fb9a-ce30-473f-abaf-f8d987634f55';
    window.localStorage.setItem(
      'despensalista.pendingPantryDeletionIdempotencyKey.v1',
      JSON.stringify({
        ownerUserId: 'user-1',
        key: expiredKey,
        createdAt: new Date(
          Date.now() - 7 * 24 * 60 * 60 * 1000 - 1,
        ).toISOString(),
      }),
    );
    component.deletePantryDataForm.patchValue({
      confirmationText: 'ELIMINAR',
    });

    component.deletePantryData();
    const currentKey = profileService.deletePantryData.calls.argsFor(0)[1];

    expect(currentKey).not.toBe(expiredKey);
  });

  it('keeps the pantry deletion button disabled until the exact confirmation is entered', () => {
    fixture.detectChanges();

    const deleteButton = Array.from(
      fixture.nativeElement.querySelectorAll(
        '.danger-panel button[type="submit"]',
      ),
    ).at(1) as HTMLButtonElement;

    expect(deleteButton.disabled).toBeTrue();

    component.deletePantryDataForm.patchValue({
      confirmationText: 'ELIMINAR',
    });
    fixture.detectChanges();

    expect(deleteButton.disabled).toBeFalse();
  });

  it('requires confirmation before requesting all-session sign out', () => {
    profileService.signOutAllSessions.and.returnValue(
      throwError(() => new Error('Session revoke failed')),
    );

    expect(component.canSignOutAllSessions).toBeFalse();

    component.signOutAllSessionsForm.patchValue({
      confirmationText: 'CERRAR SESIONES',
    });

    expect(component.canSignOutAllSessions).toBeTrue();

    component.signOutAllSessions();

    expect(profileService.signOutAllSessions).toHaveBeenCalledWith({
      confirmationText: 'CERRAR SESIONES',
    });
    expect(component.signOutAllSessionsError).toContain('No se pudo completar');
  });

  it('keeps account deletion disabled until the exact confirmation is entered', () => {
    fixture.detectChanges();

    const accountDeleteButton = Array.from(
      fixture.nativeElement.querySelectorAll(
        '.danger-panel button[type="submit"]',
      ),
    ).at(-1) as HTMLButtonElement;

    expect(accountDeleteButton.disabled).toBeTrue();

    component.deleteAccountForm.patchValue({
      confirmationText: 'ELIMINAR CUENTA',
    });
    fixture.detectChanges();

    expect(accountDeleteButton.disabled).toBeFalse();
  });
});

function makeHouseholdWorkspace() {
  return {
    household: {
      id: 'household-1',
      name: 'Hogar de chef',
      ownerUserId: 'user-1',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    },
    currentMember: {
      householdId: 'household-1',
      userId: 'user-1',
      email: 'chef@example.com',
      username: 'chef',
      role: 'owner' as const,
      joinedAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    },
    members: [
      {
        householdId: 'household-1',
        userId: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        role: 'owner' as const,
        joinedAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
      {
        householdId: 'household-1',
        userId: 'member-1',
        email: 'familia@example.com',
        username: 'familia',
        role: 'editor' as const,
        joinedAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
    invites: [
      {
        id: 'invite-1',
        householdId: 'household-1',
        invitedEmail: 'familia@example.com',
        invitedByUserId: 'user-1',
        role: 'editor' as const,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        expiresAt: new Date('2026-06-08T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
    activities: [
      {
        id: 'activity-1',
        householdId: 'household-1',
        type: 'household_created' as const,
        actorUserId: 'user-1',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    ],
  };
}
