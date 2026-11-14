import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type PutCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { DynamoDbDocumentClientService } from '../database/dynamodb/dynamodb-document-client.service';

export interface CheckoutAttempt {
  token: string;
  expiresAt: number;
  stripeSessionId?: string;
}

export interface BillingRecord {
  householdId: string;
  revision: number;
  customerCreationStartedAt?: number;
  customerId?: string;
  checkout?: CheckoutAttempt;
  status?: Stripe.Subscription.Status | 'pending';
  subscriptionId?: string;
  paidThrough?: number;
  cancelAtPeriodEnd?: boolean;
  closed?: boolean;
}

@Injectable()
export class StripeBillingStore {
  constructor(
    @Optional() private readonly dynamodb?: DynamoDbDocumentClientService,
  ) {}

  async read(
    table: string,
    householdId: string,
  ): Promise<BillingRecord | undefined> {
    const row = await this.db.send(
      new GetCommand({
        TableName: table,
        Key: { pk: `household:${householdId}` },
        ConsistentRead: true,
      }),
    );
    return row.Item as BillingRecord | undefined;
  }

  async save(next: BillingRecord, table: string): Promise<boolean> {
    try {
      if (next.customerId) {
        await this.db.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: this.recordWrite(next, table) },
              {
                Put: {
                  TableName: table,
                  Item: {
                    pk: `customer:${next.customerId}`,
                    householdId: next.householdId,
                  },
                  ConditionExpression:
                    'attribute_not_exists(pk) OR householdId = :household',
                  ExpressionAttributeValues: { ':household': next.householdId },
                },
              },
            ],
          }),
        );
      } else {
        await this.db.send(new PutCommand(this.recordWrite(next, table)));
      }
      return true;
    } catch (error) {
      if (isWriteConflict(error)) {
        return false;
      }
      throw error;
    }
  }

  async readHouseholdByCustomer(
    table: string,
    customerId: string,
  ): Promise<string | undefined> {
    const row = await this.db.send(
      new GetCommand({
        TableName: table,
        Key: { pk: `customer:${customerId}` },
        ConsistentRead: true,
      }),
    );
    return typeof row.Item?.householdId === 'string'
      ? row.Item.householdId
      : undefined;
  }

  async beginCheckout(
    table: string,
    householdId: string,
  ): Promise<string | undefined> {
    const token = randomUUID();
    const now = Date.now();
    try {
      await this.db.send(
        new PutCommand({
          TableName: table,
          // Longer than the configured Lambda timeout. The process cannot still
          // create a Stripe session when deletion gains a stale checkout lease.
          Item: {
            pk: checkoutLock(householdId),
            lease: token,
            leaseUntil: now + 60_000,
          },
          ConditionExpression:
            'attribute_not_exists(closing) AND (attribute_not_exists(lease) OR leaseUntil <= :now)',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      return token;
    } catch (error) {
      if (isWriteConflict(error)) return undefined;
      throw error;
    }
  }

  async endCheckout(
    table: string,
    householdId: string,
    token: string,
  ): Promise<void> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: table,
          Item: { pk: checkoutLock(householdId) },
          ConditionExpression: 'lease = :token',
          ExpressionAttributeValues: { ':token': token },
        }),
      );
    } catch (error) {
      if (!isWriteConflict(error)) throw error;
    }
  }

  async beginClosure(table: string, householdId: string): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: table,
          Item: { pk: checkoutLock(householdId), closing: true },
          ConditionExpression:
            'attribute_not_exists(lease) OR leaseUntil <= :now',
          ExpressionAttributeValues: { ':now': Date.now() },
        }),
      );
      return true;
    } catch (error) {
      if (isWriteConflict(error)) return false;
      throw error;
    }
  }

  async finishClosure(table: string, current: BillingRecord): Promise<boolean> {
    const record = this.recordWrite(
      {
        householdId: current.householdId,
        revision: current.revision + 1,
        closed: true,
      },
      table,
    );
    if (!current.customerId) {
      return this.save(
        {
          householdId: current.householdId,
          revision: current.revision + 1,
          closed: true,
        },
        table,
      );
    }
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: record },
            {
              Delete: {
                TableName: table,
                Key: { pk: `customer:${current.customerId}` },
                ConditionExpression:
                  'attribute_not_exists(pk) OR householdId = :household',
                ExpressionAttributeValues: {
                  ':household': current.householdId,
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (isWriteConflict(error)) return false;
      throw error;
    }
  }

  async hasEvent(table: string, eventId: string): Promise<boolean> {
    const row = await this.db.send(
      new GetCommand({
        TableName: table,
        Key: { pk: `event:${eventId}` },
        ConsistentRead: true,
      }),
    );
    return Boolean(row.Item);
  }

  async applyEvent(
    next: BillingRecord,
    table: string,
    eventId: string,
  ): Promise<boolean> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: {
                  pk: `event:${eventId}`,
                  expiresAt: Math.floor(Date.now() / 1000) + 35 * 86_400,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: this.recordWrite(next, table) },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.some(
          (reason) =>
            reason.Code === 'ConditionalCheckFailed' ||
            reason.Code === 'TransactionConflict',
        ) &&
        error.CancellationReasons.every(
          (reason) =>
            reason.Code === 'None' ||
            reason.Code === 'ConditionalCheckFailed' ||
            reason.Code === 'TransactionConflict',
        )
      ) {
        return this.hasEvent(table, eventId);
      }
      throw error;
    }
  }

  private recordWrite(next: BillingRecord, table: string): PutCommandInput {
    return {
      TableName: table,
      Item: { ...next, pk: `household:${next.householdId}` },
      ...(next.revision === 1
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : {
            ConditionExpression: 'revision = :revision',
            ExpressionAttributeValues: { ':revision': next.revision - 1 },
          }),
    };
  }

  private get db(): DynamoDbDocumentClientService {
    if (!this.dynamodb) {
      throw new ServiceUnavailableException('Sandbox billing is unavailable');
    }
    return this.dynamodb;
  }
}

function checkoutLock(householdId: string): string {
  return `checkout-lock:${householdId}`;
}

function isWriteConflict(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) return true;
  if (!(error instanceof TransactionCanceledException)) return false;
  const reasons = error.CancellationReasons;
  return Boolean(
    reasons?.some(
      (reason) =>
        reason.Code === 'ConditionalCheckFailed' ||
        reason.Code === 'TransactionConflict',
    ) &&
    reasons.every(
      (reason) =>
        reason.Code === 'None' ||
        reason.Code === 'ConditionalCheckFailed' ||
        reason.Code === 'TransactionConflict',
    ),
  );
}
