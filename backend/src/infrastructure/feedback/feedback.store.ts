import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  NativeAttributeValue,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AccountFeedbackEraser } from '../../application/ports/account-feedback-eraser.port';
import { UserAccountStatus } from '../../domain/enums';
import { DynamoDbDocumentClientService } from '../database/dynamodb/dynamodb-document-client.service';
import type { FeedbackCategory } from '../http/dtos/create-feedback.dto';

interface FeedbackSubmission {
  submissionId: string;
  category: FeedbackCategory;
  message: string;
}

const secondsPerDay = 86_400;
const reportsPerDay = 5;
const reportRetentionDays = 90;

@Injectable()
export class FeedbackStore implements AccountFeedbackEraser {
  private readonly storage?: {
    dynamo: DynamoDbDocumentClientService;
    table: string;
    usersTable: string;
  };

  constructor(
    config: ConfigService,
    @Optional() dynamo?: DynamoDbDocumentClientService,
  ) {
    const table = config.get<string>('FEEDBACK_TABLE');
    const usersTable = config.get<string>('DYNAMODB_USERS_TABLE');
    if (table && usersTable && dynamo) {
      this.storage = { dynamo, table, usersTable };
    }
  }

  get available(): boolean {
    return this.storage !== undefined;
  }

  async submit(
    userId: string,
    submission: FeedbackSubmission,
    now = new Date(),
  ) {
    if (!this.storage) throw new NotFoundException('Feedback is unavailable');

    const { dynamo, table, usersTable } = this.storage;
    const id = submission.submissionId.toLowerCase();
    const { category, message } = submission;
    const createdAt = now.toISOString();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const day = createdAt.slice(0, 10);
    const pk = accountPartition(userId);
    const key = { pk, sk: `REPORT#${id}` };

    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // A request authenticated before account deletion began may still
              // be in flight. Check the account alongside the report write.
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
                  ':now': createdAt,
                },
              },
            },
            {
              Update: {
                TableName: table,
                Key: { pk, sk: `LIMIT#${day}` },
                ConditionExpression:
                  'attribute_not_exists(#count) OR #count < :max',
                UpdateExpression: 'SET expiresAt = :expiry ADD #count :one',
                ExpressionAttributeNames: { '#count': 'count' },
                ExpressionAttributeValues: {
                  ':max': reportsPerDay,
                  ':one': 1,
                  ':expiry': nowSeconds + 2 * secondsPerDay,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...key,
                  id,
                  category,
                  message,
                  createdAt,
                  inboxMonth: `INBOX#${day.slice(0, 7)}`,
                  inboxOrder: `${createdAt}#${id}`,
                  expiresAt: nowSeconds + reportRetentionDays * secondsPerDay,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;

      const [account, limit, report] = error.CancellationReasons ?? [];
      if (account?.Code === 'ConditionalCheckFailed') {
        throw new UnauthorizedException('Invalid authenticated user');
      }
      const reportExists = report?.Code === 'ConditionalCheckFailed';
      const limitReached = limit?.Code === 'ConditionalCheckFailed';
      if (reportExists || limitReached) {
        const { Item: existing } = await dynamo.send(
          new GetCommand({
            TableName: table,
            Key: key,
            ConsistentRead: true,
          }),
        );
        if (existing?.category === category && existing.message === message) {
          return { id };
        }
        if (reportExists || existing) {
          throw new ConflictException('Feedback submission ID already used');
        }
      }
      if (limitReached) {
        throw new HttpException(
          'Feedback daily limit reached',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw error;
    }

    return { id };
  }

  async deleteForAccount(userId: string): Promise<void> {
    if (!this.storage) return;

    const { dynamo, table } = this.storage;
    const pk = accountPartition(userId);
    let cursor: Record<string, NativeAttributeValue> | undefined;
    do {
      const page = await dynamo.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :account',
          ExpressionAttributeValues: { ':account': pk },
          ProjectionExpression: 'sk',
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
          Limit: 25,
        }),
      );
      const keys = (page.Items ?? []) as { sk: string }[];
      await Promise.all(
        keys.map(({ sk }) =>
          dynamo.send(new DeleteCommand({ TableName: table, Key: { pk, sk } })),
        ),
      );
      cursor = page.LastEvaluatedKey;
    } while (cursor);
  }
}

function accountPartition(userId: string): string {
  return `ACCOUNT#${createHash('sha256').update(userId).digest('hex')}`;
}
