import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AccessCodeService } from './access-code.service';
import { AccessCodeStore } from './access-code.store';
import type { AccessCodeRecord } from './access-code.types';
import type { UserDao } from '../../application/ports/daos';
import type { ResolveHouseholdPantryAccessUseCase } from '../../application/use-cases/household.use-cases';
import type { StripeBillingStore } from '../billing/stripe-billing.store';

describe('AccessCodeService', () => {
  const householdId = '10000000-0000-4000-8000-000000000001';
  const userId = '10000000-0000-4000-8000-000000000002';
  const codeId = '10000000-0000-4000-8000-000000000003';
  const token = `DL1.${codeId}.${'a'.repeat(43)}`;
  const member = {
    requesterUserId: userId,
    householdId,
    pantryOwnerUserId: userId,
    role: 'owner',
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    contextVersion: 'membership-version',
  };
  let record: AccessCodeRecord;
  let store: {
    readCode: jest.Mock;
    readGrants: jest.Mock;
    reserveAttempt: jest.Mock;
    commitRedemption: jest.Mock;
  };
  let access: { executeRead: jest.Mock; executeOwner: jest.Mock };
  let users: { findById: jest.Mock };
  let billing: { read: jest.Mock };
  let service: AccessCodeService;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setTimeout'] });
    jest.setSystemTime(new Date('2026-01-31T15:00:00Z'));
    record = {
      id: codeId,
      plan: 'plus',
      mode: 'plan',
      months: 1,
      lifetime: false,
      redeemUntil: '2026-12-31T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      reason: 'QA',
      state: 'issued',
      secretHash: createHash('sha256').update(token).digest('hex'),
    };
    store = {
      readCode: jest.fn().mockImplementation(async () => record),
      readGrants: jest
        .fn()
        .mockResolvedValue({ householdId, revision: 0, grants: [] }),
      reserveAttempt: jest.fn().mockResolvedValue(true),
      commitRedemption: jest.fn().mockResolvedValue(true),
    };
    access = {
      executeRead: jest.fn().mockResolvedValue(member),
      executeOwner: jest.fn().mockResolvedValue(member),
    };
    users = {
      findById: jest.fn().mockResolvedValue({ email: 'owner@example.test' }),
    };
    billing = { read: jest.fn().mockResolvedValue(undefined) };
    service = new AccessCodeService(
      store as unknown as AccessCodeStore,
      access as unknown as ResolveHouseholdPantryAccessUseCase,
      users as unknown as UserDao,
      billing as unknown as StripeBillingStore,
      new ConfigService({ STRIPE_BILLING_TABLE: 'billing-test' }),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('grants a calendar month and binds atomic redemption to the owner membership', async () => {
    await expect(
      service.redeem(userId, token, householdId),
    ).resolves.toMatchObject({ householdId, replayed: false });
    expect(store.commitRedemption).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        householdId,
        contextVersion: 'membership-version',
        expectedRevision: 0,
        grant: expect.objectContaining({
          plan: 'plus',
          startsAt: '2026-01-31T15:00:00.000Z',
          expiresAt: '2026-02-28T15:00:00.000Z',
        }),
      }),
    );
  });

  it('rejects malformed or forged secrets without consuming any code', async () => {
    await expect(
      service.redeem(userId, 'bad', householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_INVALID' });
    expect(store.readCode).not.toHaveBeenCalled();
    await expect(
      service.redeem(userId, token.replace(/a$/, 'b'), householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_INVALID' });
    expect(store.commitRedemption).not.toHaveBeenCalled();
  });

  it('rejects the origin of another household before looking up the code', async () => {
    await expect(
      service.redeem(userId, token, 'different-home'),
    ).rejects.toMatchObject({ code: 'HOUSEHOLD_ORIGIN_MISMATCH' });
    expect(store.reserveAttempt).not.toHaveBeenCalled();
    expect(store.readCode).not.toHaveBeenCalled();
  });

  it('leaves an expired, revoked or recipient-restricted code unconsumed', async () => {
    record.redeemUntil = '2026-01-30T00:00:00Z';
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_EXPIRED' });
    record.state = 'revoked';
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_REVOKED' });
    record.state = 'issued';
    record.redeemUntil = '2026-12-31T00:00:00Z';
    record.recipientEmail = 'other@example.test';
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_INVALID' });
    expect(store.commitRedemption).not.toHaveBeenCalled();
  });

  it('recovers an identical successful redemption even after the claim deadline', async () => {
    record.state = 'redeemed';
    record.redeemedByHash = createHash('sha256').update(userId).digest('hex');
    record.redeemedHouseholdId = householdId;
    record.redeemUntil = '2026-01-01T00:00:00Z';
    await expect(
      service.redeem(userId, token, householdId),
    ).resolves.toMatchObject({ replayed: true });
    record.redeemedByHash = 'other-actor';
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_USED' });
    expect(store.commitRedemption).not.toHaveBeenCalled();
  });

  it('recovers a concurrent winner without issuing a duplicate grant', async () => {
    store.commitRedemption.mockImplementationOnce(async () => {
      record.state = 'redeemed';
      record.redeemedByHash = createHash('sha256').update(userId).digest('hex');
      record.redeemedHouseholdId = householdId;
      return false;
    });
    await expect(
      service.redeem(userId, token, householdId),
    ).resolves.toMatchObject({ replayed: true });
    expect(store.commitRedemption).toHaveBeenCalledTimes(1);
  });

  it('blocks an active renewal and an open checkout without consuming the gift', async () => {
    billing.read.mockResolvedValue({
      householdId,
      revision: 1,
      status: 'active',
      paidThrough: 1800000000,
    });
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_BILLING_ACTIVE' });
    billing.read.mockResolvedValue({
      householdId,
      revision: 2,
      checkout: { expiresAt: 1800000000 },
    });
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_BILLING_ACTIVE' });
    expect(store.commitRedemption).not.toHaveBeenCalled();
  });

  it('schedules the month after the paid period once renewal cancellation is confirmed', async () => {
    const paidThrough = Date.parse('2026-02-15T15:00:00Z') / 1000;
    billing.read.mockResolvedValue({
      householdId,
      revision: 3,
      status: 'active',
      cancelAtPeriodEnd: true,
      paidThrough,
    });
    await service.redeem(userId, token, householdId);
    expect(store.commitRedemption).toHaveBeenCalledWith(
      expect.objectContaining({
        billingRevision: 3,
        grant: expect.objectContaining({
          startsAt: '2026-02-15T15:00:00.000Z',
          expiresAt: '2026-03-15T15:00:00.000Z',
        }),
      }),
    );
  });

  it('grants lifetime access without an expiry or credits side effects', async () => {
    record.plan = 'pro';
    record.mode = 'developer';
    record.lifetime = true;
    delete record.months;
    await service.redeem(userId, token, householdId);
    expect(store.commitRedemption).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          plan: 'pro',
          mode: 'developer',
          lifetime: true,
          expiresAt: null,
        }),
      }),
    );
    expect(billing.read).toHaveBeenCalled();
  });

  it('enforces the persistent attempt limit before looking up another secret', async () => {
    store.reserveAttempt.mockResolvedValue(false);
    await expect(
      service.redeem(userId, token, householdId),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_RATE_LIMITED' });
    expect(store.readCode).not.toHaveBeenCalled();
  });

  it('shows household access to a member without exposing redemption or issuer metadata', async () => {
    access.executeRead.mockResolvedValue({ ...member, role: 'viewer' });
    store.readGrants.mockResolvedValue({
      revision: 1,
      grants: [
        {
          id: codeId,
          plan: 'plus',
          mode: 'plan',
          lifetime: true,
          startsAt: '2026-01-01T00:00:00Z',
          expiresAt: null,
          reason: 'private operator reason',
          redeemedByHash: 'secret',
        },
      ],
    });
    const result = await service.status(userId);
    expect(result.canRedeem).toBe(false);
    expect(result.grants[0]).not.toHaveProperty('reason');
    expect(result.grants[0]).not.toHaveProperty('redeemedByHash');
  });
});
