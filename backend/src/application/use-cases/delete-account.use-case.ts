import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CognitoUserAdmin } from '../ports/cognito-auth.port';
import { UserDao } from '../ports/daos';
import {
  COGNITO_USER_ADMIN,
  HOUSEHOLD_REPOSITORY,
  USER_DAO,
  USER_DEVICE_REPOSITORY,
} from '../tokens';
import { HouseholdRepository } from '../../domain/repositories/household.repository';
import { HouseholdMembership } from '../../domain/entities/household.entity';
import { UserDeviceRepository } from '../../domain/repositories/user-device.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { DeletePantryDataUseCase } from './delete-pantry-data.use-case';

const DELETE_ACCOUNT_CONFIRMATION = 'ELIMINAR CUENTA';
const ACCOUNT_DELETION_FENCE_MS = 24 * 60 * 60 * 1000;

export interface DeleteAccountResult {
  deletedInventoryLotCount: number;
  deletedProductTypeCount: number;
  deletedShoppingListCount: number;
  deletedShoppingShareCount: number;
  deletedWasteEventCount: number;
  deletedKnownDeviceCount: number;
  deletedCognitoIdentityCount: number;
}

@Injectable()
export class DeleteAccountUseCase {
  constructor(
    @Inject(USER_DAO)
    private readonly userDao: UserDao,
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly householdRepository: HouseholdRepository,
    @Inject(COGNITO_USER_ADMIN)
    private readonly cognitoUserAdmin: CognitoUserAdmin,
    @Inject(USER_DEVICE_REPOSITORY)
    private readonly userDeviceRepository: UserDeviceRepository,
    private readonly deletePantryDataUseCase: DeletePantryDataUseCase,
  ) {}

  async execute(command: {
    userId: string;
    confirmationText: string;
  }): Promise<DeleteAccountResult> {
    if (command.confirmationText.trim() !== DELETE_ACCOUNT_CONFIRMATION) {
      throw new BadRequestException(
        `Confirmation text must be ${DELETE_ACCOUNT_CONFIRMATION}`,
      );
    }

    const userId = UserId.fromString(command.userId);
    const user = await this.userDao.findById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const membership = await this.assertHouseholdCanBeDeletedOrLeft(
      command.userId,
    );
    const fencedUser = await this.userDao.beginAccountDeletion(
      userId,
      new Date(Date.now() + ACCOUNT_DELETION_FENCE_MS),
    );

    if (!fencedUser) {
      throw new NotFoundException('User not found');
    }

    const pantryResult = await this.deletePantryDataUseCase.execute({
      userId: command.userId,
      confirmationText: 'ELIMINAR',
      accountDeletion: true,
    });
    await this.deleteHouseholdOrMembership(
      command.userId,
      fencedUser.email,
      membership,
    );
    const deletedKnownDeviceCount =
      await this.userDeviceRepository.deleteByUserId(userId);
    const deletedCognitoIdentityCount =
      await this.cognitoUserAdmin.deleteUsersBySubjectIds(
        fencedUser.authSubjectIds,
      );
    await this.userDao.delete(userId);

    return {
      ...pantryResult,
      deletedKnownDeviceCount,
      deletedCognitoIdentityCount,
    };
  }

  private async assertHouseholdCanBeDeletedOrLeft(
    userId: string,
  ): Promise<HouseholdMembership | null> {
    const membership =
      await this.householdRepository.findMembershipByUserId(userId);

    if (!membership || membership.role !== 'owner') {
      return membership;
    }

    const canDelete = await this.householdRepository.beginHouseholdDeletion(
      membership.householdId,
      userId,
    );

    if (!canDelete) {
      throw new BadRequestException(
        'Remove household members before deleting the owner account',
      );
    }

    return membership;
  }

  private async deleteHouseholdOrMembership(
    userId: string,
    email: string,
    membership: HouseholdMembership | null,
  ): Promise<void> {
    if (!membership) {
      return;
    }

    if (membership.role === 'owner') {
      await this.householdRepository.deleteHouseholdCascade(
        membership.householdId,
      );
      return;
    }

    await this.householdRepository.deleteAccountHouseholdData(
      membership.householdId,
      userId,
      email,
    );
  }
}
