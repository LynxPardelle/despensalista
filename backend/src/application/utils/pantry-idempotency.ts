import { createHash } from 'node:crypto';
import {
  PantryOperation,
  PantryOperationContext,
} from '../ports/pantry-mutation.port';

const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildPantryIdempotencyContext(input: {
  ownerUserId: string;
  operation: PantryOperation;
  idempotencyKey: string | undefined;
  request: unknown;
  now?: Date;
}): PantryOperationContext {
  const idempotencyKey = input.idempotencyKey?.trim();

  if (!idempotencyKey || !UUID_PATTERN.test(idempotencyKey)) {
    throw new Error('Idempotency-Key must be a UUID');
  }

  const createdAt = input.now ?? new Date();
  const operationId = `pantry_operation_${sha256(
    `${input.ownerUserId}\u0000${input.operation}\u0000${idempotencyKey.toLowerCase()}`,
  )}`;

  return {
    operationId,
    ownerUserId: input.ownerUserId,
    operation: input.operation,
    requestHash: stableRequestHash(input.request),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_RETENTION_MS),
  };
}

export function stableRequestHash(value: unknown): string {
  return sha256(JSON.stringify(toCanonicalValue(value)));
}

export function deterministicMutationEntityId(
  prefix: 'lot' | 'waste',
  operationId: string,
  index: number,
): string {
  return `${prefix}_${sha256(`${operationId}\u0000${index}`).slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toCanonicalValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toCanonicalValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, toCanonicalValue(item)]),
    );
  }

  return value;
}
