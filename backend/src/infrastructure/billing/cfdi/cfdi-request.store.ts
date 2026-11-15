import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { UserAccountStatus } from '../../../domain/enums';
import { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import type { CfdiFiscalData } from './cfdi-request';

type DeliveryStatus = 'sending' | 'pending' | 'sent' | 'delivery_unknown';
type FinishedDeliveryStatus = Exclude<DeliveryStatus, 'sending'>;

export interface CfdiRequestReceipt {
  id: string;
  status: FinishedDeliveryStatus;
  retryable?: true;
}

export interface StoredCfdiRequest {
  id: string;
  householdId: string;
  status: DeliveryStatus;
  attempt: string;
  attemptedAt: number;
  messageId?: string;
}

const activeAttemptMs = 60_000;
const fiscalDataRetentionSeconds = 7 * 24 * 60 * 60;

export function cfdiReceipt(request: StoredCfdiRequest): CfdiRequestReceipt {
  if (request.status === 'sending') {
    return {
      id: request.id,
      status:
        Date.now() - request.attemptedAt < activeAttemptMs
          ? 'pending'
          : 'delivery_unknown',
    };
  }
  return {
    id: request.id,
    status: request.status,
    ...(request.status === 'pending' && { retryable: true }),
  };
}

@Injectable()
export class CfdiRequestStore {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly dynamodb?: DynamoDbDocumentClientService,
  ) {}

  async read(table: string, invoiceId: string, householdId: string) {
    const result = await this.db.send(
      new GetCommand({
        TableName: table,
        Key: { pk: receiptKey(invoiceId) },
        ConsistentRead: true,
      }),
    );
    const request = result.Item as StoredCfdiRequest | undefined;
    if (request && request.householdId !== householdId) {
      throw new ServiceUnavailableException(
        'La solicitud de factura no está disponible.',
      );
    }
    return request;
  }

  async reserve(input: {
    table: string;
    userId: string;
    householdId: string;
    customerId: string;
    invoiceId: string;
    previous?: StoredCfdiRequest;
    data: CfdiFiscalData;
  }): Promise<StoredCfdiRequest | undefined> {
    const {
      table,
      userId,
      householdId,
      customerId,
      invoiceId,
      previous,
      data,
    } = input;
    const usersTable = this.config.get<string>('DYNAMODB_USERS_TABLE');
    if (!usersTable) {
      throw new ServiceUnavailableException(
        'La solicitud de factura no está disponible.',
      );
    }
    const now = new Date();
    const next: StoredCfdiRequest = {
      id: previous?.id ?? randomUUID(),
      householdId,
      status: 'sending',
      attempt: randomUUID(),
      attemptedAt: now.getTime(),
    };
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: usersTable,
                Key: { pk: `USER#${userId}` },
                ConditionExpression:
                  'entityType = :user AND #status = :active AND ' +
                  '(attribute_not_exists(deletionFenceExpiresAt) OR deletionFenceExpiresAt <= :now)',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':user': 'USER',
                  ':active': UserAccountStatus.ACTIVE,
                  ':now': now.toISOString(),
                },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: { pk: `household:${householdId}` },
                ConditionExpression:
                  'customerId = :customerId AND (attribute_not_exists(closed) OR closed = :open)',
                ExpressionAttributeValues: {
                  ':customerId': customerId,
                  ':open': false,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: { ...next, pk: receiptKey(invoiceId) },
                ...(previous
                  ? {
                      ConditionExpression:
                        'householdId = :household AND #status = :retryable AND attempt = :previous',
                      ExpressionAttributeNames: { '#status': 'status' },
                      ExpressionAttributeValues: {
                        ':household': householdId,
                        ':retryable': 'pending',
                        ':previous': previous.attempt,
                      },
                    }
                  : { ConditionExpression: 'attribute_not_exists(pk)' }),
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  pk: fiscalKey(invoiceId),
                  requestId: next.id,
                  ...data,
                  expiresAt:
                    Math.floor(now.getTime() / 1000) +
                    fiscalDataRetentionSeconds,
                },
              },
            },
          ],
        }),
      );
      return next;
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const [account, billing, receipt] = error.CancellationReasons ?? [];
      if (account?.Code === 'ConditionalCheckFailed') {
        throw new UnauthorizedException(
          'La sesión de la cuenta ya no está activa.',
        );
      }
      if (billing?.Code === 'ConditionalCheckFailed') {
        throw new ConflictException('El historial de facturación cambió.');
      }
      if (receipt?.Code === 'ConditionalCheckFailed') return undefined;
      throw error;
    }
  }

  async finish(
    table: string,
    invoiceId: string,
    request: StoredCfdiRequest,
    result: { status: FinishedDeliveryStatus; messageId?: string },
  ) {
    const next = { ...request, ...result };
    const receipt = {
      TableName: table,
      Item: { ...next, pk: receiptKey(invoiceId) },
      ConditionExpression: '#status = :sending AND attempt = :attempt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sending': 'sending',
        ':attempt': request.attempt,
      },
    };
    if (result.status === 'sent') {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: receipt },
            { Delete: { TableName: table, Key: { pk: fiscalKey(invoiceId) } } },
          ],
        }),
      );
    } else {
      await this.db.send(new PutCommand(receipt));
    }
    return next;
  }

  private get db() {
    if (!this.dynamodb) {
      throw new ServiceUnavailableException(
        'La solicitud de factura no está disponible.',
      );
    }
    return this.dynamodb;
  }
}

function receiptKey(invoiceId: string): string {
  return `cfdi-request:${invoiceId}`;
}

function fiscalKey(invoiceId: string): string {
  return `cfdi-fiscal-data:${invoiceId}`;
}
