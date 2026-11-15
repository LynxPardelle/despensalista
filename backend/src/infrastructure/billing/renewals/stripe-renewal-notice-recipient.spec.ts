import type { UserDao } from '../../../application/ports/daos';
import { Household } from '../../../domain/entities/household.entity';
import { User } from '../../../domain/entities/user.entity';
import type { HouseholdRepository } from '../../../domain/repositories/household.repository';
import type { CognitoUserAdminService } from '../../auth/cognito/cognito-user-admin.service';
import type { StripeBillingService } from '../stripe-billing.service';
import type { RenewalNoticeCandidate } from './renewal-notice.types';
import { StripeRenewalNoticeRecipient } from './stripe-renewal-notice-recipient';

function fixture() {
  const owner = User.create('owner@example.invalid', 'Owner');
  owner.linkAuthSubject('owner-sub', 'Google_owner');
  const household = Household.create(owner);
  const candidate: RenewalNoticeCandidate = {
    householdId: household.id,
    subscriptionId: 'sub_test',
    renewalAt: 1_800_000_000,
    amountMinor: 5900,
    currency: 'mxn',
  };
  const getUpcomingRenewal = jest.fn().mockResolvedValue(candidate);
  const getVerifiedEmailBySubjectId = jest.fn().mockResolvedValue(owner.email);
  const findHouseholdById = jest.fn().mockResolvedValue(household);
  const findById = jest.fn().mockResolvedValue(owner);
  const reader = new StripeRenewalNoticeRecipient(
    { getUpcomingRenewal } as unknown as StripeBillingService,
    { getVerifiedEmailBySubjectId } as unknown as CognitoUserAdminService,
    { findHouseholdById } as unknown as HouseholdRepository,
    { findById } as unknown as UserDao,
  );
  return {
    candidate,
    owner,
    reader,
    getUpcomingRenewal,
    getVerifiedEmailBySubjectId,
  };
}

describe('StripeRenewalNoticeRecipient', () => {
  it('uses a currently verified address belonging to the active household owner', async () => {
    const { candidate, reader, getVerifiedEmailBySubjectId } = fixture();
    await expect(reader.resolve(candidate)).resolves.toEqual({
      status: 'eligible',
      recipient: 'owner@example.invalid',
    });
    expect(getVerifiedEmailBySubjectId).toHaveBeenCalledWith(
      'owner-sub',
      'Google_owner',
    );

    getVerifiedEmailBySubjectId.mockResolvedValue('changed@example.invalid');
    await expect(reader.resolve(candidate)).resolves.toEqual({
      status: 'skip',
      reason: 'missing_verified_recipient',
    });
  });

  it('skips changed periods and nonrenewing subscriptions before looking up email', async () => {
    const {
      candidate,
      reader,
      getUpcomingRenewal,
      getVerifiedEmailBySubjectId,
    } = fixture();
    getUpcomingRenewal.mockResolvedValueOnce({
      ...candidate,
      renewalAt: candidate.renewalAt + 86_400,
    });
    await expect(reader.resolve(candidate)).resolves.toEqual({
      status: 'skip',
      reason: 'subscription_changed',
    });

    getUpcomingRenewal.mockResolvedValueOnce(undefined);
    await expect(reader.resolve(candidate)).resolves.toEqual({
      status: 'skip',
      reason: 'nonrenewing',
    });
    expect(getVerifiedEmailBySubjectId).not.toHaveBeenCalled();
  });
});
