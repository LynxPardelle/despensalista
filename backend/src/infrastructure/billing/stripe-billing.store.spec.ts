import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDbDocumentClientService } from '../database/dynamodb/dynamodb-document-client.service';
import { StripeBillingStore, type BillingRecord } from './stripe-billing.store';

describe('StripeBillingStore Checkout consent', () => {
  it('atomically reserves a live attempt and appends its first consent without personal fields', async () => {
    const send = jest.fn().mockResolvedValue({});
    const store = new StripeBillingStore({
      send,
    } as unknown as DynamoDbDocumentClientService);
    const table = 'despensalista-prod-billing';
    const checkout = {
      token: 'test-token',
      expiresAt: 1_800_000_000,
      termsVersion: '2026-11-15',
    };
    const next: BillingRecord = {
      householdId: 'household-1',
      revision: 2,
      customerId: 'cus_test',
      checkout,
    };
    const consent = {
      termsVersion: '2026-11-15',
      acceptedAt: '2026-11-15T12:00:00.000Z',
    };

    await expect(store.save(next, table, consent)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const write = send.mock.calls[0]?.[0] as TransactWriteCommand;
    expect(write).toBeInstanceOf(TransactWriteCommand);
    expect(write.input.TransactItems).toEqual(
      expect.arrayContaining([
        {
          Put: {
            TableName: table,
            Item: { pk: 'checkout-consent:test-token', ...consent },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: expect.objectContaining({
            ConditionExpression: 'revision = :revision',
          }),
        },
      ]),
    );
  });
});
