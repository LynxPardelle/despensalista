import {
  mexicoDay,
  noticeWindow,
  renewalNoticeKey,
} from './renewal-notice.policy';
import type { RenewalNoticeCandidate } from './renewal-notice.types';

describe('renewal notice calendar', () => {
  const candidate: RenewalNoticeCandidate = {
    householdId: 'owner-household',
    subscriptionId: 'sub_dev_123',
    renewalAt: Date.parse('2027-01-01T02:00:00Z') / 1000,
    amountMinor: 5900,
    currency: 'mxn',
  };

  it('uses the Mexico City date across midnight UTC and years', () => {
    expect(mexicoDay(new Date('2027-01-01T02:00:00Z'))).toBe(
      Date.UTC(2026, 11, 31) / 86_400_000,
    );
    expect(noticeWindow(candidate, new Date('2026-12-24T05:59:59Z'))).toBe(
      'early',
    );
    expect(noticeWindow(candidate, new Date('2026-12-24T06:00:00Z'))).toBe(
      'due',
    );
    expect(noticeWindow(candidate, new Date('2026-12-26T06:00:00Z'))).toBe(
      'due',
    );
    expect(noticeWindow(candidate, new Date('2026-12-27T06:00:00Z'))).toBe(
      'late',
    );
  });

  it('makes the deduplication key stable across eligibility/amount changes and unique by period', () => {
    expect(renewalNoticeKey({ ...candidate, amountMinor: 6100 })).toBe(
      renewalNoticeKey(candidate),
    );
    expect(
      renewalNoticeKey({
        ...candidate,
        renewalAt: candidate.renewalAt + 86_400,
      }),
    ).not.toBe(renewalNoticeKey(candidate));
  });
});
