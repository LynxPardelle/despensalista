import type { UserDao } from '../../../application/ports/daos';
import { User } from '../../../domain/entities/user.entity';
import type { HouseholdRepository } from '../../../domain/repositories/household.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import type { StripeBillingConfig } from '../stripe-billing-config';
import type { StripeBillingStore } from '../stripe-billing.store';
import type { CfdiMail } from './cfdi-mail';
import type { CfdiRequestStore } from './cfdi-request.store';
import { CfdiService } from './cfdi.service';

const user = User.create('owner@example.com', 'owner');
const userId = user.id.toString();

function arrange(
  account: User | null = user,
  role: 'owner' | 'editor' = 'owner',
) {
  const list = jest.fn().mockResolvedValue({ data: [], has_more: false });
  const stripeConfig = {
    get: jest
      .fn()
      .mockResolvedValue({ stage: 'dev', stripe: { invoices: { list } } }),
  };
  const billing = {
    read: jest
      .fn()
      .mockResolvedValue({ householdId: 'household', customerId: 'cus_Test' }),
  };
  const households = {
    findMembershipByUserId: jest
      .fn()
      .mockResolvedValue({ role, householdId: 'household' }),
    findHouseholdById: jest
      .fn()
      .mockResolvedValue({ id: 'household', ownerUserId: userId }),
  };
  const mail = { options: jest.fn().mockReturnValue({ stage: 'dev' }) };
  const users = { findById: jest.fn().mockResolvedValue(account) };
  const service = new CfdiService(
    stripeConfig as unknown as StripeBillingConfig,
    billing as unknown as StripeBillingStore,
    households as unknown as HouseholdRepository,
    {} as CfdiRequestStore,
    mail as unknown as CfdiMail,
    users as unknown as UserDao,
  );
  return { service, users, list };
}

it('shows the signed-in owner’s saved account email and active SAT catalog', async () => {
  const { service, users } = arrange();
  await expect(service.invoices(userId, undefined)).resolves.toMatchObject({
    available: true,
    accountEmail: 'owner@example.com',
    catalog: {
      regimes: expect.arrayContaining([
        expect.objectContaining({ code: '605' }),
      ]),
      uses: expect.arrayContaining([expect.objectContaining({ code: 'D01' })]),
    },
  });
  expect(users.findById).toHaveBeenCalledWith(UserId.fromString(userId));
});

it('leaves invoice history available when the account email is missing or invalid', async () => {
  const { service } = arrange(User.create('missing-at-sign', 'owner'));
  await expect(service.invoices(userId, undefined)).resolves.toMatchObject({
    available: true,
    accountEmail: null,
  });
});

it('does not query or disclose account email for a non-owner', async () => {
  const { service, users, list } = arrange(user, 'editor');
  await expect(service.invoices(userId, undefined)).resolves.toEqual({
    available: false,
    invoices: [],
  });
  expect(users.findById).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
