import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import {
  ApiHouseholdInvite,
  ApiHouseholdActivity,
  ApiHouseholdMember,
  ApiHouseholdWorkspace,
  ApiUserProfile,
  CreateHouseholdInviteRequest,
  CreateHouseholdInviteResult,
  DeleteAccountRequest,
  DeleteAccountResult,
  DeletePantryDataRequest,
  DeletePantryDataResult,
  HouseholdInvite,
  HouseholdActivity,
  HouseholdMember,
  HouseholdWorkspace,
  SignOutAllSessionsRequest,
  SignOutAllSessionsResult,
  UserPreferences,
  UserPreferencesUpdate,
  UserProfile,
} from '../../shared/models/profile.model';

@Injectable({
  providedIn: 'root',
})
export class ProfileService {
  private readonly profileUrl = `${environment.apiUrl}/profile`;
  private readonly householdUrl = `${environment.apiUrl}/household`;

  constructor(private readonly http: HttpClient) {}

  getProfile(): Observable<UserProfile> {
    return this.http
      .get<ApiUserProfile>(this.profileUrl, {
        headers: this.getClientDeviceHeaders(),
        withCredentials: true,
      })
      .pipe(map((profile) => this.normalizeProfile(profile)));
  }

  updatePreferences(
    preferences: UserPreferencesUpdate,
  ): Observable<UserPreferences> {
    return this.http.patch<UserPreferences>(
      `${this.profileUrl}/preferences`,
      preferences,
      { withCredentials: true },
    );
  }

  deletePantryData(
    request: DeletePantryDataRequest,
    idempotencyKey: string,
  ): Observable<DeletePantryDataResult> {
    return this.http.delete<DeletePantryDataResult>(
      `${this.profileUrl}/pantry-data`,
      {
        body: request,
        headers: { 'Idempotency-Key': idempotencyKey },
        withCredentials: true,
      },
    );
  }

  deleteAccount(
    request: DeleteAccountRequest,
  ): Observable<DeleteAccountResult> {
    return this.http.delete<DeleteAccountResult>(`${this.profileUrl}/account`, {
      body: request,
      withCredentials: true,
    });
  }

  signOutAllSessions(
    request: SignOutAllSessionsRequest,
  ): Observable<SignOutAllSessionsResult> {
    return this.http.delete<SignOutAllSessionsResult>(
      `${this.profileUrl}/sessions`,
      {
        body: request,
        withCredentials: true,
      },
    );
  }

  getHouseholdWorkspace(): Observable<HouseholdWorkspace> {
    return this.http
      .get<ApiHouseholdWorkspace>(this.householdUrl, {
        withCredentials: true,
      })
      .pipe(map((workspace) => this.normalizeHouseholdWorkspace(workspace)));
  }

  createHouseholdInvite(
    request: CreateHouseholdInviteRequest,
  ): Observable<CreateHouseholdInviteResult> {
    return this.http
      .post<{
        invite: ApiHouseholdInvite;
        token: string;
      }>(`${this.householdUrl}/invites`, request, { withCredentials: true })
      .pipe(
        map((result) => ({
          invite: this.normalizeHouseholdInvite(result.invite),
          token: result.token,
        })),
      );
  }

  acceptHouseholdInvite(token: string): Observable<HouseholdWorkspace> {
    return this.http
      .post<ApiHouseholdWorkspace>(
        `${this.householdUrl}/invites/accept`,
        { token },
        { withCredentials: true },
      )
      .pipe(map((workspace) => this.normalizeHouseholdWorkspace(workspace)));
  }

  revokeHouseholdInvite(inviteId: string): Observable<HouseholdInvite> {
    return this.http
      .delete<ApiHouseholdInvite>(
        `${this.householdUrl}/invites/${encodeURIComponent(inviteId)}`,
        { withCredentials: true },
      )
      .pipe(map((invite) => this.normalizeHouseholdInvite(invite)));
  }

  removeHouseholdMember(memberUserId: string): Observable<HouseholdWorkspace> {
    return this.http
      .delete<ApiHouseholdWorkspace>(
        `${this.householdUrl}/members/${encodeURIComponent(memberUserId)}`,
        { withCredentials: true },
      )
      .pipe(map((workspace) => this.normalizeHouseholdWorkspace(workspace)));
  }

  private normalizeProfile(profile: ApiUserProfile): UserProfile {
    return {
      ...profile,
      createdAt: new Date(profile.createdAt),
      updatedAt: new Date(profile.updatedAt),
      knownDevices: (profile.knownDevices ?? []).map((device) => ({
        ...device,
        firstSeenAt: new Date(device.firstSeenAt),
        lastSeenAt: new Date(device.lastSeenAt),
      })),
      security: {
        stepUp: {
          ...profile.security.stepUp,
          authenticatedAt: profile.security.stepUp.authenticatedAt
            ? new Date(profile.security.stepUp.authenticatedAt)
            : undefined,
          freshUntil: profile.security.stepUp.freshUntil
            ? new Date(profile.security.stepUp.freshUntil)
            : undefined,
        },
      },
    };
  }

  private normalizeHouseholdWorkspace(
    workspace: ApiHouseholdWorkspace,
  ): HouseholdWorkspace {
    return {
      household: {
        ...workspace.household,
        createdAt: new Date(workspace.household.createdAt),
        updatedAt: new Date(workspace.household.updatedAt),
      },
      currentMember: this.normalizeHouseholdMember(workspace.currentMember),
      members: workspace.members.map((member) =>
        this.normalizeHouseholdMember(member),
      ),
      invites: workspace.invites.map((invite) =>
        this.normalizeHouseholdInvite(invite),
      ),
      activities: workspace.activities.map((activity) =>
        this.normalizeHouseholdActivity(activity),
      ),
    };
  }

  private normalizeHouseholdMember(
    member: ApiHouseholdMember,
  ): HouseholdMember {
    return {
      ...member,
      joinedAt: new Date(member.joinedAt),
      updatedAt: new Date(member.updatedAt),
    };
  }

  private normalizeHouseholdInvite(
    invite: ApiHouseholdInvite,
  ): HouseholdInvite {
    return {
      ...invite,
      createdAt: new Date(invite.createdAt),
      expiresAt: new Date(invite.expiresAt),
      acceptedAt: invite.acceptedAt ? new Date(invite.acceptedAt) : undefined,
      revokedAt: invite.revokedAt ? new Date(invite.revokedAt) : undefined,
      updatedAt: new Date(invite.updatedAt),
    };
  }

  private normalizeHouseholdActivity(
    activity: ApiHouseholdActivity,
  ): HouseholdActivity {
    return {
      ...activity,
      createdAt: new Date(activity.createdAt),
    };
  }

  private getClientDeviceHeaders(): Record<string, string> {
    const deviceId = this.getOrCreateClientDeviceId();

    return deviceId ? { 'X-Client-Device-Id': deviceId } : {};
  }

  private getOrCreateClientDeviceId(): string | undefined {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }

    const storageKey = 'despensalista.clientDeviceId';

    try {
      const existingDeviceId = localStorage.getItem(storageKey);

      if (existingDeviceId) {
        return existingDeviceId;
      }

      const nextDeviceId =
        globalThis.crypto?.randomUUID?.() ??
        `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(storageKey, nextDeviceId);

      return nextDeviceId;
    } catch {
      return undefined;
    }
  }
}
