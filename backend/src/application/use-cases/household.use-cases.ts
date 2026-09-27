import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Household,
  HouseholdActivity,
  HouseholdActivityType,
  HouseholdInvite,
  HouseholdMembership,
  HouseholdRole,
} from '../../domain/entities/household.entity';
import { HouseholdRepository } from '../../domain/repositories/household.repository';
import { User } from '../../domain/entities/user.entity';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { UserDao } from '../ports/daos';
import { HOUSEHOLD_REPOSITORY, USER_DAO } from '../tokens';
import {
  generateHouseholdInviteToken,
  hashHouseholdInviteToken,
} from '../utils/household-invite-token';
import { HouseholdWorkspace } from '../read-models/household-workspace.read-model';

const HOUSEHOLD_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class GetHouseholdWorkspaceUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
  ) {}

  async execute(userId: string): Promise<HouseholdWorkspace> {
    const user = await getRequiredUser(this.userDao, userId);
    const membership = await this.ensureMembership(user);

    return buildWorkspace(this.householdRepository, membership);
  }

  private async ensureMembership(user: User): Promise<HouseholdMembership> {
    const currentMembership =
      await this.householdRepository.findMembershipByUserId(user.id.toString());

    if (currentMembership) {
      return currentMembership;
    }

    const now = new Date();
    const household = Household.create(user, now);
    const ownerMembership = household.createOwnerMembership(user, now);

    return this.householdRepository.createHouseholdWithOwner(
      household,
      ownerMembership,
    );
  }
}

@Injectable()
export class CreateHouseholdInviteUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
  ) {}

  async execute(command: {
    requesterUserId: string;
    email: string;
    role: Exclude<HouseholdRole, 'owner'>;
  }): Promise<{ invite: HouseholdInvite; token: string }> {
    const requester = await getRequiredUser(
      this.userDao,
      command.requesterUserId,
    );
    const membership = await getRequiredMembership(
      this.householdRepository,
      requester.id.toString(),
    );
    assertOwner(membership);

    if (normalizeEmail(command.email) === normalizeEmail(requester.email)) {
      throw new BadRequestException('Cannot invite your own email');
    }

    const token = generateHouseholdInviteToken();
    const now = new Date();
    const invite = HouseholdInvite.create({
      householdId: membership.householdId,
      invitedEmail: command.email,
      invitedByUserId: requester.id.toString(),
      role: command.role,
      tokenHash: hashHouseholdInviteToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + HOUSEHOLD_INVITE_TTL_MS),
    });

    const savedInvite = await this.householdRepository.saveInvite(invite);
    await recordHouseholdActivity(this.householdRepository, {
      householdId: membership.householdId,
      type: 'invite_created',
      actorUserId: requester.id.toString(),
      role: command.role,
      createdAt: now,
    });

    return {
      invite: savedInvite,
      token,
    };
  }
}

@Injectable()
export class AcceptHouseholdInviteUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
  ) {}

  async execute(command: {
    userId: string;
    token: string;
  }): Promise<HouseholdWorkspace> {
    const user = await getRequiredUser(this.userDao, command.userId);
    const invite = await this.householdRepository.findInviteByTokenHash(
      hashHouseholdInviteToken(command.token),
    );

    if (!invite || !invite.isActive()) {
      throw new NotFoundException('Household invite not found');
    }

    if (normalizeEmail(invite.invitedEmail) !== normalizeEmail(user.email)) {
      throw new BadRequestException(
        'Household invite email does not match current user',
      );
    }

    const currentMembership =
      await this.householdRepository.findMembershipByUserId(user.id.toString());

    if (
      currentMembership &&
      currentMembership.householdId !== invite.householdId
    ) {
      throw new BadRequestException('User already belongs to a household');
    }

    const now = new Date();
    const membership =
      currentMembership ??
      HouseholdMembership.create({
        householdId: invite.householdId,
        user,
        role: invite.role,
        now,
      });

    invite.accept(now);
    const savedMembership = await this.householdRepository.acceptInvite(
      invite,
      membership,
    );
    await recordHouseholdActivity(this.householdRepository, {
      householdId: invite.householdId,
      type: 'invite_accepted',
      actorUserId: user.id.toString(),
      targetUserId: user.id.toString(),
      targetLabel: user.username,
      role: invite.role,
      createdAt: now,
    });

    return buildWorkspace(this.householdRepository, savedMembership);
  }
}

@Injectable()
export class RevokeHouseholdInviteUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
  ) {}

  async execute(command: {
    requesterUserId: string;
    inviteId: string;
  }): Promise<HouseholdInvite> {
    const membership = await getRequiredMembership(
      this.householdRepository,
      command.requesterUserId,
    );
    assertOwner(membership);
    const invite = await this.householdRepository.findInviteById(
      command.inviteId,
    );

    if (!invite || invite.householdId !== membership.householdId) {
      throw new NotFoundException('Household invite not found');
    }

    if (!invite.isActive()) return invite;
    invite.revoke();
    const savedInvite = await this.householdRepository.saveInvite(invite);
    await recordHouseholdActivity(this.householdRepository, {
      householdId: membership.householdId,
      type: 'invite_revoked',
      actorUserId: command.requesterUserId,
      role: invite.role,
    });

    return savedInvite;
  }
}

