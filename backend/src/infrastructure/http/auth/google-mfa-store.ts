import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { DynamoDbDocumentClientService } from '../../database/dynamodb/dynamodb-document-client.service';

const RECOVERY_WINDOW_SECONDS = 900;
const RECOVERY_MAX_ATTEMPTS = 5;

interface StoredCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
}

export interface CredentialAccount {
  credentials: StoredCredential[];
  generation: string;
  revision?: string;
  recoveryCodeHash?: string;
}

export interface PendingWebAuthnChallenge {
  challenge: string;
  expiresAt: number;
  generation: string;
  recoveryCodeHash?: string;
}

export class GoogleMfaStore {
  constructor(
    private readonly db: DynamoDbDocumentClientService,
    private readonly tableName: string,
  ) {}

  async getAccount(subject: string): Promise<CredentialAccount | undefined> {
    const item = await this.get(credentialKey(subject));
    if (!item || typeof item.expiresAt === 'number') return undefined;

    if (typeof item.revision === 'string') {
      const recoveryCodeHash: unknown = item.recoveryCodeHash;
      if (
        typeof item.generation !== 'string' ||
        !Array.isArray(item.credentials) ||
        item.credentials.length < 1 ||
        item.credentials.length > 2 ||
        !item.credentials.every(isStoredCredential) ||
        (recoveryCodeHash !== undefined && typeof recoveryCodeHash !== 'string')
      ) {
        throw new Error('Invalid WebAuthn account');
      }
      return {
        credentials: item.credentials,
        generation: item.generation,
        revision: item.revision,
        recoveryCodeHash,
      };
    }

    if (!isStoredCredential(item)) throw new Error('Invalid WebAuthn account');
    return {
      credentials: [item],
      generation: 'legacy',
    };
  }

  async writeAccount(
    subject: string,
    previous: CredentialAccount | undefined,
    next: Omit<CredentialAccount, 'revision'>,
  ): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          ...this.accountCondition(previous),
          Item: {
            pk: credentialKey(subject),
            revision: randomUUID(),
            generation: next.generation,
            credentials: next.credentials.map(
              ({ credentialId, publicKey, counter }) => ({
                credentialId,
                publicKey,
                counter,
              }),
            ),
            ...(next.recoveryCodeHash
              ? { recoveryCodeHash: next.recoveryCodeHash }
              : {}),
          },
        }),
      );
      return true;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      return false;
    }
  }

  async tombstoneAccount(subject: string, expiresAt: number): Promise<void> {
    await this.put(credentialKey(subject), { expiresAt });
  }

  async consumeChallenge(
    pk: string,
    now: number,
  ): Promise<PendingWebAuthnChallenge | undefined> {
    try {
      const { Attributes } = await this.db.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk },
          ConditionExpression: 'expiresAt > :now',
          ExpressionAttributeValues: { ':now': now },
          ReturnValues: 'ALL_OLD',
        }),
      );
      if (
        typeof Attributes?.challenge === 'string' &&
        typeof Attributes.expiresAt === 'number' &&
        typeof Attributes.generation === 'string'
      ) {
        return {
          challenge: Attributes.challenge,
          expiresAt: Attributes.expiresAt,
          generation: Attributes.generation,
          recoveryCodeHash:
            typeof Attributes.recoveryCodeHash === 'string'
              ? Attributes.recoveryCodeHash
              : undefined,
        };
      }
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
    return undefined;
  }

  async countRecoveryAttempt(subject: string, now: number): Promise<boolean> {
    const window = Math.floor(now / RECOVERY_WINDOW_SECONDS);
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `recovery-rate:${digest(subject)}:${window}` },
          UpdateExpression: 'SET expiresAt = :expiry ADD attempts :one',
          ConditionExpression:
            'attribute_not_exists(attempts) OR attempts < :max',
          ExpressionAttributeValues: {
            ':expiry': (window + 1) * RECOVERY_WINDOW_SECONDS,
            ':one': 1,
            ':max': RECOVERY_MAX_ATTEMPTS,
          },
        }),
      );
      return true;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      return false;
    }
  }

  async get(pk: string) {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk },
        ConsistentRead: true,
      }),
    );
    return Item;
  }

  async put(pk: string, fields: Record<string, unknown>): Promise<void> {
    await this.db.send(
      new PutCommand({ TableName: this.tableName, Item: { pk, ...fields } }),
    );
  }

  async delete(pk: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: this.tableName, Key: { pk } }),
    );
  }

  private accountCondition(previous: CredentialAccount | undefined) {
    if (!previous) return { ConditionExpression: 'attribute_not_exists(pk)' };
    if (previous.revision) {
      return {
        ConditionExpression: 'revision = :revision',
        ExpressionAttributeValues: { ':revision': previous.revision },
      };
    }

    const [credential] = previous.credentials;
    return {
      ConditionExpression:
        'attribute_not_exists(revision) AND credentialId = :id AND #counter = :counter',
      ExpressionAttributeNames: { '#counter': 'counter' },
      ExpressionAttributeValues: {
        ':id': credential.credentialId,
        ':counter': credential.counter,
      },
    };
  }
}

export function fromWebAuthnCredential(
  credential: WebAuthnCredential,
): StoredCredential {
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
  };
}

export function toWebAuthnCredential(
  credential: StoredCredential,
): WebAuthnCredential {
  return {
    id: credential.credentialId,
    publicKey: Buffer.from(credential.publicKey, 'base64url'),
    counter: credential.counter,
  };
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function credentialKey(subject: string): string {
  return `credential:${digest(subject)}`;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredCredential>;
  return (
    typeof item.credentialId === 'string' &&
    typeof item.publicKey === 'string' &&
    typeof item.counter === 'number'
  );
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'ConditionalCheckFailedException'
  );
}
