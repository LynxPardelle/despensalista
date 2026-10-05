import { BadRequestException, ConflictException } from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../domain/entities/product-type.entity';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import {
  IdempotencyPayloadConflictError,
  PantryMutationPort,
} from '../ports/pantry-mutation.port';
import { ConsumeInventoryLotUseCase } from './consume-inventory-lot.use-case';

describe('ConsumeInventoryLotUseCase', () => {
  it('commits the lot change and waste event through one atomic port call', async () => {
    const lot = makeLot(2);
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockResolvedValue(null);
    mutationPort.consume.mockImplementation(async (input) => ({
      value: input.updatedLot?.toPrimitives() ?? null,
      replayed: false,
    }));
    const useCase = makeUseCase(lot, mutationPort);

    const result = await useCase.execute({
      lotId: 'lot-1',
      userId: 'user-1',
      quantity: 1,
      wasteReason: 'expired',
      wasteNote: 'Fecha vencida',
      idempotencyKey: 'd4973518-70a5-44b6-b497-51c4530950a4',
    });

    expect(result.replayed).toBe(false);
    expect(result.value?.quantity).toBe(1);
    expect(mutationPort.consume).toHaveBeenCalledTimes(1);
    const transaction = mutationPort.consume.mock.calls[0][0];
    expect(transaction.expectedLot.toPrimitives().quantity).toBe(2);
    expect(transaction.updatedLot?.toPrimitives().quantity).toBe(1);
    expect(transaction.wasteEvent?.toPrimitives()).toMatchObject({
      userId: 'user-1',
      productTypeId: 'type-1',
      inventoryLotId: 'lot-1',
      productName: 'Leche',
      quantity: 1,
      unit: QuantityUnit.PIECE,
      reason: 'expired',
      note: 'Fecha vencida',
      estimatedLoss: 25,
    });
    expect(transaction.receipt.expiresAt.getTime()).toBeGreaterThan(
      transaction.receipt.createdAt.getTime(),
    );
  });

  it('replays the exact stored response without reading or mutating the lot', async () => {
    const inventoryRepository = makeInventoryRepository(makeLot(2));
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockImplementation(async (lookup) => ({
      operationId: lookup.operationId,
      ownerUserId: 'user-1',
      operation: 'consume_inventory_lot',
      requestHash: lookup.requestHash,
      response: makeLot(1).toPrimitives(),
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-08T00:00:00.000Z'),
    }));
    const useCase = new ConsumeInventoryLotUseCase(
      inventoryRepository,
      makeProductTypeRepository(),
      mutationPort,
    );

    const result = await useCase.execute({
      lotId: 'lot-1',
      userId: 'user-1',
      quantity: 1,
      idempotencyKey: 'd4973518-70a5-44b6-b497-51c4530950a4',
    });

    expect(result.replayed).toBe(true);
    expect(result.value?.toPrimitives()).toEqual(makeLot(1).toPrimitives());
    expect(inventoryRepository.findById).not.toHaveBeenCalled();
    expect(mutationPort.consume).not.toHaveBeenCalled();
  });

  it('maps reuse of a key with another payload to HTTP 409', async () => {
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockRejectedValue(
      new IdempotencyPayloadConflictError(),
    );
    const useCase = makeUseCase(makeLot(2), mutationPort);

    await expect(
      useCase.execute({
        lotId: 'lot-1',
        userId: 'user-1',
        quantity: 1,
        idempotencyKey: 'd4973518-70a5-44b6-b497-51c4530950a4',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a missing or malformed Idempotency-Key before any read', async () => {
    const inventoryRepository = makeInventoryRepository(makeLot(2));
    const useCase = new ConsumeInventoryLotUseCase(
      inventoryRepository,
      makeProductTypeRepository(),
      makeMutationPort(),
    );

    await expect(
      useCase.execute({
        lotId: 'lot-1',
        userId: 'user-1',
        quantity: 1,
        idempotencyKey: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inventoryRepository.findById).not.toHaveBeenCalled();
  });

  it('returns a clean BadRequestException when consumption exceeds the lot quantity', async () => {
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockResolvedValue(null);
    const useCase = makeUseCase(makeLot(1), mutationPort);

    await expect(
      useCase.execute({
        lotId: 'lot-1',
        userId: 'user-1',
        quantity: 2,
        idempotencyKey: 'd4973518-70a5-44b6-b497-51c4530950a4',
      }),
    ).rejects.toThrow('Consume quantity exceeds lot quantity');
    expect(mutationPort.consume).not.toHaveBeenCalled();
  });
});

function makeUseCase(
  lot: InventoryLot,
  mutationPort: jest.Mocked<PantryMutationPort>,
): ConsumeInventoryLotUseCase {
  return new ConsumeInventoryLotUseCase(
    makeInventoryRepository(lot),
    makeProductTypeRepository(),
    mutationPort,
  );
}

function makeInventoryRepository(
  lot: InventoryLot,
): jest.Mocked<InventoryLotRepository> {
  return {
    findById: jest.fn().mockResolvedValue(lot),
  } as unknown as jest.Mocked<InventoryLotRepository>;
}

function makeProductTypeRepository(): jest.Mocked<ProductTypeRepository> {
  return {
    findById: jest.fn().mockResolvedValue(makeProductType()),
  } as unknown as jest.Mocked<ProductTypeRepository>;
}

function makeMutationPort(): jest.Mocked<PantryMutationPort> {
  return {
    findReceipt: jest.fn(),
    consume: jest.fn(),
    checkout: jest.fn(),
  } as unknown as jest.Mocked<PantryMutationPort>;
}

function makeLot(quantity: number): InventoryLot {
  return InventoryLot.fromPrimitives({
    id: 'lot-1',
    userId: 'user-1',
    productTypeId: 'type-1',
    quantity,
    unit: QuantityUnit.PIECE,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  });
}

function makeProductType(): ProductType {
  return ProductType.fromPrimitives({
    id: 'type-1',
    userId: 'user-1',
    baseName: 'Leche',
    category: ProductCategory.FOOD,
    defaultUnit: QuantityUnit.PIECE,
    shoppingMetadata: {
      estimatedUnitPrice: 25,
      householdStaple: false,
      buyOnlyOnPromo: false,
      replenishWhenLow: true,
    },
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  });
}
