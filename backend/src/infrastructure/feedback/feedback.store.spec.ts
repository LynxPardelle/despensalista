import { ConfigService } from '@nestjs/config';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDbDocumentClientService } from '../database/dynamodb/dynamodb-document-client.service';
import { FeedbackStore } from './feedback.store';

describe('FeedbackStore', () => {
  const submission = {
    submissionId: '1f37dc5e-d32b-4bf7-936a-bda451ca7afe',
    category: 'bug' as const,
    message: 'La lista no se actualiza después de guardar.',
  };
  const accountId = 'user-1';
  const createdAt = new Date('2026-11-14T21:34:00.000Z');
  const send = jest.fn();
  const client = { send } as unknown as DynamoDbDocumentClientService;
  let store: FeedbackStore;

  beforeEach(() => {
    send.mockReset();
    store = new FeedbackStore(
      new ConfigService({
        FEEDBACK_TABLE: 'despensalista-dev-feedback',
        DYNAMODB_USERS_TABLE: 'despensalista-dev-users',
      }),
      client,
    );
  });

  it('atomically checks the account and daily budget before publishing to the inbox', async () => {
    send.mockResolvedValue({});

    await expect(
      store.submit(accountId, submission, createdAt),
    ).resolves.toEqual({
      id: submission.submissionId,
    });

    const [command] = send.mock.calls[0] as [TransactWriteCommand];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const [account, limit, report] = command.input.TransactItems!;
    expect(account.ConditionCheck).toMatchObject({
      TableName: 'despensalista-dev-users',
      Key: { pk: 'USER#user-1' },
      ConditionExpression: expect.stringContaining('deletionFenceExpiresAt'),
    });
    expect(limit.Update).toMatchObject({
      Key: { sk: 'LIMIT#2026-11-14' },
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
      ExpressionAttributeValues: { ':max': 5 },
    });
    expect(report.Put).toMatchObject({
      Item: {
        id: submission.submissionId,
        category: 'bug',
        message: submission.message,
        createdAt: createdAt.toISOString(),
        inboxMonth: 'INBOX#2026-11',
        inboxOrder: `${createdAt.toISOString()}#${submission.submissionId}`,
        expiresAt: Date.parse('2027-02-12T21:34:00.000Z') / 1000,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(report.Put?.Item?.pk).not.toContain(accountId);
  });

  it('returns the original receipt for an identical retry even at the account limit', async () => {
    send
      .mockRejectedValueOnce(
        transactionCancelled('None', 'ConditionalCheckFailed', 'None'),
      )
      .mockResolvedValueOnce({
        Item: { ...submission, id: submission.submissionId },
      });

    await expect(
      store.submit(accountId, submission, createdAt),
    ).resolves.toEqual({
      id: submission.submissionId,
    });
    const [read] = send.mock.calls[1] as [GetCommand];
    expect(read).toBeInstanceOf(GetCommand);
    expect(read.input.ConsistentRead).toBe(true);
  });

  it('rejects a new report after the rate budget is exhausted', async () => {
    send
      .mockRejectedValueOnce(
        transactionCancelled('None', 'ConditionalCheckFailed', 'None'),
      )
      .mockResolvedValueOnce({});

    await expect(
      store.submit(accountId, submission, createdAt),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it('refuses to record feedback for an account whose deletion started after authentication', async () => {
    send.mockRejectedValueOnce(
      transactionCancelled(
        'ConditionalCheckFailed',
        'None',
        'ConditionalCheckFailed',
      ),
    );

    await expect(
      store.submit(accountId, submission, createdAt),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('erases all reports and limits for only that account across pages', async () => {
    const accountPartition =
      'ACCOUNT#c6c289e49e9c05b2145860387b73bcb18df43fb09a1e4a4a9713c76c88bb541b';
    const first = { pk: accountPartition, sk: 'LIMIT#2026-11-14' };
    const second = { pk: accountPartition, sk: 'REPORT#old' };
    send
      .mockResolvedValueOnce({ Items: [first], LastEvaluatedKey: first })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [second] })
      .mockResolvedValueOnce({});

    await store.deleteForAccount(accountId);

    const [firstRead, firstDelete, secondRead, secondDelete] =
      send.mock.calls.map(
        ([command]: [QueryCommand | DeleteCommand]) => command,
      ) as [QueryCommand, DeleteCommand, QueryCommand, DeleteCommand];
    expect(firstRead).toBeInstanceOf(QueryCommand);
    expect(firstRead.input.ConsistentRead).toBe(true);
    expect(secondRead.input.ExclusiveStartKey).toEqual(first);
    expect(firstDelete).toBeInstanceOf(DeleteCommand);
    expect(firstDelete.input.Key).toEqual(first);
    expect(secondDelete.input.Key).toEqual(second);
  });

  it('leaves stages without feedback storage disabled', async () => {
    const disabled = new FeedbackStore(new ConfigService({}), client);

    expect(disabled.available).toBe(false);
    await expect(
      disabled.submit(accountId, submission, createdAt),
    ).rejects.toMatchObject({
      status: 404,
    });
    await disabled.deleteForAccount(accountId);
    expect(send).not.toHaveBeenCalled();
  });
});

function transactionCancelled(...codes: string[]) {
  return new TransactionCanceledException({
    $metadata: {},
    message: 'transaction cancelled',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}
