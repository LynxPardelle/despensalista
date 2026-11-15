import { HouseholdWorkspace } from '../../../application/read-models/household-workspace.read-model';
import {
  HouseholdActivityPrimitives,
  HouseholdInvitePrimitives,
  HouseholdMembershipPrimitives,
  HouseholdPrimitives,
} from '../../../domain/entities/household.entity';
import {
  HouseholdActivityResponseDto,
  HouseholdInviteResponseDto,
  HouseholdMemberResponseDto,
  HouseholdResponseDto,
  HouseholdWorkspaceResponseDto,
} from '../dtos/household.dto';

export class HouseholdMapper {
  static toWorkspaceResponse(
    workspace: HouseholdWorkspace,
  ): HouseholdWorkspaceResponseDto {
    return {
      household: this.toHouseholdResponse(workspace.household),
      plan: workspace.plan,
      currentMember: this.toMemberResponse(workspace.currentMember),
      members: workspace.members.map((member) => this.toMemberResponse(member)),
      invites: workspace.invites.map((invite) => this.toInviteResponse(invite)),
      activities: workspace.activities.map((activity) =>
        this.toActivityResponse(activity),
      ),
    };
  }

  static toHouseholdResponse(
    household: HouseholdPrimitives,
  ): HouseholdResponseDto {
    return {
      id: household.id,
      name: household.name,
      ownerUserId: household.ownerUserId,
      createdAt: household.createdAt,
      updatedAt: household.updatedAt,
    };
  }

  static toMemberResponse(
    member: HouseholdMembershipPrimitives,
  ): HouseholdMemberResponseDto {
    return {
      householdId: member.householdId,
      userId: member.userId,
      email: member.email,
      username: member.username,
      role: member.role,
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
    };
  }

  static toInviteResponse(
    invite: HouseholdInvitePrimitives,
  ): HouseholdInviteResponseDto {
    return {
      id: invite.id,
      householdId: invite.householdId,
      invitedEmail: invite.invitedEmail,
      invitedByUserId: invite.invitedByUserId,
      role: invite.role,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      acceptedAt: invite.acceptedAt,
      revokedAt: invite.revokedAt,
      updatedAt: invite.updatedAt,
    };
  }

  static toActivityResponse(
    activity: HouseholdActivityPrimitives,
  ): HouseholdActivityResponseDto {
    return {
      id: activity.id,
      householdId: activity.householdId,
      type: activity.type,
      actorUserId: activity.actorUserId,
      targetUserId: activity.targetUserId,
      targetLabel: activity.targetLabel,
      role: activity.role,
      createdAt: activity.createdAt,
    };
  }
}
