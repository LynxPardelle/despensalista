import {
  buildPantryIdempotencyContext,
  deterministicMutationEntityId,
  stableRequestHash,
} from './pantry-idempotency';

describe('pantry idempotency', () => {
  it('produces the same hash regardless of object key insertion order', () => {
    expect(stableRequestHash({ quantity: 1, lotId: 'lot-1' })).toBe(
      stableRequestHash({ lotId: 'lot-1', quantity: 1 }),
    );
  });

  it('scopes the durable operation id by owner, operation and key for seven days', () => {
    const context = buildPantryIdempotencyContext({
      ownerUserId: 'user-1',
      operation: 'consume_inventory_lot',
      idempotencyKey: 'd4973518-70a5-44b6-b497-51c4530950a4',
      request: { lotId: 'lot-1', quantity: 1 },
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(context.operationId).toMatch(/^pantry_operation_[a-f0-9]{64}$/);
    expect(context.expiresAt).toEqual(new Date('2026-09-08T00:00:00.000Z'));
  });

  it('rejects keys that are not UUIDs', () => {
    expect(() =>
      buildPantryIdempotencyContext({
        ownerUserId: 'user-1',
        operation: 'close_shopping_purchase',
        idempotencyKey: 'retry-1',
        request: {},
      }),
    ).toThrow('Idempotency-Key must be a UUID');
  });

  it('derives stable distinct entity ids from operation id and item index', () => {
    expect(deterministicMutationEntityId('lot', 'operation-1', 0)).toBe(
      deterministicMutationEntityId('lot', 'operation-1', 0),
    );
    expect(deterministicMutationEntityId('lot', 'operation-1', 0)).not.toBe(
      deterministicMutationEntityId('lot', 'operation-1', 1),
    );
    expect(deterministicMutationEntityId('lot', 'operation-1', 0)).toMatch(
      /^lot_[a-f0-9]{32}$/,
    );
  });
});
