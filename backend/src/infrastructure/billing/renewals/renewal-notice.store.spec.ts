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

  it('adds a per-period idempotent outbox upsert to the Stripe event transaction', () => {
    const entry = buildRenewalNoticeEnqueue(table, candidate).Update;
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
    expect(entry?.UpdateExpression).toContain(
      '#state = if_not_exists(#state, :state)',
    );
    expect(entry?.UpdateExpression).toContain(
      '#nextDay = if_not_exists(#nextDay, :nextDay)',
    );
    expect(Object.keys(entry?.ExpressionAttributeValues ?? {})).not.toContain(
      ':recipient',
    );
    expect(entry?.ConditionExpression).toBeUndefined();
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
    await expect(store.due(table, nextDay)).resolves.toEqual([]);
    const [query] = send.mock.calls[0] as [QueryCommand];
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input).toMatchObject({
      TableName: table,
      IndexName: 'RenewalNoticeDueIndex',
      KeyConditionExpression: '#queue = :queue AND nextDay <= :today',
      Limit: 10,
    });
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
      ConditionExpression: '#state = :queued AND nextDay = :observedDay',
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':observedDay': nextDay,
        ':claimExpiresAt': 220,
      },
    });
  });
});
