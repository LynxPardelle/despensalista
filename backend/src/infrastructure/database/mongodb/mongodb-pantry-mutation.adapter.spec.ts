import { Connection, createConnection, Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import {
  IdempotencyPayloadConflictError,
  PantryQuotaExceededError,
} from '../../../application/ports/pantry-mutation.port';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';
import { Product } from '../../../domain/entities/product.entity';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { ProductStatus } from '../../../domain/enums';
import { Period } from '../../../domain/enums/period.enum';
import { hashShoppingShareToken } from '../../../application/utils/shopping-share-token';
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
    ).toMatchObject({ activeInventoryLots: 0 });
    expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.restore();
    await adapter.restoreInventoryLot(expected, lot);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({ activeInventoryLots: 1 });
    await adapter.deleteInventoryLot(lot);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toMatchObject({ activeInventoryLots: 0 });
    await adapter.beginPantryDeletion('user-1');
    await expect(adapter.createInventoryLot(lot)).rejects.toBeInstanceOf(
      PantryQuotaExceededError,
    );
    await adapter.completePantryDeletion('user-1');
    expect(await connection.collection('pantry_quotas').countDocuments()).toBe(
      0,
    );
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(0);
  });

  it('retains only a 24-hour account deletion lock and prevents late writes or reset unlocking', async () => {
    const until = new Date(Date.now() + 86400_000);
    const type = makeProductType();
    await adapter.createProductType(type);
    await adapter.beginPantryDeletion('user-1', until);
    await typeModel.deleteMany({ userId: 'user-1' });
    await adapter.completePantryDeletion('user-1');
    await expect(adapter.createProductType(type)).rejects.toThrow();
    await adapter.completePantryDeletion('user-1', until);
    expect(
      await connection
        .collection('pantry_quotas')
        .findOne({ ownerUserId: 'user-1' }),
    ).toEqual({
      _id: 'user-1',
      ownerUserId: 'user-1',
      deleting: true,
      expiresAt: until,
    });
    await adapter.completePantryDeletion('user-1');
    await expect(adapter.createProductType(type)).rejects.toThrow();
    expect(await typeModel.countDocuments()).toBe(0);
    const indexes = await connection.collection('pantry_quotas').indexes();
    expect(
      indexes.find((index) => index.name === 'pantry_deletion_lock_ttl'),
    ).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
    expect(
      await connection.collection('pantry_operations').countDocuments(),
    ).toBe(0);
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

    await adapter.beginPantryDeletion(
      'user-1',
      new Date(Date.now() + 86_400_000),
    );
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

function makeLot(quantity: number): InventoryLot {
  return InventoryLot.fromPrimitives({
    id: 'lot-1',
    userId: 'user-1',
    productTypeId: 'type-1',
    quantity,
    unit: QuantityUnit.PIECE,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function makeProductType(): ProductType {
  return ProductType.fromPrimitives({
    id: 'type-1',
    userId: 'user-1',
    baseName: 'Leche',
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
