import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
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
import {
  noticeWindow,
  renewalNoticeDueDay,
  renewalNoticeKey,
} from './renewal-notice.policy';
import type { RenewalNoticeCandidate } from './renewal-notice.types';

const queue = 'DUE';
const finishedDay = 10_000_000;
const noticeRetentionSeconds = 90 * 86_400;
const claimSeconds = 120;
const duePageSize = 10;
const maxDuePages = 2;
export const renewalNoticeDueIndex = 'RenewalNoticeDueIndex';

type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export type RenewalNoticeRow = RenewalNoticeCandidate & {
  pk: string;
  nextDay: number;
  generation?: string;
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
  observed?: Record<string, unknown>,
  now = new Date(),
): Write | undefined {
  const pk = renewalNoticeKey(candidate);
  const nextDay = renewalNoticeDueDay(candidate);
  const generation = randomUUID();
  if (observed) {
    if (
      observed.householdId !== candidate.householdId ||
      observed.subscriptionId !== candidate.subscriptionId ||
      observed.renewalAt !== candidate.renewalAt ||
      (observed.generation !== undefined &&
        typeof observed.generation !== 'string')
    )
      return undefined;

    const condition = observeGeneration(observed.generation);
    if (observed.state === 'queued') {
      // Fence a worker that resolved an earlier cancellation but has not yet
      // committed its decision. Keep the existing retry day and claim state.
      return {
        Update: {
          TableName: table,
          Key: { pk },
          ConditionExpression: `#state = :queued AND ${condition.expression}`,
          UpdateExpression: 'SET #generation = :generation',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#generation': 'generation',
          },
          ExpressionAttributeValues: {
            ...condition.values,
            ':queued': 'queued',
            ':generation': generation,
          },
        },
      };
    }
    if (
      observed.state !== 'skipped' ||
      observed.result !== 'nonrenewing' ||
      'sendAttempted' in observed ||
      'claim' in observed ||
      'claimExpiresAt' in observed ||
      noticeWindow(candidate, now) === 'late'
    )
      return undefined;

    return {
      Update: {
        TableName: table,
        Key: { pk },
        ConditionExpression: `#state = :skipped AND #result = :nonrenewing AND attribute_not_exists(sendAttempted) AND attribute_not_exists(#claim) AND attribute_not_exists(claimExpiresAt) AND ${condition.expression}`,
        UpdateExpression:
          'SET #state = :queued, #nextDay = :nextDay, #generation = :generation, #amountMinor = :amountMinor, #currency = :currency REMOVE #result, completedAt',
        ExpressionAttributeNames: {
          '#state': 'state',
          '#result': 'result',
          '#claim': 'claim',
          '#nextDay': 'nextDay',
          '#generation': 'generation',
          '#amountMinor': 'amountMinor',
          '#currency': 'currency',
        },
        ExpressionAttributeValues: {
          ...condition.values,
          ':skipped': 'skipped',
          ':nonrenewing': 'nonrenewing',
          ':queued': 'queued',
          ':nextDay': nextDay,
          ':generation': generation,
          ':amountMinor': candidate.amountMinor,
          ':currency': candidate.currency,
        },
      },
    };
  }

  const defaults = {
    householdId: candidate.householdId,
    subscriptionId: candidate.subscriptionId,
    renewalAt: candidate.renewalAt,
    amountMinor: candidate.amountMinor,
    currency: candidate.currency,
    queue,
    nextDay,
    expiresAt: candidate.renewalAt + noticeRetentionSeconds,
    state: 'queued',
    generation,
  };
  const attributes = Object.entries(defaults);
  return {
    Update: {
      TableName: table,
      Key: { pk },
      ConditionExpression: 'attribute_not_exists(pk)',
      UpdateExpression: `SET ${attributes.map(([name]) => `#${name} = :${name}`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(
        attributes.map(([name]) => [`#${name}`, name]),
      ),
      ExpressionAttributeValues: Object.fromEntries(
        attributes.map(([name, value]) => [`:${name}`, value]),
      ),
    },
  };
}