@Injectable()
export class RemoveHouseholdMemberUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
  ) {}

  async execute(command: {
    requesterUserId: string;
    memberUserId: string;
  }): Promise<void> {
    const requesterMembership = await getRequiredMembership(
      this.householdRepository,
      command.requesterUserId,
    );
    assertOwner(requesterMembership);

    const targetMembership =
      await this.householdRepository.findMembershipByHouseholdAndUserId(
        requesterMembership.householdId,
        UserId.fromString(command.memberUserId).toString(),
      );

    if (!targetMembership) {
      throw new NotFoundException('Household member not found');
    }

    if (targetMembership.role === 'owner') {
      throw new BadRequestException('Cannot remove the household owner');
    }

    await this.householdRepository.deleteMembership(
      requesterMembership.householdId,
      targetMembership.userId,
    );
    await recordHouseholdActivity(this.householdRepository, {
      householdId: requesterMembership.householdId,
      type: 'member_removed',
      actorUserId: command.requesterUserId,
      targetUserId: targetMembership.userId,
      targetLabel: targetMembership.toPrimitives().username,
      role: targetMembership.role,
    });
  }
}

export interface HouseholdPantryAccess {
  requesterUserId: string;
  householdId: string;
  pantryOwnerUserId: string;
  role: HouseholdRole;
}

@Injectable()
export class ResolveHouseholdPantryAccessUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
  ) {}

  async executeRead(userId: string): Promise<HouseholdPantryAccess> {
    const user = await getRequiredUser(this.userDao, userId);
    const membership = await this.ensureMembership(user);
    const household = await this.householdRepository.findHouseholdById(
      membership.householdId,
    );

    if (!household) {
      throw new NotFoundException('Household not found');
    }

    return {
      requesterUserId: user.id.toString(),
      householdId: household.id,
      pantryOwnerUserId: household.ownerUserId,
      role: membership.role,
    };
  }

  async executeWrite(userId: string): Promise<HouseholdPantryAccess> {
    const access = await this.executeRead(userId);

    if (access.role === 'viewer') {
      throw new ForbiddenException(
        'Household viewers cannot change pantry data',
      );
    }

    return access;
  }

  async executeOwner(userId: string): Promise<HouseholdPantryAccess> {
    const access = await this.executeRead(userId);

    if (access.role !== 'owner') {
      throw new ForbiddenException(
        'Only household owners can perform this action',
      );
    }

    return access;
  }

  private async ensureMembership(user: User): Promise<HouseholdMembership> {
    const currentMembership =
      await this.householdRepository.findMembershipByUserId(user.id.toString());

    if (currentMembership) {
      return currentMembership;
    }

    const now = new Date();
    const household = Household.create(user, now);
    const ownerMembership = household.createOwnerMembership(user, now);

    return this.householdRepository.createHouseholdWithOwner(
      household,
      ownerMembership,
    );
  }
}

@Injectable()
export class RecordHouseholdActivityUseCase {
  constructor(
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
  ) {}

  async execute(command: {
    householdId: string;
    type: HouseholdActivityType;
    actorUserId: string;
    targetUserId?: string;
    targetLabel?: string;
    role?: HouseholdRole;
  }): Promise<void> {
    await recordHouseholdActivity(this.householdRepository, command);
  }
}

async function buildWorkspace(
  householdRepository: HouseholdRepository,
  currentMember: HouseholdMembership,
): Promise<HouseholdWorkspace> {
  const household = await householdRepository.findHouseholdById(
    currentMember.householdId,
  );

  if (!household) {
    throw new NotFoundException('Household not found');
  }

  const [members, invites, activities] = await Promise.all([
    householdRepository.findMembersByHouseholdId(currentMember.householdId),
    householdRepository.findActiveInvitesByHouseholdId(
      currentMember.householdId,
      new Date(),
    ),
    householdRepository.findActivitiesByHouseholdId(
      currentMember.householdId,
      12,
    ),
  ]);

  return {
    household: household.toPrimitives(),
    currentMember: currentMember.toPrimitives(),
    members: members.map((member) => member.toPrimitives()),
    invites: invites.map((invite) => invite.toPrimitives()),
    activities: activities.map((activity) => activity.toPrimitives()),
  };
}

async function getRequiredUser(
  userDao: UserDao,
  userId: string,
): Promise<User> {
  const user = await userDao.findById(UserId.fromString(userId));

  if (!user) {
    throw new NotFoundException('User not found');
  }

  return user;
}

async function getRequiredMembership(
  householdRepository: HouseholdRepository,
  userId: string,
): Promise<HouseholdMembership> {
  const membership = await householdRepository.findMembershipByUserId(
    UserId.fromString(userId).toString(),
  );

  if (!membership) {
    throw new NotFoundException('Household membership not found');
  }

  return membership;
}

function assertOwner(membership: HouseholdMembership): void {
  if (membership.role !== 'owner') {
    throw new ForbiddenException(
      'Only household owners can perform this action',
    );
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase('en-US');
}

async function recordHouseholdActivity(
  householdRepository: HouseholdRepository,
  params: {
    householdId: string;
    type: HouseholdActivityType;
    actorUserId: string;
    targetUserId?: string;
    targetLabel?: string;
    role?: HouseholdRole;
    createdAt?: Date;
  },
): Promise<void> {
  await householdRepository.saveActivity(HouseholdActivity.create(params));
}
