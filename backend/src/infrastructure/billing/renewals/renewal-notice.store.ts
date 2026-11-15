import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';
import { renewalNoticeDueDay, renewalNoticeKey } from './renewal-notice.policy';
import type { RenewalNoticeCandidate } from './renewal-notice.types';

const queue = 'DUE';
const finishedDay = 10_000_000;
const noticeRetentionSeconds = 90 * 86_400;
const claimSeconds = 120;
export const renewalNoticeDueIndex = 'RenewalNoticeDueIndex';

type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export type RenewalNoticeRow = RenewalNoticeCandidate & {
  pk: string;
  nextDay: number;
} & (
    | { state: 'queued' }
    | { state: 'sending'; claim: string; claimExpiresAt: number }
  );

type Queued = Extract<RenewalNoticeRow, { state: 'queued' }>;
type Sending = Extract<RenewalNoticeRow, { state: 'sending' }>;

type Outcome =
  | { state: 'skipped' | 'late' | 'blocked' | 'unknown'; reason: string }
  | { state: 'accepted'; messageId: string };

export function buildRenewalNoticeEnqueue(
  table: string,
  candidate: RenewalNoticeCandidate,
): Write {
  const defaults = {
    householdId: candidate.householdId,
    subscriptionId: candidate.subscriptionId,
    renewalAt: candidate.renewalAt,
    amountMinor: candidate.amountMinor,
    currency: candidate.currency,
    queue,
    nextDay: renewalNoticeDueDay(candidate),
    expiresAt: candidate.renewalAt + noticeRetentionSeconds,
    state: 'queued',
  };
  // Preserve completed states, the claim and the retry date when Stripe
  // delivers another event for the same subscription and renewal.
  const attributes = Object.entries(defaults);
  return {
    Update: {
      TableName: table,
      Key: { pk: renewalNoticeKey(candidate) },
      UpdateExpression: `SET ${attributes.map(([name]) => `#${name} = if_not_exists(#${name}, :${name})`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(
        attributes.map(([name]) => [`#${name}`, name]),
      ),
      ExpressionAttributeValues: Object.fromEntries(
        attributes.map(([name, value]) => [`:${name}`, value]),
      ),
    },
  };
}

@Injectable()
export class RenewalNoticeStore {
  constructor(
    @Optional() private readonly db?: DynamoDbDocumentClientService,
  ) {}

  async read(table: string, pk: string): Promise<RenewalNoticeRow | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: table,
        Key: { pk },
        ConsistentRead: true,
      }),
    );
    const row = result.Item;
    return row?.state === 'queued' || row?.state === 'sending'
      ? (row as RenewalNoticeRow)
      : undefined;
  }

  async due(table: string, today: number): Promise<RenewalNoticeRow[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: table,
        IndexName: renewalNoticeDueIndex,
        KeyConditionExpression: '#queue = :queue AND nextDay <= :today',
        ExpressionAttributeNames: { '#queue': 'queue' },
        ExpressionAttributeValues: { ':queue': queue, ':today': today },
        Limit: 10,
      }),
    );
    return (result.Items ?? []) as RenewalNoticeRow[];
  }

  async claim(
    table: string,
    job: Queued,
    now: number,
  ): Promise<Sending | undefined> {
    const claim = randomUUID();
    const claimExpiresAt = now + claimSeconds;
    const changed = await this.update({
      TableName: table,
      Key: { pk: job.pk },
      ConditionExpression: '#state = :queued AND nextDay = :observedDay',
      UpdateExpression:
        'SET #state = :sending, #claim = :claim, claimExpiresAt = :claimExpiresAt',
      ExpressionAttributeNames: { '#state': 'state', '#claim': 'claim' },
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':sending': 'sending',
        ':observedDay': job.nextDay,
        ':claim': claim,
        ':claimExpiresAt': claimExpiresAt,
      },
    });
    if (changed) return { ...job, state: 'sending', claim, claimExpiresAt };
  }

  async reschedule(
    table: string,
    job: Queued,
    tomorrow: number,
  ): Promise<boolean> {
    return this.update({
      TableName: table,
      Key: { pk: job.pk },
      ConditionExpression: '#state = :queued AND nextDay = :observedDay',
      UpdateExpression: 'SET nextDay = :tomorrow',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':observedDay': job.nextDay,
        ':tomorrow': tomorrow,
      },
    });
  }

  async finish(
    table: string,
    job: RenewalNoticeRow,
    outcome: Outcome,
    now: number,
  ): Promise<boolean> {
    return this.update({
      TableName: table,
      Key: { pk: job.pk },
      ConditionExpression:
        job.state === 'queued'
          ? '#state = :expected AND nextDay = :observedDay'
          : '#state = :expected AND #claim = :observedClaim',
      UpdateExpression:
        'SET #state = :outcome, nextDay = :finished, completedAt = :now, #result = :result REMOVE #claim, claimExpiresAt',
      ExpressionAttributeNames: {
        '#state': 'state',
        '#claim': 'claim',
        '#result': 'result',
      },
      ExpressionAttributeValues: {
        ':expected': job.state,
        ...(job.state === 'queued'
          ? { ':observedDay': job.nextDay }
          : { ':observedClaim': job.claim }),
        ':outcome': outcome.state,
        ':finished': finishedDay,
        ':now': now,
        ':result':
          outcome.state === 'accepted' ? outcome.messageId : outcome.reason,
      },
    });
  }

  private async update(input: UpdateCommandInput): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand(input));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  private get client(): DynamoDbDocumentClientService {
    if (!this.db)
      throw new ServiceUnavailableException(
        'Renewal notice storage is unavailable',
      );
    return this.db;
  }
}
