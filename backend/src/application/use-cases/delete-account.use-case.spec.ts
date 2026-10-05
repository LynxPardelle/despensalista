import { BadRequestException } from '@nestjs/common';
import { CognitoUserAdmin } from '../ports/cognito-auth.port';
import { UserDao } from '../ports/daos';
import { User } from '../../domain/entities/user.entity';
import { HouseholdMembership } from '../../domain/entities/household.entity';
import { UserAccountStatus } from '../../domain/enums';
import { HouseholdRepository } from '../../domain/repositories/household.repository';
import { UserDeviceRepository } from '../../domain/repositories/user-device.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { DeletePantryDataUseCase } from './delete-pantry-data.use-case';
import { DeleteAccountUseCase } from './delete-account.use-case';

describe('DeleteAccountUseCase', () => {
  it('requires explicit account deletion confirmation', async () => {
    const { useCase, userDao } = makeUseCase();

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userDao.findById).not.toHaveBeenCalled();
  });

  it('blocks owner deletion while other household members remain', async () => {
    const { useCase, householdRepository, beginAccountDeletion } = makeUseCase({
      membership: makeMembership('user-1', 'owner'),
      members: [
        makeMembership('user-1', 'owner'),
        makeMembership('member-1', 'editor'),
      ],
    });

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR CUENTA',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(householdRepository.deleteHouseholdCascade).not.toHaveBeenCalled();
    expect(beginAccountDeletion).not.toHaveBeenCalled();
  });

  it('closes household before deleting pantry and never trusts a stale member listing', async () => {
    const { useCase, beginHouseholdDeletion, deletePantryDataUseCase } =
      makeUseCase({
        membership: makeMembership('user-1', 'owner'),
        members: [],
      });
    beginHouseholdDeletion.mockResolvedValue({ canDelete: false });

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR CUENTA',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(beginHouseholdDeletion).toHaveBeenCalledWith(
      'household-1',
      'user-1',
    );
    expect(deletePantryDataUseCase.execute).not.toHaveBeenCalled();
  });

  it('deletes pantry data, household, Cognito identity, and local user', async () => {
    const {
      useCase,
      userDao,
      householdRepository,
      cognitoUserAdmin,
      userDeviceRepository,
      deletePantryDataUseCase,
      beginHouseholdDeletion,
      beginAccountDeletion,
    } = makeUseCase({
      membership: makeMembership('user-1', 'owner'),
      members: [makeMembership('user-1', 'owner')],
    });

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR CUENTA',
      }),
    ).resolves.toEqual({
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 4,
      deletedKnownDeviceCount: 2,
      deletedCognitoIdentityCount: 1,
    });
    expect(cognitoUserAdmin.deleteUsersBySubjectIds).toHaveBeenCalledWith(
      ['auth-subject-1'],
      { 'auth-subject-1': 'native-user' },
    );
    expect(deletePantryDataUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      confirmationText: 'ELIMINAR',
      accountDeletion: true,
      deletionToken: 'pantry-delete-token',
    });
    expect(beginHouseholdDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      deletePantryDataUseCase.execute.mock.invocationCallOrder[0],
    );
    expect(beginAccountDeletion).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
      expect.any(Date),
      {
        householdId: 'household-1',
        householdRole: 'owner',
        householdDeletionToken: 'lock-1',
      },
    );
    expect(beginHouseholdDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      beginAccountDeletion.mock.invocationCallOrder[0],
    );
    expect(beginAccountDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      deletePantryDataUseCase.execute.mock.invocationCallOrder[0],
    );
    expect(householdRepository.deleteHouseholdCascade).toHaveBeenCalledWith(
      'household-1',
    );
    expect(
      householdRepository.deleteAccountHouseholdReferences,
    ).toHaveBeenCalledWith('user-1', 'chef@example.com');
    expect(
      householdRepository.deleteHouseholdCascade.mock.invocationCallOrder[0],
    ).toBeLessThan(
      householdRepository.deleteAccountHouseholdReferences.mock
        .invocationCallOrder[0],
    );
    expect(userDeviceRepository.deleteByUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(userDao.delete).toHaveBeenCalledWith(UserId.fromString('user-1'));
    expect(
      deletePantryDataUseCase.execute.mock.invocationCallOrder[0],
    ).toBeLessThan(
      cognitoUserAdmin.deleteUsersBySubjectIds.mock.invocationCallOrder[0],
    );
    expect(
      userDeviceRepository.deleteByUserId.mock.invocationCallOrder[0],
    ).toBeLessThan(
      cognitoUserAdmin.deleteUsersBySubjectIds.mock.invocationCallOrder[0],
    );
    expect(
      cognitoUserAdmin.deleteUsersBySubjectIds.mock.invocationCallOrder[0],
    ).toBeLessThan(userDao.delete.mock.invocationCallOrder[0]);
  });

  it('cascades the household captured by the closing lock without a stale second lookup', async () => {
    const { useCase, householdRepository } = makeUseCase({
      membership: makeMembership('user-1', 'owner'),
      members: [makeMembership('user-1', 'owner')],
    });
    householdRepository.findMembershipByUserId
      .mockResolvedValueOnce(makeMembership('user-1', 'owner'))
      .mockResolvedValueOnce(null);

    await useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR CUENTA',
    });

    expect(householdRepository.findMembershipByUserId).toHaveBeenCalledTimes(1);
    expect(householdRepository.deleteHouseholdCascade).toHaveBeenCalledWith(
      'household-1',
    );
  });

  it('removes a non-owner membership before deleting the user', async () => {
    const {
      useCase,
      householdRepository,
      deleteAccountHouseholdReferences,
      userDao,
    } = makeUseCase({
      membership: makeMembership('user-1', 'editor'),
    });

    await useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR CUENTA',
    });

    expect(householdRepository.deleteMembership).toHaveBeenCalledWith(
      'household-1',
      'user-1',
    );
    expect(
      householdRepository.deleteMembership.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deleteAccountHouseholdReferences.mock.invocationCallOrder[0],
    );
    expect(
      deleteAccountHouseholdReferences.mock.invocationCallOrder[0],
    ).toBeLessThan(userDao.delete.mock.invocationCallOrder[0]);
  });

  it('scrubs former household references without a current membership', async () => {
    const { useCase, deleteAccountHouseholdReferences, userDao } =
      makeUseCase();

    await useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR CUENTA',
    });

    expect(deleteAccountHouseholdReferences).toHaveBeenCalledWith(
      'user-1',
      'chef@example.com',
    );
    expect(
      deleteAccountHouseholdReferences.mock.invocationCallOrder[0],
    ).toBeLessThan(userDao.delete.mock.invocationCallOrder[0]);
  });

  it('resumes from the persisted snapshot after a partial Cognito failure', async () => {
    const {
      useCase,
      userDao,
      cognitoUserAdmin,
      deleteAccountHouseholdReferences,
    } = makeUseCase();
    const job = {
      userId: 'user-1',
      email: 'chef@example.com',
      username: 'chef',
      authSubjectIds: ['persisted-subject-1', 'persisted-subject-2'],
      authUsernamesBySubject: {
        'persisted-subject-1': 'native-persisted-user',
        'persisted-subject-2': 'Google_persisted-user',
      },
      startedAt: new Date('2026-09-26T00:00:00.000Z'),
      pantryDeletionToken: 'persisted-pantry-token',
    };
    cognitoUserAdmin.deleteUsersBySubjectIds
      .mockRejectedValueOnce(new Error('second identity failed'))
      .mockResolvedValueOnce(1);

    await expect(useCase.resume(job)).rejects.toThrow('second identity failed');
    expect(userDao.delete).not.toHaveBeenCalled();

    await expect(useCase.resume(job)).resolves.toEqual(
      expect.objectContaining({ deletedCognitoIdentityCount: 1 }),
    );
    expect(cognitoUserAdmin.deleteUsersBySubjectIds).toHaveBeenNthCalledWith(
      1,
      job.authSubjectIds,
      job.authUsernamesBySubject,
    );
    expect(cognitoUserAdmin.deleteUsersBySubjectIds).toHaveBeenNthCalledWith(
      2,
      job.authSubjectIds,
      job.authUsernamesBySubject,
    );
    expect(deleteAccountHouseholdReferences).toHaveBeenCalledTimes(2);
    expect(userDao.delete).toHaveBeenCalledWith(UserId.fromString('user-1'));
  });

  it('releases its owner lock when durable job creation fails', async () => {
    const {
      useCase,
      beginAccountDeletion,
      householdRepository,
      beginHouseholdDeletion,
    } = makeUseCase({
      membership: makeMembership('user-1', 'owner'),
      members: [makeMembership('user-1', 'owner')],
    });
    beginAccountDeletion.mockRejectedValue(new Error('database unavailable'));

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR CUENTA',
      }),
    ).rejects.toThrow('database unavailable');

    expect(beginHouseholdDeletion).toHaveBeenCalled();
    expect(householdRepository.cancelHouseholdDeletion).toHaveBeenCalledWith(
      'household-1',
      'user-1',
      'lock-1',
    );
  });
});

