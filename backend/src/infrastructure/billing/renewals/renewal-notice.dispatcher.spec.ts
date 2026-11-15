import { ConfigService } from '@nestjs/config';
import {
  renewalNoticeDevTable,
  sesSuccessSimulator,
} from './renewal-notice.config';
import { RenewalNoticeDispatcher } from './renewal-notice.dispatcher';
import { mexicoDay, renewalNoticeKey } from './renewal-notice.policy';
import {
  type RenewalNoticeRow,
  type RenewalNoticeStore,
} from './renewal-notice.store';
import type {
  RenewalNoticeCandidate,
  RenewalNoticeRecipient,
  RenewalNoticeTransport,
} from './renewal-notice.types';

const recipientAddress = 'qa@example.test';
const dueAt = new Date('2026-12-24T08:00:00Z');
const candidate: RenewalNoticeCandidate = {
  householdId: 'household-1',
  subscriptionId: 'sub_dev_1',
  renewalAt: Date.parse('2027-01-01T02:00:00Z') / 1000,
  amountMinor: 5900,
  currency: 'mxn',
};
const queued = {
  ...candidate,
  pk: renewalNoticeKey(candidate),
  nextDay: mexicoDay(dueAt),
  state: 'queued',
} satisfies RenewalNoticeRow;
const claimed = {
  ...queued,
  state: 'sending',
  claim: 'claim-1',
  claimExpiresAt: Number.MAX_SAFE_INTEGER,
} satisfies RenewalNoticeRow;

