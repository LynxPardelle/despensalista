import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CognitoUserAdmin } from '../ports/cognito-auth.port';
import { AccountDeletionJob, UserDao } from '../ports/daos';
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
const ACCOUNT_DELETION_PENDING_UNTIL = '9999-12-31T23:59:59.999Z';

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

    const { membership, householdDeletionToken } =
      await this.assertHouseholdCanBeDeletedOrLeft(command.userId);
    let deletionJob: AccountDeletionJob | null;
    try {
      deletionJob = await this.userDao.beginAccountDeletion(
        userId,
        new Date(ACCOUNT_DELETION_PENDING_UNTIL),
        membership
          ? {
              householdId: membership.householdId,
              householdRole: membership.role,
              householdDeletionToken,
            }
          : undefined,
      );
    } catch (error) {
      await this.cancelOwnerLock(
        command.userId,
        membership,
        householdDeletionToken,
      );
      throw error;
    }

    if (!deletionJob) {
      await this.cancelOwnerLock(
        command.userId,
        membership,
        householdDeletionToken,
      );
      throw new NotFoundException('User not found');
    }

    return this.resume(deletionJob);
  }

  async resume(job: AccountDeletionJob): Promise<DeleteAccountResult> {
    const userId = UserId.fromString(job.userId);
    const pantryResult = await this.deletePantryDataUseCase.execute({
      userId: job.userId,
      confirmationText: 'ELIMINAR',
      accountDeletion: true,
      deletionToken: job.pantryDeletionToken,
    });
    await this.deleteHouseholdOrMembership(job);
    await this.householdRepository.deleteAccountHouseholdReferences(
      job.userId,
      job.email,
    );
    const deletedKnownDeviceCount =
      await this.userDeviceRepository.deleteByUserId(userId);
    const deletedCognitoIdentityCount =
      await this.cognitoUserAdmin.deleteUsersBySubjectIds(
        job.authSubjectIds,
        job.authUsernamesBySubject,
      );
    await this.userDao.delete(userId);

    return {
      ...pantryResult,
      deletedKnownDeviceCount,
      deletedCognitoIdentityCount,
    };
  }

  private async assertHouseholdCanBeDeletedOrLeft(userId: string): Promise<{
    membership: HouseholdMembership | null;
    householdDeletionToken?: string;
  }> {
    const membership =
      await this.householdRepository.findMembershipByUserId(userId);

    if (!membership || membership.role !== 'owner') {
      return { membership };
    }

    const lock = await this.householdRepository.beginHouseholdDeletion(
      membership.householdId,
      userId,
    );

    if (!lock.canDelete) {
      throw new BadRequestException(
        'Remove household members before deleting the owner account',
      );
    }

    return { membership, householdDeletionToken: lock.token };
  }

  private async cancelOwnerLock(
    userId: string,
    membership: HouseholdMembership | null,
    token: string | undefined,
  ): Promise<void> {
    if (membership?.role !== 'owner' || !token) return;
    await this.householdRepository.cancelHouseholdDeletion(
      membership.householdId,
      userId,
      token,
    );
  }

  private async deleteHouseholdOrMembership(
    job: AccountDeletionJob,
  ): Promise<void> {
    if (!job.householdId || !job.householdRole) {
      return;
    }

    if (job.householdRole === 'owner') {
      await this.householdRepository.deleteHouseholdCascade(job.householdId);
      return;
    }

    await this.householdRepository.deleteMembership(
      job.householdId,
      job.userId,
    );
  }
}
