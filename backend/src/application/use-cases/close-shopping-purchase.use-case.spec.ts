import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductType } from '../../domain/entities/product-type.entity';
import { ProductCategory, QuantityUnit } from '../../domain/enums';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../domain/value-objects/product-type-id.vo';
import {
  IdempotencyPayloadConflictError,
  PantryMutationPort,
} from '../ports/pantry-mutation.port';
import { CloseShoppingPurchaseUseCase } from './close-shopping-purchase.use-case';

describe('CloseShoppingPurchaseUseCase', () => {
  it('commits every lot and the grouped metadata updates in one transaction', async () => {
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockResolvedValue(null);
    mutationPort.checkout.mockImplementation(async (input) => ({
      value: input.lots.map((lot) => lot.toPrimitives()),
      replayed: false,
    }));
    const repository = makeProductTypeRepository([makeProductType()]);
    const useCase = new CloseShoppingPurchaseUseCase(repository, mutationPort);

    const result = await useCase.execute({
      userId: 'user-1',
      idempotencyKey: '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
      items: [
        {
          productTypeId: 'type-1',
          quantity: 2,
          unit: QuantityUnit.KILOGRAM,
          paidUnitPrice: 35.5,
          shoppingLocation: 'Mercado',
        },
        {
          productTypeId: 'type-1',
          quantity: 1,
          unit: QuantityUnit.KILOGRAM,
          paidUnitPrice: 34,
          shoppingLocation: 'Central',
        },
      ],
    });

    expect(result.value).toHaveLength(2);
    expect(mutationPort.checkout).toHaveBeenCalledTimes(1);
    const transaction = mutationPort.checkout.mock.calls[0][0];
    expect(transaction.lots).toHaveLength(2);
    expect(transaction.productTypes).toHaveLength(1);
    expect(
      transaction.productTypes[0].updated.shoppingMetadata.estimatedUnitPrice,
    ).toBe(34);
    expect(
      transaction.productTypes[0].updated.shoppingMetadata.shoppingLocation,
    ).toBe('Central');
    expect(
      transaction.productTypes[0].updated.shoppingMetadata.priceHistory,
    ).toHaveLength(2);
    expect(repository.findById).toHaveBeenCalledTimes(1);
  });

  it('replays the stored lot array without loading product types', async () => {
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockImplementation(async (lookup) => ({
      operationId: lookup.operationId,
      ownerUserId: 'user-1',
      operation: 'close_shopping_purchase',
      requestHash: lookup.requestHash,
      response: [],
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-09-08T00:00:00.000Z'),
    }));
    const repository = makeProductTypeRepository([makeProductType()]);
    const useCase = new CloseShoppingPurchaseUseCase(repository, mutationPort);

    const result = await useCase.execute({
      userId: 'user-1',
      idempotencyKey: '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
      items: [
        { productTypeId: 'type-1', quantity: 1, unit: QuantityUnit.KILOGRAM },
      ],
    });

    expect(result).toEqual({ value: [], replayed: true });
    expect(repository.findById).not.toHaveBeenCalled();
    expect(mutationPort.checkout).not.toHaveBeenCalled();
  });

  it('rejects 50 items because 49 is the atomic transaction maximum', async () => {
    const useCase = new CloseShoppingPurchaseUseCase(
      makeProductTypeRepository([makeProductType()]),
      makeMutationPort(),
    );

    await expect(
      useCase.execute({
        userId: 'user-1',
        idempotencyKey: '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
        items: Array.from({ length: 50 }, () => ({
          productTypeId: 'type-1',
          quantity: 1,
          unit: QuantityUnit.KILOGRAM,
        })),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps key reuse with another payload to HTTP 409', async () => {
    const mutationPort = makeMutationPort();
    mutationPort.findReceipt.mockRejectedValue(
      new IdempotencyPayloadConflictError(),
    );
    const useCase = new CloseShoppingPurchaseUseCase(
      makeProductTypeRepository([makeProductType()]),
      mutationPort,
    );

    await expect(
      useCase.execute({
        userId: 'user-1',
        idempotencyKey: '2d5c2dd4-933b-4215-b4c1-53945ac34a9b',
        items: [
          { productTypeId: 'type-1', quantity: 1, unit: QuantityUnit.KILOGRAM },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

function makeMutationPort(): jest.Mocked<PantryMutationPort> {
  return {
    findReceipt: jest.fn(),
    consume: jest.fn(),
    checkout: jest.fn(),
  } as unknown as jest.Mocked<PantryMutationPort>;
}

function makeProductTypeRepository(
  productTypes: ProductType[],
): jest.Mocked<ProductTypeRepository> {
  return {
    findById: jest.fn(
      async (id: ProductTypeId) =>
        productTypes.find((item) => item.id.toString() === id.toString()) ??
        null,
    ),
  } as unknown as jest.Mocked<ProductTypeRepository>;
}

function makeProductType(): ProductType {
  return ProductType.fromPrimitives({
    id: 'type-1',
    userId: 'user-1',
    baseName: 'Arroz',
    category: ProductCategory.FOOD,
    defaultUnit: QuantityUnit.KILOGRAM,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  });
}
