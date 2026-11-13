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
      await this.db.send(new PutCommand(this.recordWrite(next, table)));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
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
