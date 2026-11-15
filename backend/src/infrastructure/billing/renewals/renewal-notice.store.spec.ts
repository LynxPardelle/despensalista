import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import { renewalNoticeDueDay, renewalNoticeKey } from './renewal-notice.policy';
import {
  buildRenewalNoticeEnqueue,
  RenewalNoticeStore,
} from './renewal-notice.store';
import type { RenewalNoticeCandidate } from './renewal-notice.types';

const candidate: RenewalNoticeCandidate = {
  householdId: 'household-1',
  subscriptionId: 'sub_dev_1',
  renewalAt: Date.parse('2027-01-01T02:00:00Z') / 1000,
  amountMinor: 5900,
  currency: 'mxn',
};
const table = 'despensalista-dev-renewal-notices';
const pk = renewalNoticeKey(candidate);
const nextDay = renewalNoticeDueDay(candidate);

describe('renewal notice persistence', () => {
  const send = jest.fn();
  const store = new RenewalNoticeStore({
    send,
  } as unknown as DynamoDbDocumentClientService);

  beforeEach(() => send.mockReset());

  it('adds a conditional per-period outbox creation to the Stripe event transaction', () => {
    const entry = buildRenewalNoticeEnqueue(table, candidate)?.Update;
    expect(entry).toMatchObject({
      TableName: table,
      Key: { pk },
      ExpressionAttributeValues: {
        ':state': 'queued',
        ':queue': 'DUE',
        ':nextDay': nextDay,
        ':expiresAt': candidate.renewalAt + 90 * 86_400,
      },
    });
    expect(entry?.UpdateExpression).toContain('#state = :state');
    expect(entry?.UpdateExpression).toContain('#nextDay = :nextDay');
    expect(Object.keys(entry?.ExpressionAttributeValues ?? {})).not.toContain(
      ':recipient',
    );
    expect(entry?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('only reopens a never-attempted notice skipped after cancellation when renewal resumes in its window', () => {
    const skipped = {
      ...candidate,
      pk,
      nextDay: 10_000_000,
      state: 'skipped',
      result: 'nonrenewing',
    };
    const resume = new Date(nextDay * 86_400_000 + 18 * 3_600_000);
    const plan = (saved: Record<string, unknown>, asOf = resume) =>
      buildRenewalNoticeEnqueue(table, candidate, saved, asOf);

    const reopen = plan(skipped)?.Update;
    expect(reopen).toMatchObject({
      Key: { pk },
      ConditionExpression: expect.stringContaining(
        '#result = :nonrenewing AND attribute_not_exists(sendAttempted)',
      ),
      UpdateExpression: expect.stringContaining(
        '#state = :queued, #nextDay = :nextDay, #generation = :generation',
      ),
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':nextDay': nextDay,
        ':nonrenewing': 'nonrenewing',
      },
    });
    expect(plan({ ...skipped, sendAttempted: true })).toBeUndefined();
    expect(
      plan({ ...skipped, result: 'subscription_changed' }),
    ).toBeUndefined();
    expect(plan({ ...skipped, state: 'sending' })).toBeUndefined();
    expect(plan({ ...skipped, state: 'unknown' })).toBeUndefined();
    expect(plan({ ...skipped, state: 'accepted' })).toBeUndefined();
    expect(
      plan({ ...skipped, householdId: 'another-household' }),
    ).toBeUndefined();
    expect(
      plan(skipped, new Date(resume.getTime() + 3 * 86_400_000)),
    ).toBeUndefined();
  });

  it('fences a worker that observed cancellation before a queued renewal resumed', async () => {
    const stale = {
      ...candidate,
      pk,
      nextDay,
      state: 'queued' as const,
      generation: 'before-resume',
    };
    send.mockResolvedValueOnce({ Item: stale });
    const resume = await store.prepareEnqueue(table, candidate);
    expect((send.mock.calls[0] as [GetCommand])[0].input).toMatchObject({
      Key: { pk },
      ConsistentRead: true,
    });
    expect(resume?.Update).toMatchObject({
      ConditionExpression:
        '#state = :queued AND #generation = :observedGeneration',
      UpdateExpression: 'SET #generation = :generation',
      ExpressionAttributeValues: {
        ':observedGeneration': stale.generation,
        ':generation': expect.any(String),
      },
    });
    expect(resume?.Update?.ExpressionAttributeValues?.[':generation']).not.toBe(
      stale.generation,
    );

    const generationConflict = new ConditionalCheckFailedException({
      $metadata: {},
      message: 'Generation changed',
    });
    send
      .mockRejectedValueOnce(generationConflict)
      .mockRejectedValueOnce(generationConflict);
    await expect(
      store.finish(
        table,
        stale,
        { state: 'skipped', reason: 'nonrenewing' },
        100,
      ),
    ).resolves.toBe(false);
    await expect(store.claim(table, stale, 101)).resolves.toBeUndefined();
    for (const [update] of send.mock.calls.slice(1) as [UpdateCommand][]) {
      expect(update.input.ConditionExpression).toContain(
        '#generation = :observedGeneration',
      );
      expect(
        update.input.ExpressionAttributeValues?.[':observedGeneration'],
      ).toBe(stale.generation);
    }
  });

  it('reads only the explicitly targeted notice using a strong read', async () => {
    send.mockResolvedValueOnce({ Item: { pk, state: 'accepted' } });
    await expect(store.read(table, pk)).resolves.toBeUndefined();
    const [read] = send.mock.calls[0] as [GetCommand];
    expect(read).toBeInstanceOf(GetCommand);
    expect(read.input).toEqual({
      TableName: table,
      Key: { pk },
      ConsistentRead: true,
    });
  });

  it('uses the due index with a bounded query rather than a scan', async () => {
    send.mockResolvedValueOnce({});
    await expect(store.due(table, nextDay)).resolves.toEqual({
      jobs: [],
      hasMoreDue: false,
    });
    const [query] = send.mock.calls[0] as [QueryCommand];
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input).toMatchObject({
      TableName: table,
      IndexName: 'RenewalNoticeDueIndex',
      KeyConditionExpression: '#queue = :queue AND nextDay <= :today',
      Limit: 10,
    });
  });

  it('follows the due-index cursor and reports when its page budget is exhausted', async () => {
    const firstRows = Array.from({ length: 10 }, (_, index) => ({
      ...candidate,
      pk: `test-${index}`,
      nextDay,
      state: 'queued',
    }));
    const followingRow = { ...firstRows[0], pk: 'test-10' };
    const cursor = { pk: firstRows[9].pk, queue: 'DUE', nextDay };
    send
      .mockResolvedValueOnce({ Items: firstRows, LastEvaluatedKey: cursor })
      .mockResolvedValueOnce({
        Items: [followingRow],
        LastEvaluatedKey: { pk: followingRow.pk, queue: 'DUE', nextDay },
      });

    await expect(store.due(table, nextDay)).resolves.toEqual({
      jobs: [...firstRows, followingRow],
      hasMoreDue: true,
    });
    const [followingQuery] = send.mock.calls[1] as [QueryCommand];
    expect(followingQuery.input.ExclusiveStartKey).toEqual(cursor);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns no claim when another worker already updated the queued record', async () => {
    send.mockRejectedValueOnce(
      new ConditionalCheckFailedException({
        $metadata: {},
        message: 'Claim already taken',
      }),
    );
    await expect(
      store.claim(table, { ...candidate, pk, nextDay, state: 'queued' }, 100),
    ).resolves.toBeUndefined();
    const [update] = send.mock.calls[0] as [UpdateCommand];
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input).toMatchObject({
      Key: { pk },
      ConditionExpression:
        '#state = :queued AND nextDay = :observedDay AND attribute_not_exists(#generation)',
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':observedDay': nextDay,
        ':claimExpiresAt': 220,
      },
    });
  });
});
