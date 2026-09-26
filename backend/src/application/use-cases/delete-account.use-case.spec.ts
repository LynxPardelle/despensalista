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
    beginHouseholdDeletion.mockResolvedValue(false);

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
    expect(cognitoUserAdmin.deleteUsersBySubjectIds).toHaveBeenCalledWith([
      'auth-subject-1',
    ]);
    expect(deletePantryDataUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      confirmationText: 'ELIMINAR',
      accountDeletion: true,
    });
    expect(beginHouseholdDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      deletePantryDataUseCase.execute.mock.invocationCallOrder[0],
    );
    expect(beginAccountDeletion).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
      expect.any(Date),
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

  it('removes and anonymizes a non-owner membership before deleting the user', async () => {
    const { useCase, householdRepository, userDao } = makeUseCase({
      membership: makeMembership('user-1', 'editor'),
    });

    await useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR CUENTA',
    });

    expect(householdRepository.deleteAccountHouseholdData).toHaveBeenCalledWith(
      'household-1',
      'user-1',
      'chef@example.com',
    );
    expect(
      householdRepository.deleteAccountHouseholdData.mock
        .invocationCallOrder[0],
    ).toBeLessThan(userDao.delete.mock.invocationCallOrder[0]);
    expect(householdRepository.deleteMembership).not.toHaveBeenCalled();
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
        status: UserAccountStatus.ACTIVE,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ),
    delete: jest.fn(),
  } as unknown as jest.Mocked<UserDao>;
  beginAccountDeletion.mockImplementation(async () =>
    userDao.findById(UserId.fromString('user-1')),
  );
  const beginHouseholdDeletion = jest
    .fn()
    .mockResolvedValue(
      !(options.members ?? []).some((member) => member.userId !== 'user-1'),
    );
  const householdRepository = {
    beginHouseholdDeletion,
    findMembershipByUserId: jest
      .fn()
      .mockResolvedValue(options.membership ?? null),
    findMembersByHouseholdId: jest
      .fn()
      .mockResolvedValue(options.members ?? []),
    deleteHouseholdCascade: jest.fn(),
    deleteMembership: jest.fn(),
    deleteAccountHouseholdData: jest.fn(),
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