function observeGeneration(generation?: string) {
  return generation === undefined
    ? { expression: 'attribute_not_exists(#generation)', values: {} }
    : {
        expression: '#generation = :observedGeneration',
        values: { ':observedGeneration': generation },
      };
}

function queuedCondition(job: Queued) {
  const condition = observeGeneration(job.generation);
  return {
    ConditionExpression: `#state = :queued AND nextDay = :observedDay AND ${condition.expression}`,
    ExpressionAttributeNames: {
      '#state': 'state',
      '#generation': 'generation',
    },
    ExpressionAttributeValues: {
      ...condition.values,
      ':queued': 'queued',
      ':observedDay': job.nextDay,
    },
  };
}

@Injectable()
export class RenewalNoticeStore {
  constructor(
    @Optional() private readonly db?: DynamoDbDocumentClientService,
  ) {}

  async prepareEnqueue(
    table: string,
    candidate: RenewalNoticeCandidate,
  ): Promise<Write | undefined> {
    const row = await this.readRow(table, renewalNoticeKey(candidate));
    return buildRenewalNoticeEnqueue(table, candidate, row);
  }

  async read(table: string, pk: string): Promise<RenewalNoticeRow | undefined> {
    const row = await this.readRow(table, pk);
    return row?.state === 'queued' || row?.state === 'sending'
      ? (row as RenewalNoticeRow)
      : undefined;
  }

  private async readRow(table: string, pk: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: table,
        Key: { pk },
        ConsistentRead: true,
      }),
    );
    return result.Item;
  }

  async due(
    table: string,
    today: number,
  ): Promise<{ jobs: RenewalNoticeRow[]; hasMoreDue: boolean }> {
    const jobs: RenewalNoticeRow[] = [];
    let cursor: QueryCommandInput['ExclusiveStartKey'];
    for (let page = 0; page < maxDuePages; page++) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: table,
          IndexName: renewalNoticeDueIndex,
          KeyConditionExpression: '#queue = :queue AND nextDay <= :today',
          ExpressionAttributeNames: { '#queue': 'queue' },
          ExpressionAttributeValues: { ':queue': queue, ':today': today },
          Limit: duePageSize,
          ExclusiveStartKey: cursor,
        }),
      );
      jobs.push(...((result.Items ?? []) as RenewalNoticeRow[]));
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    return { jobs, hasMoreDue: cursor !== undefined };
  }

  async claim(
    table: string,
    job: Queued,
    now: number,
  ): Promise<Sending | undefined> {
    const claim = randomUUID();
    const claimExpiresAt = now + claimSeconds;
    const expected = queuedCondition(job);
    const changed = await this.update({
      TableName: table,
      Key: { pk: job.pk },
      ...expected,
      UpdateExpression:
        'SET #state = :sending, #claim = :claim, claimExpiresAt = :claimExpiresAt, sendAttempted = :attempted',
      ExpressionAttributeNames: {
        ...expected.ExpressionAttributeNames,
        '#claim': 'claim',
      },
      ExpressionAttributeValues: {
        ...expected.ExpressionAttributeValues,
        ':sending': 'sending',
        ':attempted': true,
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
    const expected = queuedCondition(job);
    return this.update({
      TableName: table,
      Key: { pk: job.pk },
      ...expected,
      UpdateExpression: 'SET nextDay = :tomorrow',
      ExpressionAttributeValues: {
        ...expected.ExpressionAttributeValues,
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
    const expected =
      job.state === 'queued'
        ? queuedCondition(job)
        : {
            ConditionExpression:
              '#state = :sending AND #claim = :observedClaim',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':sending': 'sending',
              ':observedClaim': job.claim,
            },
          };
    return this.update({
      TableName: table,
      Key: { pk: job.pk },
      ...expected,
      UpdateExpression:
        'SET #state = :outcome, nextDay = :finished, completedAt = :now, #result = :result REMOVE #claim, claimExpiresAt',
      ExpressionAttributeNames: {
        ...expected.ExpressionAttributeNames,
        '#claim': 'claim',
        '#result': 'result',
      },
      ExpressionAttributeValues: {
        ...expected.ExpressionAttributeValues,
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
