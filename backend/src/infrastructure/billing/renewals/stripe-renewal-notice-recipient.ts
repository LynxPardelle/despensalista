import { Inject, Injectable } from '@nestjs/common';
import type { UserDao } from '../../../application/ports/daos';
import { HOUSEHOLD_REPOSITORY, USER_DAO } from '../../../application/tokens';
import { UserAccountStatus } from '../../../domain/enums';
import type { HouseholdRepository } from '../../../domain/repositories/household.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { CognitoUserAdminService } from '../../auth/cognito/cognito-user-admin.service';
import { StripeBillingService } from '../stripe-billing.service';
import type {
  RenewalNoticeCandidate,
  RenewalNoticeRecipient,
  RenewalRecipientResolution,
} from './renewal-notice.types';

@Injectable()
export class StripeRenewalNoticeRecipient implements RenewalNoticeRecipient {
  constructor(
    private readonly stripe: StripeBillingService,
    private readonly cognito: CognitoUserAdminService,
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly households: HouseholdRepository,
    @Inject(USER_DAO)
    private readonly users: UserDao,
  ) {}

  async resolve(
    candidate: RenewalNoticeCandidate,
  ): Promise<RenewalRecipientResolution> {
    const household = await this.households.findHouseholdById(
      candidate.householdId,
    );
    if (!household) return { status: 'skip', reason: 'not_owned' };

    const upcoming = await this.stripe.getUpcomingRenewal(
      candidate.householdId,
    );
    if (!upcoming) return { status: 'skip', reason: 'nonrenewing' };
    if (
      upcoming.subscriptionId !== candidate.subscriptionId ||
      upcoming.renewalAt !== candidate.renewalAt ||
      upcoming.amountMinor !== candidate.amountMinor ||
      upcoming.currency !== candidate.currency
    ) {
      return { status: 'skip', reason: 'subscription_changed' };
    }

    const owner = await this.users.findById(
      UserId.fromString(household.ownerUserId),
    );
    if (
      !owner ||
      owner.status !== UserAccountStatus.ACTIVE ||
      owner.isAccountDeletionPending()
    ) {
      return { status: 'skip', reason: 'not_owned' };
    }
    const accountEmail = owner.email.trim().toLocaleLowerCase('en-US');
    const usernames = owner.authUsernamesBySubject;
    for (const subjectId of owner.authSubjectIds) {
      const verified = await this.cognito.getVerifiedEmailBySubjectId(
        subjectId,
        usernames[subjectId],
      );
      if (verified && verified === accountEmail) {
        return { status: 'eligible', recipient: verified };
      }
    }
    return { status: 'skip', reason: 'missing_verified_recipient' };
  }
}
