import { Connection, createConnection, Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import {
  IdempotencyPayloadConflictError,
  PantryMutationConflictError,
  PantryQuotaExceededError,
} from '../../../application/ports/pantry-mutation.port';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';
import { Product } from '../../../domain/entities/product.entity';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { WasteEvent } from '../../../domain/entities/waste-event.entity';
import { ProductStatus } from '../../../domain/enums';
import { Period } from '../../../domain/enums/period.enum';
import { hashShoppingShareToken } from '../../../application/utils/shopping-share-token';
import { DeleteProductTypeUseCase } from '../../../application/use-cases/delete-product-type.use-case';
import {
  InventoryLotDocument,
  InventoryLotSchema,
} from './schemas/inventory-lot.schema';
import {
  ProductTypeDocument,
  ProductTypeSchema,
} from './schemas/product-type.schema';
import {
  WasteEventDocument,
  WasteEventSchema,
} from './schemas/waste-event.schema';
import { MongoPantryMutationAdapter } from './mongodb-pantry-mutation.adapter';
import { MongoInventoryLotRepository } from './mongodb-inventory-lot.repository';
import { MongoProductTypeRepository } from './mongodb-product-type.repository';

describe('MongoPantryMutationAdapter', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let lotModel: Model<InventoryLotDocument>;
  let typeModel: Model<ProductTypeDocument>;
  let wasteModel: Model<WasteEventDocument>;
  let adapter: MongoPantryMutationAdapter;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    connection = await createConnection(replSet.getUri()).asPromise();
    lotModel = connection.model(InventoryLotDocument.name, InventoryLotSchema);
    typeModel = connection.model(ProductTypeDocument.name, ProductTypeSchema);
    wasteModel = connection.model(WasteEventDocument.name, WasteEventSchema);
    adapter = new MongoPantryMutationAdapter(
      connection,
      lotModel,
      typeModel,
      wasteModel,
    );
    await adapter.onModuleInit();
  }, 60_000);

  afterEach(async () => {
    await connection?.db?.dropDatabase();
    if (adapter) await adapter.onModuleInit();
  });

  afterAll(async () => {
    await connection?.close();
    await replSet?.stop();
  });

  it('commits consumption once and returns the stored response on retry', async () => {
    const lot = makeLot(2);
    await lotModel.create(lot.toPrimitives());
    await adapter.createProductType(makeProductType());
    const mutation = {
      receipt: receipt('consume_inventory_lot'),
      expectedLot: InventoryLot.fromPrimitives(lot.toPrimitives()),
      updatedLot: lot,
    };
    lot.consume(1);

    const first = await adapter.consume(mutation);
    const replay = await adapter.consume(mutation);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ value: first.value, replayed: true });
    expect(await lotModel.countDocuments()).toBe(1);
    expect((await lotModel.findOne({ id: 'lot-1' }).lean())?.quantity).toBe(1);
  });

  it('rejects a retained receipt at expiry in lookup and transaction without changing inventory', async () => {
    const lot = makeLot(2);
    await lotModel.create(lot.toPrimitives());
    const stored = receipt('consume_inventory_lot');
    await connection.collection('pantry_operations').insertOne({
      _id: stored.operationId as never,
      ...stored,
      response: lot.toPrimitives(),
    });
    const expectedLot = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.consume(1);
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(stored.expiresAt.getTime());
    try {
      await expect(adapter.findReceipt(stored)).rejects.toThrow(
        'Idempotency-Key has expired',
      );
      await expect(
        adapter.consume({ receipt: stored, expectedLot, updatedLot: lot }),
      ).rejects.toThrow('Idempotency-Key has expired');
    } finally {
      clock.mockRestore();
    }
    expect((await lotModel.findOne({ id: 'lot-1' }).lean())?.quantity).toBe(2);
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(1);
  });

  it('rejects the same operation id with another request hash', async () => {
    await connection.collection('pantry_operations').insertOne({
      _id: receipt('consume_inventory_lot').operationId as never,
      ...receipt('consume_inventory_lot'),
      requestHash: 'another-hash',
      response: null,
    });

    await expect(
      adapter.findReceipt(receipt('consume_inventory_lot')),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it('rolls back checkout lots and metadata when the quota rejects the purchase', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    await connection
      .collection('pantry_quotas')
      .updateOne(
        { ownerUserId: 'user-1' },
        { $set: { activeInventoryLots: 1000 } },
      );
    const expected = ProductType.fromPrimitives(type.toPrimitives());
    type.updateShoppingMetadata({ estimatedUnitPrice: 50 });
    const lot = InventoryLot.create(
      UserId.fromString('user-1'),
      type.id,
      undefined,
      2,
      QuantityUnit.PIECE,
    );
    await expect(
      adapter.checkout({
        receipt: receipt('close_shopping_purchase'),
        lots: [lot],
        productTypes: [{ expected, updated: type, changed: true }],
      }),
    ).rejects.toBeInstanceOf(PantryQuotaExceededError);
    expect(await lotModel.countDocuments()).toBe(0);
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(0);
    expect(
      (await typeModel.findOne({ id: type.id.toString() }).lean())
        ?.shoppingMetadata?.estimatedUnitPrice,
    ).toBeUndefined();
  });

  it('commits checkout once with identical replay and rejects a colliding payload', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const lot = InventoryLot.create(
      UserId.fromString('user-1'),
      type.id,
      undefined,
      2,
      QuantityUnit.PIECE,
    );
    const mutation = {
      receipt: receipt('close_shopping_purchase'),
      lots: [lot],
      productTypes: [{ expected: type, updated: type, changed: false }],
    };
    const first = await adapter.checkout(mutation);
    expect(await adapter.checkout(mutation)).toEqual({
      value: first.value,
      replayed: true,
    });
    await expect(
      adapter.checkout({
        ...mutation,
        receipt: { ...mutation.receipt, requestHash: 'collision' },
      }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
    expect(await lotModel.countDocuments()).toBe(1);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({ activeInventoryLots: 1 });
  });

  it('rejects a checkout key whose receipt expired instead of leaking a duplicate-key error', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const lot = InventoryLot.create(
      UserId.fromString('user-1'),
      type.id,
      undefined,
      2,
      QuantityUnit.PIECE,
    );
    const mutation = {
      receipt: receipt('close_shopping_purchase'),
      lots: [lot],
      productTypes: [{ expected: type, updated: type, changed: false }],
    };

    await adapter.checkout(mutation);
    await connection.collection('pantry_operations').deleteMany({});

    await expect(adapter.checkout(mutation)).rejects.toThrow(
      'Idempotency-Key expired or is ambiguous',
    );
    expect(await lotModel.countDocuments()).toBe(1);
  });

  it('rejects a consume-with-waste key whose receipt expired without applying it twice', async () => {
    await adapter.createProductType(makeProductType());
    const lot = makeLot(2);
    await adapter.createInventoryLot(lot);
    const operationReceipt = receipt('consume_inventory_lot');
    const wasteEvent = WasteEvent.fromPrimitives({
      id: 'waste-fixed',
      userId: 'user-1',
      productTypeId: 'type-1',
      inventoryLotId: 'lot-1',
      productName: 'Leche',
      quantity: 1,
      unit: QuantityUnit.PIECE,
      reason: 'expired',
      occurredAt: new Date('2026-09-01T00:00:00.000Z'),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    const firstExpected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.consume(1);
    await adapter.consume({
      receipt: operationReceipt,
      expectedLot: firstExpected,
      updatedLot: lot,
      wasteEvent,
    });
    await connection.collection('pantry_operations').deleteMany({});
    const stored = await lotModel.findOne({ id: 'lot-1' }).lean();
    const secondExpected = InventoryLot.fromPrimitives(stored as never);

    await expect(
      adapter.consume({
        receipt: operationReceipt,
        expectedLot: secondExpected,
        updatedLot: null,
        wasteEvent,
      }),
    ).rejects.toThrow('Idempotency-Key expired or is ambiguous');
    expect((await lotModel.findOne({ id: 'lot-1' }).lean())?.quantity).toBe(1);
    expect(await wasteModel.countDocuments()).toBe(1);
  });

  it('rejects concurrent consumption instead of losing a quantity update', async () => {
    const lot = makeLot(3);
    await lotModel.create(lot.toPrimitives());
    await adapter.createProductType(makeProductType());
    const expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.consume(1);
    const commands = [0, 1].map((index) =>
      adapter.consume({
        receipt: {
          ...receipt('consume_inventory_lot'),
          operationId: `concurrent-${index}`,
        },
        expectedLot: expected,
        updatedLot: lot,
      }),
    );
    const results = await Promise.allSettled(commands);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect((await lotModel.findOne({ id: 'lot-1' }).lean())?.quantity).toBe(2);
  });

  it('keeps quotas correct across archive, restore, delete, and data deletion', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const lot = InventoryLot.create(
      UserId.fromString('user-1'),
      type.id,
      undefined,
      2,
      QuantityUnit.PIECE,
    );
    await adapter.createInventoryLot(lot);
    let expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive();
    await adapter.archiveInventoryLot(expected, lot);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeInventoryLots: 0,
      archivedInventoryLots: 1,
      archivedLotsByProductType: { 'type-1': 1 },
    });
    expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.restore();
    await adapter.restoreInventoryLot(expected, lot);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeInventoryLots: 1,
      archivedInventoryLots: 0,
      archivedLotsByProductType: { 'type-1': 0 },
    });
    await adapter.deleteInventoryLot(lot);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeInventoryLots: 0,
      archivedInventoryLots: 0,
    });
    const deletionToken = await adapter.beginPantryDeletion('user-1');
    await expect(adapter.createInventoryLot(lot)).rejects.toBeInstanceOf(
      PantryMutationConflictError,
    );
    await adapter.completePantryDeletion('user-1', deletionToken);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeProductTypes: 0,
      archivedProductTypes: 0,
      activeInventoryLots: 0,
      archivedInventoryLots: 0,
      lotsByProductType: {},
      archivedLotsByProductType: {},
    });
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(0);
  });

  it('moves product types between active and archived quotas on archive and restore', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    let expected = ProductType.fromPrimitives(type.toPrimitives());
    type.archive();

    await adapter.archiveProductType(expected, type);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({ activeProductTypes: 0, archivedProductTypes: 1 });

    expected = ProductType.fromPrimitives(type.toPrimitives());
    type.restore();
    await adapter.restoreProductType(expected, type);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({ activeProductTypes: 1, archivedProductTypes: 0 });
  });

  it('admits only one concurrent lot archive at the archived quota boundary', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const lots = [makeLot(1, 'lot-a'), makeLot(1, 'lot-b')];
    await adapter.createInventoryLot(lots[0]);
    await adapter.createInventoryLot(lots[1]);
    await connection
      .collection('pantry_quotas')
      .updateOne(
        { ownerUserId: 'user-1' },
        { $set: { archivedInventoryLots: 249 } },
      );
    const expected = lots.map((lot) =>
      InventoryLot.fromPrimitives(lot.toPrimitives()),
    );
    lots.forEach((lot) => lot.archive());

    const results = await Promise.allSettled([
      adapter.archiveInventoryLot(expected[0], lots[0]),
      adapter.archiveInventoryLot(expected[1], lots[1]),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await lotModel.countDocuments({ archivedAt: { $exists: true } }),
    ).toBe(1);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeInventoryLots: 1,
      archivedInventoryLots: 250,
    });
  });

  it('admits only one concurrent product type archive at the archived quota boundary', async () => {
    const types = [makeProductType('type-a'), makeProductType('type-b')];
    await adapter.createProductType(types[0]);
    await adapter.createProductType(types[1]);
    await connection
      .collection('pantry_quotas')
      .updateOne(
        { ownerUserId: 'user-1' },
        { $set: { archivedProductTypes: 249 } },
      );
    const expected = types.map((type) =>
      ProductType.fromPrimitives(type.toPrimitives()),
    );
    types.forEach((type) => type.archive());

    const results = await Promise.allSettled([
      adapter.archiveProductType(expected[0], types[0]),
      adapter.archiveProductType(expected[1], types[1]),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await typeModel.countDocuments({ archivedAt: { $exists: true } }),
    ).toBe(1);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeProductTypes: 1,
      archivedProductTypes: 250,
    });
  });

  it('decrements archived lot and product type quotas during permanent cascade deletion', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const lot = makeLot(1);
    await adapter.createInventoryLot(lot);
    const expectedLot = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive();
    await adapter.archiveInventoryLot(expectedLot, lot);
    const expectedType = ProductType.fromPrimitives(type.toPrimitives());
    type.archive();
    await adapter.archiveProductType(expectedType, type);

    await new DeleteProductTypeUseCase(
      new MongoProductTypeRepository(typeModel),
      new MongoInventoryLotRepository(lotModel),
      adapter,
    ).execute({
      productTypeId: type.id.toString(),
      userId: 'user-1',
      confirmationText: type.baseName,
    });

    expect(await lotModel.countDocuments()).toBe(0);
    expect(await typeModel.countDocuments()).toBe(0);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      activeProductTypes: 0,
      archivedProductTypes: 0,
      activeInventoryLots: 0,
      archivedInventoryLots: 0,
    });
  });

  it('serializes concurrent mutations behind an authoritative quota migration', async () => {
    const type = makeProductType();
    const activeLot = makeLot(1, 'active-lot');
    const archivedLot = makeLot(1, 'archived-lot');
    const newLot = makeLot(1, 'new-lot');
    archivedLot.archive();
    await typeModel.create({
      ...type.toPrimitives(),
      normalizedBaseName: type.baseName.trim().toLocaleLowerCase('es'),
      activeName: type.baseName.trim().toLocaleLowerCase('es'),
    });
    await lotModel.create([
      activeLot.toPrimitives(),
      archivedLot.toPrimitives(),
    ]);
    await connection.collection('pantry_quotas').insertOne({
      _id: 'user-1' as never,
      ownerUserId: 'user-1',
      activeProductTypes: 1,
      archivedProductTypes: 0,
      activeInventoryLots: 1,
      archivedInventoryLots: 99,
      savedShoppingLists: 0,
      lotsByProductType: { 'type-1': 1 },
      archivedLotsByProductType: { 'type-1': 99 },
      updatedAt: new Date(),
    });
    const expected = InventoryLot.fromPrimitives(activeLot.toPrimitives());
    activeLot.archive();

    await Promise.all([
      adapter.archiveInventoryLot(expected, activeLot),
      adapter.createInventoryLot(newLot),
    ]);

    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      quotaSchemaVersion: 2,
      mutationEpoch: 0,
      deleting: false,
      activeProductTypes: 1,
      archivedProductTypes: 0,
      activeInventoryLots: 1,
      archivedInventoryLots: 2,
      lotsByProductType: { 'type-1': 1 },
      archivedLotsByProductType: { 'type-1': 2 },
    });
  });

  it('rejects a writer that captured the quota epoch before deletion reset', async () => {
    await adapter.createProductType(makeProductType('seed'));
    const runtimeAdapter = adapter as unknown as {
      runAtomicMutation: (...args: unknown[]) => Promise<unknown>;
    };
    const runAtomicMutation = runtimeAdapter.runAtomicMutation.bind(
      adapter,
    ) as typeof runtimeAdapter.runAtomicMutation;
    let resumeWriter!: () => void;
    let writerReady!: () => void;
    const writerGate = new Promise<void>((resolve) => (resumeWriter = resolve));
    const ready = new Promise<void>((resolve) => (writerReady = resolve));
    runtimeAdapter.runAtomicMutation = async (...args: unknown[]) => {
      writerReady();
      await writerGate;
      return runAtomicMutation(...args);
    };

    const lateWrite = adapter.createProductType(makeProductType('late'));
    await ready;
    const deletionToken = await adapter.beginPantryDeletion('user-1');
    await typeModel.deleteMany({ userId: 'user-1' });
    await adapter.completePantryDeletion('user-1', deletionToken);
    resumeWriter();

    await expect(lateWrite).rejects.toThrow('Pantry');
    runtimeAdapter.runAtomicMutation = runAtomicMutation;
    expect(await typeModel.countDocuments({ userId: 'user-1' })).toBe(0);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({
      quotaSchemaVersion: 2,
      mutationEpoch: 1,
      deleting: false,
      activeProductTypes: 0,
    });
  });

  it('prevents another deletion from sweeping data written after the owner completes', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string; retainFence?: boolean },
      ) => Promise<string>;
      completePantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
        retainFence?: boolean,
      ) => Promise<void>;
    };
    await expect(
      runtimeAdapter.beginPantryDeletion('user-1', {
        deletionToken: 'owner-token',
      }),
    ).resolves.toBe('owner-token');
    await expect(
      runtimeAdapter.beginPantryDeletion('user-1', {
        deletionToken: 'other-token',
      }),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
    await typeModel.deleteMany({ userId: 'user-1' });
    await runtimeAdapter.completePantryDeletion('user-1', 'owner-token');

    const newType = makeProductType('after-reset');
    await adapter.createProductType(newType);
    await expect(
      runtimeAdapter.completePantryDeletion('user-1', 'other-token'),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
    expect(await typeModel.countDocuments({ userId: 'user-1' })).toBe(1);
  });

  it('retains an account deletion fence without a 24-hour TTL', async () => {
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string; retainFence?: boolean },
      ) => Promise<string>;
      completePantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
        retainFence?: boolean,
      ) => Promise<void>;
    };
    await runtimeAdapter.beginPantryDeletion('user-1', {
      deletionToken: 'account-delete-token',
      retainFence: true,
    });
    await runtimeAdapter.completePantryDeletion(
      'user-1',
      'account-delete-token',
      true,
    );
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toEqual({
      _id: 'user-1',
      ownerUserId: 'user-1',
      quotaSchemaVersion: 2,
      mutationEpoch: 1,
      deleting: true,
      deletionToken: 'account-delete-token',
      deletionStartedAt: expect.any(Date),
      retainFence: true,
    });
    await expect(
      adapter.createProductType(makeProductType('after-25-hours')),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(0);
  });

  it('fails completion when the owned fence changes during the final CAS', async () => {
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string },
      ) => Promise<string>;
      completePantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
      ) => Promise<void>;
    };
    await runtimeAdapter.beginPantryDeletion('user-1', {
      deletionToken: 'owner-token',
    });
    const quotas = connection.collection('pantry_quotas');
    jest.spyOn(quotas, 'replaceOne').mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    });

    await expect(
      runtimeAdapter.completePantryDeletion('user-1', 'owner-token'),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
  });

  it('takes over an abandoned normal reset after the Lambda safety margin', async () => {
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string },
      ) => Promise<string>;
    };
    await runtimeAdapter.beginPantryDeletion('user-1', {
      deletionToken: 'abandoned-token',
    });
    await connection
      .collection('pantry_quotas')
      .updateOne(
        { _id: 'user-1' as never },
        { $set: { deletionStartedAt: new Date(Date.now() - 61_000) } },
      );

    await expect(
      runtimeAdapter.beginPantryDeletion('user-1', {
        deletionToken: 'takeover-token',
      }),
    ).resolves.toBe('takeover-token');
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ _id: 'user-1' as never }),
    ).toMatchObject({
      deleting: true,
      deletionToken: 'takeover-token',
      mutationEpoch: 2,
      retainFence: false,
    });
  });

  it('promotes an abandoned normal reset to the durable account-deletion fence', async () => {
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string; retainFence?: boolean },
      ) => Promise<string>;
      completePantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
        retainFence?: boolean,
      ) => Promise<void>;
    };
    await runtimeAdapter.beginPantryDeletion('user-1', {
      deletionToken: 'abandoned-reset-token',
    });
    await connection
      .collection('pantry_quotas')
      .updateOne(
        { _id: 'user-1' as never },
        { $set: { deletionStartedAt: new Date(Date.now() - 61_000) } },
      );

    await expect(
      runtimeAdapter.beginPantryDeletion('user-1', {
        deletionToken: 'account-job-token',
        retainFence: true,
      }),
    ).resolves.toBe('account-job-token');
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ _id: 'user-1' as never }),
    ).toMatchObject({
      deleting: true,
      deletionToken: 'account-job-token',
      mutationEpoch: 2,
      retainFence: true,
    });

    await runtimeAdapter.completePantryDeletion(
      'user-1',
      'account-job-token',
      true,
    );
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ _id: 'user-1' as never }),
    ).toMatchObject({
      deleting: true,
      deletionToken: 'account-job-token',
      mutationEpoch: 2,
      retainFence: true,
    });
  });

  it('rebuilds quota before aborting a failed normal reset', async () => {
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string },
      ) => Promise<string>;
      abortPantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
      ) => Promise<void>;
    };
    const type = makeProductType('remaining');
    await adapter.createProductType(type);
    await runtimeAdapter.beginPantryDeletion('user-1', {
      deletionToken: 'owner-token',
    });

    await runtimeAdapter.abortPantryDeletion('user-1', 'owner-token');

    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ _id: 'user-1' as never }),
    ).toMatchObject({
      deleting: false,
      mutationEpoch: 1,
      activeProductTypes: 1,
    });
    await expect(
      adapter.createProductType(makeProductType('after-abort')),
    ).resolves.toBeDefined();
  });

  it('keeps a completed reset receipt while later pantry data is written', async () => {
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string },
      ) => Promise<string>;
      completePantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
        retainFence: boolean,
        receipt: ReturnType<typeof deleteReceipt>,
      ) => Promise<void>;
    };
    const original = makeProductType('before-reset');
    await adapter.createProductType(original);
    const receipt = deleteReceipt();
    await runtimeAdapter.beginPantryDeletion('user-1', {
      deletionToken: receipt.operationId,
    });
    await typeModel.deleteMany({ userId: 'user-1' });
    await runtimeAdapter.completePantryDeletion(
      'user-1',
      receipt.operationId,
      false,
      receipt,
    );
    const later = makeProductType('after-reset');
    await adapter.createProductType(later);

    await expect(adapter.findReceipt(receipt)).resolves.toMatchObject({
      response: receipt.response,
    });
    expect(await typeModel.countDocuments({ id: later.id.toString() })).toBe(1);
  });

  it('enforces active product-name uniqueness concurrently', async () => {
    const results = await Promise.allSettled([
      adapter.createProductType(makeProductType()),
      adapter.createProductType(makeProductType()),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await typeModel.countDocuments()).toBe(1);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({ activeProductTypes: 1 });
  });

  it('writes and counts saved lists in the canonical shoppingLists collection', async () => {
    const list = ShoppingList.create({
      ownerUserId: 'user-1',
      title: 'Semanal',
      items: [
        {
          productTypeId: 'type-1',
          baseName: 'Leche',
          quantity: 1,
          unit: QuantityUnit.PIECE,
        },
      ],
    });

    await adapter.createShoppingList(list);
    expect(
      await connection.collection('shoppingLists').findOne({ id: list.id }),
    ).toMatchObject({ ownerUserId: 'user-1' });
    expect(await connection.collection('shopping_lists').countDocuments()).toBe(
      0,
    );

    await adapter.deleteShoppingList(list);
    expect(await connection.collection('shoppingLists').countDocuments()).toBe(
      0,
    );
  });

  it('rejects delayed legacy product and public-share writes after a deletion fence', async () => {
    const product = makeProduct();
    const share = makeShare();
    await adapter.createProduct(product);
    await adapter.createShoppingShare(share);
    const expectedProduct = Product.fromPrimitives(product.toPrimitives());
    const expectedShare = ShoppingShare.fromPrimitives(share.toPrimitives());
    product.updateQuantity(1);
    share.revoke('user-1');

    await adapter.beginPantryDeletion('user-1', { retainFence: true });
    await connection.collection('products').deleteMany({ userId: 'user-1' });
    await connection
      .collection('shoppingShares')
      .deleteMany({ ownerUserId: 'user-1' });

    await expect(
      adapter.updateProduct(expectedProduct, product),
    ).rejects.toThrow('deleted');
    await expect(
      adapter.updateShoppingShare(expectedShare, share),
    ).rejects.toThrow('deleted');
    expect(await connection.collection('products').countDocuments()).toBe(0);
    expect(await connection.collection('shoppingShares').countDocuments()).toBe(
      0,
    );
  });

  it('keeps a product-type tombstone while cleanup blocks a stale lot archive', async () => {
    const type = makeProductType();
    await adapter.createProductType(type);
    const lot = InventoryLot.create(
      UserId.fromString('user-1'),
      type.id,
      undefined,
      2,
      QuantityUnit.PIECE,
    );
    await adapter.createInventoryLot(lot);
    const expectedType = ProductType.fromPrimitives(type.toPrimitives());
    type.archive();
    await adapter.archiveProductType(expectedType, type);
    await typeModel.collection.updateOne(
      { id: type.id.toString() },
      { $set: { retentionExpiresAt: new Date('2026-10-01T00:00:00.000Z') } },
    );
    await adapter.beginProductTypeDeletion(type);

    const expectedLot = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive();
    await expect(adapter.archiveInventoryLot(expectedLot, lot)).rejects.toThrow(
      'being deleted',
    );
    const deletingType = await typeModel.collection.findOne({
      id: type.id.toString(),
    });
    expect(deletingType).toEqual(expect.objectContaining({ deleting: true }));
    expect(deletingType).not.toHaveProperty('retentionExpiresAt');
    expect(
      await lotModel.collection.findOne({ id: lot.id.toString() }),
    ).not.toHaveProperty('archivedAt');

    await adapter.deleteInventoryLot(expectedLot);
    await adapter.deleteProductType(type);
    expect(
      await typeModel.collection.findOne({ id: type.id.toString() }),
    ).toBeNull();
  });
});