describe('renewal notice dispatching', () => {
  const store = {
    due: jest.fn(),
    read: jest.fn(),
    finish: jest.fn(),
    claim: jest.fn(),
    reschedule: jest.fn(),
  };
  const recipient: jest.Mocked<RenewalNoticeRecipient> = { resolve: jest.fn() };
  const transport: jest.Mocked<RenewalNoticeTransport> = { send: jest.fn() };

  function dispatcher(overrides: Record<string, string> = {}) {
    return new RenewalNoticeDispatcher(
      new ConfigService({
        STRIPE_BILLING_MODE: 'test',
        RENEWAL_NOTICE_TABLE: renewalNoticeDevTable,
        RENEWAL_NOTICE_MODE: 'ses',
        RENEWAL_NOTICE_SES_TEST_TO: recipientAddress,
        ...overrides,
      }),
      store as unknown as RenewalNoticeStore,
      recipient,
      transport,
    );
  }

  beforeEach(() => {
    jest.resetAllMocks();
    store.due.mockResolvedValue({ jobs: [queued], hasMoreDue: false });
    store.read.mockResolvedValue(queued);
    store.claim.mockResolvedValue(claimed);
    store.finish.mockResolvedValue(true);
    store.reschedule.mockResolvedValue(true);
    recipient.resolve.mockResolvedValue({
      status: 'eligible',
      recipient: recipientAddress,
    });
    transport.send.mockResolvedValue({ messageId: 'provider-id' });
  });

  it('disables even a valid notice table when Stripe is live', async () => {
    const live = dispatcher({ STRIPE_BILLING_MODE: 'live' });
    expect(await live.dispatch(dueAt)).toMatchObject({
      enabled: false,
      processed: 0,
    });
    expect(store.due).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('can dry run by exact notice ID without touching any other job or writing', async () => {
    const dryRun = dispatcher({ RENEWAL_NOTICE_MODE: 'dry-run' });
    expect(await dryRun.dispatch(dueAt, queued.pk)).toMatchObject({
      wouldSend: 1,
      accepted: 0,
    });
    expect(store.read).toHaveBeenCalledWith(renewalNoticeDevTable, queued.pk);
    expect(store.due).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
    await expect(
      dryRun.dispatch(dueAt, 'renewal-invalid'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('does not send for a canceled subscription', async () => {
    recipient.resolve.mockResolvedValueOnce({
      status: 'skip',
      reason: 'nonrenewing',
    });
    expect(await dispatcher().dispatch(dueAt)).toMatchObject({
      skipped: 1,
      accepted: 0,
    });
    expect(store.finish).toHaveBeenCalledWith(
      renewalNoticeDevTable,
      queued,
      { state: 'skipped', reason: 'nonrenewing' },
      expect.any(Number),
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('checks more than ten notices in dry-run without updating the queue', async () => {
    const jobs = Array.from({ length: 11 }, (_, index) => ({
      ...queued,
      pk: `test-${index}`,
    }));
    store.due.mockResolvedValueOnce({ jobs, hasMoreDue: false });
    const dryRun = dispatcher({ RENEWAL_NOTICE_MODE: 'dry-run' });

    expect(await dryRun.dispatch(dueAt)).toMatchObject({
      processed: 11,
      wouldSend: 11,
      hasMoreDue: false,
    });
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.reschedule).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('limits a live poll to one possible delivery and leaves the rest for later', async () => {
    store.due.mockResolvedValueOnce({
      jobs: [queued, { ...queued, pk: 'next-notice' }],
      hasMoreDue: false,
    });
    expect(await dispatcher().dispatch(dueAt)).toMatchObject({
      processed: 1,
      accepted: 1,
      hasMoreDue: true,
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  it('rejects recipients other than the configured sandbox address', async () => {
    recipient.resolve.mockResolvedValueOnce({
      status: 'eligible',
      recipient: 'other@example.test',
    });
    expect(await dispatcher().dispatch(dueAt)).toMatchObject({
      blocked: 1,
      accepted: 0,
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('allows the simulator only when explicitly configured and delivers a test-labelled notice', async () => {
    const simulate = dispatcher({
      RENEWAL_NOTICE_SES_TEST_TO: sesSuccessSimulator,
    });
    expect(await simulate.dispatch(dueAt)).toMatchObject({
      accepted: 1,
      unknown: 0,
    });
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: sesSuccessSimulator,
        noticeId: queued.pk,
        subject: expect.stringContaining('[Prueba de DespensaLista]'),
        text: expect.stringContaining('31 de diciembre de 2026'),
      }),
    );
    expect(store.finish).toHaveBeenCalledWith(
      renewalNoticeDevTable,
      claimed,
      { state: 'accepted', messageId: 'provider-id' },
      expect.any(Number),
    );
  });

  it('only calls SES for the worker that acquired the durable claim', async () => {
    store.claim.mockResolvedValueOnce(claimed).mockResolvedValueOnce(undefined);
    const worker = dispatcher();
    const results = await Promise.all([
      worker.dispatch(dueAt),
      worker.dispatch(dueAt),
    ]);
    expect(results.map((result) => result.accepted)).toEqual([1, 0]);
    expect(results[1].busy).toBe(1);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('records unknown exactly once after a provider timeout, without requeueing', async () => {
    transport.send.mockRejectedValueOnce(
      new Error('Provider connection timed out'),
    );
    const worker = dispatcher();
    expect(await worker.dispatch(dueAt)).toMatchObject({
      unknown: 1,
      accepted: 0,
    });
    expect(store.finish).toHaveBeenCalledWith(
      renewalNoticeDevTable,
      claimed,
      { state: 'unknown', reason: 'provider_outcome_unknown' },
      expect.any(Number),
    );
    expect(store.reschedule).not.toHaveBeenCalled();
    store.read.mockResolvedValueOnce(undefined);
    expect(await worker.dispatch(dueAt, queued.pk)).toMatchObject({
      processed: 0,
    });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('never re-sends an expired claim', async () => {
    const expired = { ...claimed, claimExpiresAt: 0 };
    store.due.mockResolvedValueOnce({ jobs: [expired], hasMoreDue: false });
    expect(await dispatcher().dispatch(dueAt)).toMatchObject({
      unknown: 1,
      accepted: 0,
    });
    expect(store.finish).toHaveBeenCalledWith(
      renewalNoticeDevTable,
      expired,
      { state: 'unknown', reason: 'interrupted_attempt' },
      expect.any(Number),
    );
    expect(recipient.resolve).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('defers only failures before transport and blocks after the five-day deadline', async () => {
    recipient.resolve.mockRejectedValueOnce(new Error('Stripe unavailable'));
    const worker = dispatcher();
    expect(await worker.dispatch(dueAt)).toMatchObject({ deferred: 1 });
    expect(store.reschedule).toHaveBeenCalledWith(
      renewalNoticeDevTable,
      queued,
      queued.nextDay + 1,
    );
    expect(
      await worker.dispatch(new Date('2026-12-27T06:00:00Z')),
    ).toMatchObject({ late: 1 });
    expect(recipient.resolve).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
  });
});
