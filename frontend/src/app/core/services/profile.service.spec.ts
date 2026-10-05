import { TestBed } from '@angular/core/testing';
import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import { ProfileService } from './profile.service';

describe('ProfileService', () => {
  let service: ProfileService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
    });
    service = TestBed.inject(ProfileService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it('loads the current profile and normalizes dates', () => {
    let createdAt: Date | undefined;

    service.getProfile().subscribe((profile) => {
      createdAt = profile.createdAt;
      expect(profile.preferences.expirationWarningDays).toBe(10);
      expect(profile.knownDevices[0].lastSeenAt).toEqual(
        new Date('2026-06-08T00:01:00.000Z'),
      );
      expect(profile.security.stepUp.authenticatedAt).toEqual(
        new Date('2026-06-08T00:00:00.000Z'),
      );
    });

    const request = http.expectOne('/api/profile');
    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBeTrue();
    expect(request.request.headers.has('X-Client-Device-Id')).toBeTrue();
    request.flush({
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
      security: {
        stepUp: {
          enabled: true,
          maxAgeSeconds: 900,
          fresh: true,
          authenticatedAt: '2026-06-08T00:00:00.000Z',
          freshUntil: '2026-06-08T00:15:00.000Z',
        },
      },
    });

    expect(createdAt).toEqual(new Date('2026-04-01T00:00:00.000Z'));
  });

  it('patches preferences and returns the updated preferences', () => {
    service
      .updatePreferences({ showExpiredEntryAlert: false })
      .subscribe((preferences) => {
        expect(preferences.showExpiredEntryAlert).toBe(false);
      });

    const request = http.expectOne('/api/profile/preferences');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.withCredentials).toBeTrue();
    expect(request.request.body).toEqual({
      showExpiredEntryAlert: false,
    });
    request.flush({
      expirationWarningDays: 7,
      showExpiredEntryAlert: false,
      depletionWarningThresholdRatio: 1,
      shoppingPlanLeadDays: 3,
      showGuidanceTips: true,
    });
  });

  it('deletes local pantry data with explicit confirmation', () => {
    service
      .deletePantryData(
        { confirmationText: 'ELIMINAR' },
        '9b29fb9a-ce30-473f-abaf-f8d987634f55',
      )
      .subscribe((result) => {
        expect(result).toEqual({
          deletedInventoryLotCount: 5,
          deletedProductTypeCount: 3,
          deletedShoppingListCount: 1,
          deletedShoppingShareCount: 2,
          deletedWasteEventCount: 1,
        });
      });

    const request = http.expectOne('/api/profile/pantry-data');
    expect(request.request.method).toBe('DELETE');
    expect(request.request.withCredentials).toBeTrue();
    expect(request.request.headers.get('Idempotency-Key')).toBe(
      '9b29fb9a-ce30-473f-abaf-f8d987634f55',
    );
    expect(request.request.body).toEqual({
      confirmationText: 'ELIMINAR',
    });
    request.flush({
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 1,
    });
  });

  it('deletes the account with explicit confirmation', () => {
    service
      .deleteAccount({ confirmationText: 'ELIMINAR CUENTA' })
      .subscribe((result) => {
        expect(result.deletedCognitoIdentityCount).toBe(1);
      });

    const request = http.expectOne('/api/profile/account');
    expect(request.request.method).toBe('DELETE');
    expect(request.request.withCredentials).toBeTrue();
    expect(request.request.body).toEqual({
      confirmationText: 'ELIMINAR CUENTA',
    });
    request.flush({
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 1,
      deletedKnownDeviceCount: 1,
      deletedCognitoIdentityCount: 1,
    });
  });

  it('signs out all Cognito sessions with explicit confirmation', () => {
    service
      .signOutAllSessions({ confirmationText: 'CERRAR SESIONES' })
      .subscribe((result) => {
        expect(result).toEqual({
          revokedCognitoSessionCount: 1,
          localSessionCleared: true,
        });
      });

    const request = http.expectOne('/api/profile/sessions');
    expect(request.request.method).toBe('DELETE');
    expect(request.request.withCredentials).toBeTrue();
    expect(request.request.body).toEqual({
      confirmationText: 'CERRAR SESIONES',
    });
    request.flush({
      revokedCognitoSessionCount: 1,
      localSessionCleared: true,
    });
  });

  it('loads household workspace and normalizes dates', () => {
    service.getHouseholdWorkspace().subscribe((workspace) => {
      expect(workspace.household.name).toBe('Hogar de chef');
      expect(workspace.members[0].joinedAt).toEqual(
        new Date('2026-06-01T00:00:00.000Z'),
      );
      expect(workspace.invites[0].expiresAt).toEqual(
        new Date('2026-06-08T00:00:00.000Z'),
      );
      expect(workspace.activities[0].createdAt).toEqual(
        new Date('2026-06-01T00:00:00.000Z'),
      );
    });

    const request = http.expectOne('/api/household');
    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBeTrue();
    request.flush(makeApiHouseholdWorkspace());
  });

  it('creates, accepts, revokes, and removes household access', () => {
    service
      .createHouseholdInvite({ email: 'familia@example.com', role: 'editor' })
      .subscribe((result) => {
        expect(result.token).toBe('invite-token-safe-123');
        expect(result.invite.invitedEmail).toBe('familia@example.com');
      });

    const createRequest = http.expectOne('/api/household/invites');
    expect(createRequest.request.method).toBe('POST');
    expect(createRequest.request.withCredentials).toBeTrue();
    createRequest.flush({
      invite: makeApiHouseholdWorkspace().invites[0],
      token: 'invite-token-safe-123',
    });

    service
      .acceptHouseholdInvite('invite-token-safe-123')
      .subscribe((workspace) => {
        expect(workspace.currentMember.role).toBe('owner');
      });

    const acceptRequest = http.expectOne('/api/household/invites/accept');
    expect(acceptRequest.request.method).toBe('POST');
    expect(acceptRequest.request.withCredentials).toBeTrue();
    acceptRequest.flush(makeApiHouseholdWorkspace());

    service.revokeHouseholdInvite('invite-1').subscribe((invite) => {
      expect(invite.id).toBe('invite-1');
    });

    const revokeRequest = http.expectOne('/api/household/invites/invite-1');
    expect(revokeRequest.request.method).toBe('DELETE');
    expect(revokeRequest.request.withCredentials).toBeTrue();
    revokeRequest.flush(makeApiHouseholdWorkspace().invites[0]);

    service.removeHouseholdMember('member-1').subscribe((workspace) => {
      expect(workspace.household.id).toBe('household-1');
    });

    const removeRequest = http.expectOne('/api/household/members/member-1');
    expect(removeRequest.request.method).toBe('DELETE');
    expect(removeRequest.request.withCredentials).toBeTrue();
    removeRequest.flush(makeApiHouseholdWorkspace());
  });
});

function makeApiHouseholdWorkspace() {
  return {
    household: {
      id: 'household-1',
      name: 'Hogar de chef',
      ownerUserId: 'user-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
    currentMember: {
      householdId: 'household-1',
      userId: 'user-1',
      email: 'chef@example.com',
      username: 'chef',
      role: 'owner' as const,
      joinedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
    members: [
      {
        householdId: 'household-1',
        userId: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        role: 'owner' as const,
        joinedAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    invites: [
      {
        id: 'invite-1',
        householdId: 'household-1',
        invitedEmail: 'familia@example.com',
        invitedByUserId: 'user-1',
        role: 'editor' as const,
        createdAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    activities: [
      {
        id: 'activity-1',
        householdId: 'household-1',
        type: 'household_created' as const,
        actorUserId: 'user-1',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  };
}