function makeUseCase(
  options: {
    membership?: HouseholdMembership | null;
    members?: HouseholdMembership[];
  } = {},
) {
  const beginAccountDeletion = jest.fn();
  const userDao = {
    beginAccountDeletion,
    findById: jest.fn().mockResolvedValue(
      User.fromPrimitives({
        id: 'user-1',
        email: 'chef@example.com',
        username: 'chef',
        authSubjectIds: ['auth-subject-1'],
        authUsernamesBySubject: { 'auth-subject-1': 'native-user' },
        status: UserAccountStatus.ACTIVE,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ),
    delete: jest.fn(),
  } as unknown as jest.Mocked<UserDao>;
  beginAccountDeletion.mockImplementation(async (_id, _expiresAt, context) => {
    const user = await userDao.findById(UserId.fromString('user-1'));
    const primitives = user?.toPrimitives();
    return primitives
      ? {
          userId: primitives.id,
          email: primitives.email,
          username: primitives.username,
          authSubjectIds: primitives.authSubjectIds ?? [],
          authUsernamesBySubject: primitives.authUsernamesBySubject ?? {},
          householdId: context?.householdId,
          householdRole: context?.householdRole,
          startedAt: new Date('2026-09-26T00:00:00.000Z'),
          pantryDeletionToken: 'pantry-delete-token',
        }
      : null;
  });
  const beginHouseholdDeletion = jest.fn().mockResolvedValue({
    canDelete: !(options.members ?? []).some(
      (member) => member.userId !== 'user-1',
    ),
    token: 'lock-1',
  });
  const deleteAccountHouseholdReferences = jest.fn();
  const householdRepository = {
    beginHouseholdDeletion,
    cancelHouseholdDeletion: jest.fn(),
    findMembershipByUserId: jest
      .fn()
      .mockResolvedValue(options.membership ?? null),
    findMembersByHouseholdId: jest
      .fn()
      .mockResolvedValue(options.members ?? []),
    deleteHouseholdCascade: jest.fn(),
    deleteMembership: jest.fn(),
    deleteAccountHouseholdReferences,
  } as unknown as jest.Mocked<HouseholdRepository>;
  const cognitoUserAdmin = {
    deleteUsersBySubjectIds: jest.fn().mockResolvedValue(1),
    signOutUsersBySubjectIds: jest.fn(),
  } as unknown as jest.Mocked<CognitoUserAdmin>;
  const deletePantryDataUseCase = {
    execute: jest.fn().mockResolvedValue({
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 4,
    }),
  } as unknown as jest.Mocked<DeletePantryDataUseCase>;
  const userDeviceRepository = {
    deleteByUserId: jest.fn().mockResolvedValue(2),
  } as unknown as jest.Mocked<UserDeviceRepository>;
  const useCase = new DeleteAccountUseCase(
    userDao,
    householdRepository,
    cognitoUserAdmin,
    userDeviceRepository,
    deletePantryDataUseCase,
  );

  return {
    useCase,
    userDao,
    householdRepository,
    cognitoUserAdmin,
    userDeviceRepository,
    deletePantryDataUseCase,
    beginHouseholdDeletion,
    beginAccountDeletion,
    deleteAccountHouseholdReferences,
  };
}

function makeMembership(
  userId: string,
  role: 'owner' | 'editor' | 'viewer',
): HouseholdMembership {
  return HouseholdMembership.fromPrimitives({
    householdId: 'household-1',
    userId,
    email: `${userId}@example.com`,
    username: userId,
    role,
    joinedAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
}
