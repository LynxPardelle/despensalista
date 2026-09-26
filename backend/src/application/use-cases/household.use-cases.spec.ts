import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  AcceptHouseholdInviteUseCase,
  CreateHouseholdInviteUseCase,
  GetHouseholdWorkspaceUseCase,
  RecordHouseholdActivityUseCase,
  RemoveHouseholdMemberUseCase,
  ResolveHouseholdPantryAccessUseCase,
  RevokeHouseholdInviteUseCase,
} from './household.use-cases';
import {
  Household,
  HouseholdActivity,
  HouseholdInvite,
  HouseholdMembership,
} from '../../domain/entities/household.entity';
import { HouseholdRepository } from '../../domain/repositories/household.repository';
import { User } from '../../domain/entities/user.entity';
import { UserAccountStatus } from '../../domain/enums';
import { UserDao } from '../ports/daos';
import { UserId } from '../../domain/value-objects/user-id.vo';

describe('household use cases', () => {
  const owner = User.fromPrimitives({
    id: 'owner-user',
    email: 'owner@example.com',
    username: 'Alec',
    authSubjectIds: [],
    status: UserAccountStatus.ACTIVE,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
  const invitedUser = User.fromPrimitives({
    id: 'invited-user',
    email: 'familia@example.com',
    username: 'Familia',
    authSubjectIds: [],
    status: UserAccountStatus.ACTIVE,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
  let repository: jest.Mocked<HouseholdRepository>;
  let userDao: jest.Mocked<UserDao>;

  beforeEach(() => {
    repository = {
      createHouseholdWithOwner: jest.fn(
        async (_household, membership) => membership,
      ),
      acceptInvite: jest.fn(async (_invite, membership) => membership),
      saveHousehold: jest.fn(),
      saveMembership: jest.fn(),
      saveInvite: jest.fn(),
      saveActivity: jest.fn(),
      findHouseholdById: jest.fn(),
      findMembershipByUserId: jest.fn(),
      findMembershipByHouseholdAndUserId: jest.fn(),
      findMembersByHouseholdId: jest.fn(),
      deleteMembership: jest.fn(),
      findActiveInvitesByHouseholdId: jest.fn(),
      findInviteById: jest.fn(),
      findInviteByTokenHash: jest.fn(),
      findActivitiesByHouseholdId: jest.fn(),
      deleteAccountHouseholdData: jest.fn(),
      deleteHouseholdCascade: jest.fn(),
      beginHouseholdDeletion: jest.fn(),
      cancelHouseholdDeletion: jest.fn(),
    };
    userDao = {
      save: jest.fn(),
      findById: jest.fn(),
      findByAuthSubject: jest.fn(),
      findByEmail: jest.fn(),
      findByUsername: jest.fn(),
      beginAccountDeletion: jest.fn(),
      findPendingAccountDeletions: jest.fn(),
      claimPendingAccountDeletion: jest.fn(),
      deferAccountDeletion: jest.fn(),
      delete: jest.fn(),
    };
  });

  it('creates a default household and owner membership on first access', async () => {
    userDao.findById.mockResolvedValue(owner);
    repository.findMembershipByUserId.mockResolvedValue(null);
    repository.saveHousehold.mockImplementation(async (household) => household);
    repository.saveActivity.mockImplementation(async (activity) => activity);
    repository.saveMembership.mockImplementation(
      async (membership) => membership,
    );
    repository.findHouseholdById.mockImplementation(async (householdId) =>
      Household.fromPrimitives({
        id: householdId,
        name: 'Hogar de Alec',
        ownerUserId: 'owner-user',
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    );
    repository.findMembersByHouseholdId.mockResolvedValue([]);
    repository.findActiveInvitesByHouseholdId.mockResolvedValue([]);
    repository.findActivitiesByHouseholdId.mockResolvedValue([
      makeActivity({ type: 'household_created' }),
    ]);

    const workspace = await new GetHouseholdWorkspaceUseCase(
      repository,
      userDao,
    ).execute('owner-user');

    expect(repository.createHouseholdWithOwner).toHaveBeenCalledTimes(1);
    expect(repository.saveHousehold).not.toHaveBeenCalled();
    expect(repository.saveMembership).not.toHaveBeenCalled();
    expect(workspace.currentMember.role).toBe('owner');
    expect(workspace.household.name).toBe('Hogar de Alec');
    expect(workspace.activities[0].type).toBe('household_created');
  });

  it('creates an invite only when the requester owns the household', async () => {
    const household = makeHousehold();
    const ownerMembership = makeMembership({
      householdId: household.toPrimitives().id,
      userId: 'owner-user',
      role: 'owner',
    });
    userDao.findById.mockResolvedValue(owner);
    repository.findMembershipByUserId.mockResolvedValue(ownerMembership);
    repository.findHouseholdById.mockResolvedValue(household);
    repository.saveInvite.mockImplementation(async (invite) => invite);
    repository.saveActivity.mockImplementation(async (activity) => activity);

    const result = await new CreateHouseholdInviteUseCase(
      repository,
      userDao,
    ).execute({
      requesterUserId: 'owner-user',
      email: 'Familia@Example.com',
      role: 'editor',
    });

    expect(result.token).toMatch(/^[a-zA-Z0-9_-]{16,256}$/);
    expect(result.invite.toPrimitives().invitedEmail).toBe(
      'familia@example.com',
    );
    expect(result.invite.toPrimitives().role).toBe('editor');
    expect(
      repository.saveActivity.mock.calls[0]?.[0]?.toPrimitives(),
    ).toMatchObject({
      householdId: 'household-1',
      type: 'invite_created',
      role: 'editor',
    });
  });

  it('rejects invite creation for non-owner members', async () => {
    const household = makeHousehold();
    userDao.findById.mockResolvedValue(owner);
    repository.findMembershipByUserId.mockResolvedValue(
      makeMembership({
        householdId: household.toPrimitives().id,
        userId: 'editor-user',
        role: 'editor',
      }),
    );
    repository.findHouseholdById.mockResolvedValue(household);

    await expect(
      new CreateHouseholdInviteUseCase(repository, userDao).execute({
        requesterUserId: 'editor-user',
        email: 'familia@example.com',
        role: 'viewer',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts an active invite only for the matching invited email', async () => {
    const household = makeHousehold();
    const invite = makeInvite({
      householdId: household.toPrimitives().id,
      invitedEmail: 'familia@example.com',
      role: 'viewer',
    });
    userDao.findById.mockResolvedValue(invitedUser);
    repository.findInviteByTokenHash.mockResolvedValue(invite);
    repository.findMembershipByUserId.mockResolvedValue(null);
    repository.saveMembership.mockImplementation(
      async (membership) => membership,
    );
    repository.saveInvite.mockImplementation(
      async (savedInvite) => savedInvite,
    );
    repository.saveActivity.mockImplementation(async (activity) => activity);
    repository.findHouseholdById.mockResolvedValue(household);
    repository.findMembersByHouseholdId.mockResolvedValue([]);
    repository.findActiveInvitesByHouseholdId.mockResolvedValue([]);
    repository.findActivitiesByHouseholdId.mockResolvedValue([]);

    const workspace = await new AcceptHouseholdInviteUseCase(
      repository,
      userDao,
    ).execute({
      userId: 'invited-user',
      token: 'accept-token-safe',
    });

    expect(repository.acceptInvite).toHaveBeenCalledWith(
      expect.any(HouseholdInvite),
      expect.objectContaining({
        userId: 'invited-user',
        role: 'viewer',
      }),
    );
    expect(repository.saveInvite).not.toHaveBeenCalled();
    expect(repository.saveActivity).toHaveBeenCalled();
    expect(workspace.currentMember.role).toBe('viewer');
  });

  it('rejects invite acceptance when the email does not match', async () => {
    userDao.findById.mockResolvedValue(owner);
    repository.findInviteByTokenHash.mockResolvedValue(
      makeInvite({ invitedEmail: 'familia@example.com' }),
    );

    await expect(
      new AcceptHouseholdInviteUseCase(repository, userDao).execute({
        userId: 'owner-user',
        token: 'accept-token-safe',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('revokes active invites from the household owner', async () => {
    const household = makeHousehold();
    const invite = makeInvite({ householdId: household.toPrimitives().id });
    repository.findMembershipByUserId.mockResolvedValue(
      makeMembership({
        householdId: household.toPrimitives().id,
        userId: 'owner-user',
        role: 'owner',
      }),
    );
    repository.findInviteById.mockResolvedValue(invite);
    repository.saveInvite.mockImplementation(
      async (savedInvite) => savedInvite,
    );
    repository.saveActivity.mockImplementation(async (activity) => activity);

    const revoked = await new RevokeHouseholdInviteUseCase(repository).execute({
      requesterUserId: 'owner-user',
      inviteId: invite.toPrimitives().id,
    });

    expect(revoked.toPrimitives().revokedAt).toBeInstanceOf(Date);
    expect(repository.saveActivity).toHaveBeenCalled();
  });

  it('removes non-owner household members but refuses to remove the owner', async () => {
    const household = makeHousehold();
    const ownerMembership = makeMembership({
      householdId: household.toPrimitives().id,
      userId: 'owner-user',
      role: 'owner',
    });
    repository.findMembershipByUserId.mockResolvedValue(ownerMembership);
    repository.findMembershipByHouseholdAndUserId.mockResolvedValue(
      makeMembership({
        householdId: household.toPrimitives().id,
        userId: 'viewer-user',
        role: 'viewer',
      }),
    );
    repository.deleteMembership.mockResolvedValue(undefined);
    repository.saveActivity.mockImplementation(async (activity) => activity);

    await new RemoveHouseholdMemberUseCase(repository).execute({
      requesterUserId: 'owner-user',
      memberUserId: 'viewer-user',
    });

    expect(repository.deleteMembership).toHaveBeenCalledWith(
      household.toPrimitives().id,
      'viewer-user',
    );
    expect(repository.saveActivity).toHaveBeenCalled();

    repository.findMembershipByHouseholdAndUserId.mockResolvedValue(
      ownerMembership,
    );

    await expect(
      new RemoveHouseholdMemberUseCase(repository).execute({
        requesterUserId: 'owner-user',
        memberUserId: 'owner-user',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves shared pantry owner scope and allows editors to write', async () => {
    const household = makeHousehold();
    userDao.findById.mockResolvedValue(invitedUser);
    repository.findMembershipByUserId.mockResolvedValue(
      makeMembership({
        householdId: household.toPrimitives().id,
        userId: 'invited-user',
        role: 'editor',
      }),
    );
    repository.findHouseholdById.mockResolvedValue(household);

    const access = await new ResolveHouseholdPantryAccessUseCase(
      repository,
      userDao,
    ).executeWrite('invited-user');

    expect(access).toEqual({
      requesterUserId: 'invited-user',
      householdId: 'household-1',
      pantryOwnerUserId: 'owner-user',
      role: 'editor',
    });
  });

  it('allows viewers to read but blocks pantry writes and owner-only actions', async () => {
    const household = makeHousehold();
    userDao.findById.mockResolvedValue(invitedUser);
    repository.findMembershipByUserId.mockResolvedValue(
      makeMembership({
        householdId: household.toPrimitives().id,
        userId: 'invited-user',
        role: 'viewer',
      }),
    );
    repository.findHouseholdById.mockResolvedValue(household);
    const useCase = new ResolveHouseholdPantryAccessUseCase(
      repository,
      userDao,
    );

    await expect(useCase.executeRead('invited-user')).resolves.toMatchObject({
      pantryOwnerUserId: 'owner-user',
      role: 'viewer',
    });
    await expect(useCase.executeWrite('invited-user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(useCase.executeOwner('invited-user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('records explicit household activity events', async () => {
    repository.saveActivity.mockImplementation(async (activity) => activity);

    await new RecordHouseholdActivityUseCase(repository).execute({
      householdId: 'household-1',
      type: 'shopping_share_created',
      actorUserId: 'owner-user',
      role: 'owner',
    });

    expect(
      repository.saveActivity.mock.calls[0]?.[0]?.toPrimitives(),
    ).toMatchObject({
      householdId: 'household-1',
      type: 'shopping_share_created',
    });
  });
});

function makeHousehold(): Household {
  return Household.fromPrimitives({
    id: 'household-1',
    name: 'Hogar de Alec',
    ownerUserId: 'owner-user',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
}

function makeMembership(params: {
  householdId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
}): HouseholdMembership {
  return HouseholdMembership.fromPrimitives({
    householdId: params.householdId,
    userId: params.userId,
    email: `${params.userId}@example.com`,
    username: params.userId,
    role: params.role,
    joinedAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
}

function makeInvite(
  params: Partial<{
    householdId: string;
    invitedEmail: string;
    role: 'owner' | 'editor' | 'viewer';
  }> = {},
): HouseholdInvite {
  return HouseholdInvite.fromPrimitives({
    id: 'invite-1',
    householdId: params.householdId ?? 'household-1',
    invitedEmail: params.invitedEmail ?? 'familia@example.com',
    invitedByUserId: 'owner-user',
    role: params.role ?? 'editor',
    tokenHash:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    expiresAt: new Date('2099-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
}

function makeActivity(
  params: Partial<{
    householdId: string;
    type: 'household_created' | 'shopping_share_created';
    actorUserId: string;
  }> = {},
): HouseholdActivity {
  return HouseholdActivity.fromPrimitives({
    id: 'activity-1',
    householdId: params.householdId ?? 'household-1',
    type: params.type ?? 'household_created',
    actorUserId: params.actorUserId ?? 'owner-user',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  });
}