function receipt(
  operation: 'consume_inventory_lot' | 'close_shopping_purchase',
) {
  return {
    operationId:
      'pantry_operation_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ownerUserId: 'user-1',
    operation,
    requestHash: 'request-hash',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 86400_000),
  };
}

function deleteReceipt() {
  const createdAt = new Date();
  return {
    operationId: 'reset-operation',
    ownerUserId: 'user-1',
    operation: 'delete_pantry_data' as const,
    requestHash: 'delete-request-hash',
    response: {
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 4,
    },
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 7 * 86400_000),
  };
}

function makeLot(
  quantity: number,
  id = 'lot-1',
  productTypeId = 'type-1',
): InventoryLot {
  return InventoryLot.fromPrimitives({
    id,
    userId: 'user-1',
    productTypeId,
    quantity,
    unit: QuantityUnit.PIECE,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function makeProductType(id = 'type-1'): ProductType {
  return ProductType.fromPrimitives({
    id,
    userId: 'user-1',
    baseName: `Leche ${id}`,
    category: ProductCategory.FOOD,
    defaultUnit: QuantityUnit.PIECE,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function makeProduct(): Product {
  return Product.fromPrimitives({
    id: 'product-1',
    userId: 'user-1',
    title: 'Arroz',
    currentQuantity: 2,
    unit: QuantityUnit.KILOGRAM,
    usageRate: { amount: 1, period: Period.WEEK },
    category: ProductCategory.FOOD,
    status: ProductStatus.AVAILABLE,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function makeShare(): ShoppingShare {
  return ShoppingShare.fromPrimitives({
    id: 'share-1',
    ownerUserId: 'user-1',
    tokenHash: hashShoppingShareToken('opaque-token-1234'),
    text: 'Lista pública',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2026-09-08T00:00:00.000Z'),
  });
}
