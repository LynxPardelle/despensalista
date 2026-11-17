import { ConfigService } from '@nestjs/config';
import { HouseholdSwitchAccessService } from './household-switch-access.service';
import type { HouseholdRepository } from '../../domain/repositories/household.repository';

describe('HouseholdSwitchAccessService', () => {
  const userId = 'fixture-user';
  let registerHouseholdSwitchCandidate: jest.Mock;
  let markHouseholdUsed: jest.Mock;

  function makeService(enabled: boolean) {
    return new HouseholdSwitchAccessService(
      new ConfigService({ HOUSEHOLD_SWITCH_ENABLED: String(enabled) }),
      {
        registerHouseholdSwitchCandidate,
        markHouseholdUsed,
      } as unknown as HouseholdRepository,
    );
  }

  beforeEach(() => {
    registerHouseholdSwitchCandidate = jest.fn().mockResolvedValue(undefined);
    markHouseholdUsed = jest.fn().mockResolvedValue(undefined);
  });

  it('keeps the new-owner marker untouched when they view the home or accept an invite', async () => {
    const service = makeService(true);

    await service.registerNewAccount(userId);
    await service.prepareAuthenticatedWrite(userId, 'GET', '/api/household');
    await service.prepareAuthenticatedWrite(
      userId,
      'POST',
      '/api/household/invites/accept?source=profile',
    );

    expect(registerHouseholdSwitchCandidate).toHaveBeenCalledWith(userId);
    expect(markHouseholdUsed).not.toHaveBeenCalled();
  });

  it.each([
    '/api/pantry/checkout',
    '/api/household/invites',
    '/api/billing/checkout',
    '/api/products/auth',
  ])('records attempted use before allowing a write to %s', async (path) => {
    await makeService(true).prepareAuthenticatedWrite(userId, 'POST', path);
    expect(markHouseholdUsed).toHaveBeenCalledWith(userId);
  });

  it('records household use even when new switches are disabled', async () => {
    const service = makeService(false);
    await service.registerNewAccount(userId);
    await service.prepareAuthenticatedWrite(
      userId,
      'POST',
      '/api/pantry/checkout',
    );
    expect(registerHouseholdSwitchCandidate).not.toHaveBeenCalled();
    expect(markHouseholdUsed).toHaveBeenCalledWith(userId);
  });
});
