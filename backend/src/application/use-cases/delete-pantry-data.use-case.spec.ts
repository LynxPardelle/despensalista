import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { BadRequestException } from '@nestjs/common';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductRepository } from '../../domain/repositories/product.repository';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ShoppingListRepository } from '../../domain/repositories/shopping-list.repository';
import { ShoppingShareRepository } from '../../domain/repositories/shopping-share.repository';
import { WasteEventRepository } from '../../domain/repositories/waste-event.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  PantryDeletionReceipt,
  PantryMutationConflictError,
} from '../ports/pantry-mutation.port';
import { DeletePantryDataUseCase } from './delete-pantry-data.use-case';

describe('DeletePantryDataUseCase', () => {
  const idempotencyKey = '9b29fb9a-ce30-473f-abaf-f8d987634f55';

  it('replays a completed reset without sweeping data created after its response was lost', async () => {
    const {
      useCase,
      pantryMutationPort,
      productTypeRepository,
      inventoryLotRepository,
    } = makeUseCase({
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 3,
      deletedInventoryLotCount: 4,
      deletedProductTypeCount: 5,
    });
    let storedReceipt: PantryDeletionReceipt | undefined;
    pantryMutationPort.findReceipt.mockImplementation(async () =>
      storedReceipt
        ? {
            ...storedReceipt,
            response: storedReceipt.response,
          }
        : null,
    );
    pantryMutationPort.beginPantryDeletion.mockImplementation(
      async (_ownerUserId, request) => request!.deletionToken!,
    );
    pantryMutationPort.completePantryDeletion.mockImplementation(
      async (_ownerUserId, _deletionToken, _retainFence, receipt) => {
        storedReceipt = receipt;
      },
    );

    const command = {
      userId: 'user-1',
      confirmationText: 'ELIMINAR',
      idempotencyKey,
    };
    const first = await useCase.execute(command);
    // Represents data written after the first reset committed but before its response reached the client.
    productTypeRepository.deleteByUserId.mockClear();
    inventoryLotRepository.deleteByUserId.mockClear();
    const replay = await useCase.execute(command);

    expect(replay).toEqual(first);
    expect(productTypeRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(inventoryLotRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(pantryMutationPort.beginPantryDeletion).toHaveBeenCalledTimes(1);
    expect(storedReceipt).toMatchObject({
      operation: 'delete_pantry_data',
      response: first,
    });
  });

  it('keeps an account-deletion tombstone without TTL and releases a normal reset', async () => {
    const { useCase, pantryMutationPort } = makeUseCase();
    pantryMutationPort.beginPantryDeletion
      .mockResolvedValueOnce('account-delete-token')
      .mockImplementationOnce(async (_ownerUserId, request) =>
        Promise.resolve(request!.deletionToken!),
      );

    await useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR',
      accountDeletion: true,
      deletionToken: 'account-delete-token',
    });
    expect(pantryMutationPort.beginPantryDeletion).toHaveBeenNthCalledWith(
      1,
      'user-1',
      { deletionToken: 'account-delete-token', retainFence: true },
    );
    expect(pantryMutationPort.completePantryDeletion).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'account-delete-token',
      true,
    );

    await useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR',
      idempotencyKey,
    });
    expect(pantryMutationPort.beginPantryDeletion).toHaveBeenNthCalledWith(
      2,
      'user-1',
      { deletionToken: expect.stringMatching(/^pantry_operation_/) },
    );
    expect(pantryMutationPort.completePantryDeletion).toHaveBeenNthCalledWith(
      2,
      'user-1',
      expect.stringMatching(/^pantry_operation_/),
      false,
      expect.objectContaining({ operation: 'delete_pantry_data' }),
    );
  });

  it('never starts a second sweep while another deletion owns the fence', async () => {
    const { useCase, pantryMutationPort, shoppingListRepository } =
      makeUseCase();
    let releaseFirstSweep!: () => void;
    let firstSweepStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirstSweep = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstSweepStarted = resolve;
    });
    pantryMutationPort.beginPantryDeletion
      .mockResolvedValueOnce('winner-token')
      .mockRejectedValueOnce(
        new PantryMutationConflictError('Pantry is already being deleted'),
      );
    shoppingListRepository.deleteByOwnerUserId.mockImplementationOnce(
      async () => {
        firstSweepStarted();
        await release;
        return 0;
      },
    );

    const winner = useCase.execute({
      userId: 'user-1',
      confirmationText: 'ELIMINAR',
      idempotencyKey,
    });
    await started;
    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR',
        idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
    releaseFirstSweep();
    await winner;

    expect(shoppingListRepository.deleteByOwnerUserId).toHaveBeenCalledTimes(1);
    expect(pantryMutationPort.completePantryDeletion).toHaveBeenCalledTimes(1);
  });

  it('rebuilds and releases a normal reset fence when a sweep step fails', async () => {
    const { useCase, pantryMutationPort, shoppingListRepository } =
      makeUseCase();
    pantryMutationPort.beginPantryDeletion.mockResolvedValue('owner-token');
    shoppingListRepository.deleteByOwnerUserId.mockRejectedValueOnce(
      new Error('temporary delete failure'),
    );

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR',
        idempotencyKey,
      }),
    ).rejects.toThrow('temporary delete failure');

    expect(pantryMutationPort.abortPantryDeletion).toHaveBeenCalledWith(
      'user-1',
      'owner-token',
    );
    expect(pantryMutationPort.completePantryDeletion).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation before deleting all pantry data for a user', async () => {
    const {
      useCase,
      productTypeRepository,
      productRepository,
      inventoryLotRepository,
      shoppingListRepository,
      shoppingShareRepository,
      wasteEventRepository,
    } = makeUseCase();

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'BORRAR',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(productTypeRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(productRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(inventoryLotRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(shoppingListRepository.deleteByOwnerUserId).not.toHaveBeenCalled();
    expect(shoppingShareRepository.deleteByOwnerUserId).not.toHaveBeenCalled();
    expect(wasteEventRepository.deleteByUserId).not.toHaveBeenCalled();
  });

  it('requires a UUID Idempotency-Key before a normal reset begins', async () => {
    const { useCase, pantryMutationPort } = makeUseCase();

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pantryMutationPort.beginPantryDeletion).not.toHaveBeenCalled();
  });

  it('deletes saved lists, inventory data, product types, and legacy products', async () => {
    const {
      useCase,
      productTypeRepository,
      productRepository,
      inventoryLotRepository,
      shoppingListRepository,
      shoppingShareRepository,
      wasteEventRepository,
    } = makeUseCase({
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 4,
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
    });

    await expect(
      useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR',
        idempotencyKey,
      }),
    ).resolves.toEqual({
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 4,
    });
    expect(shoppingListRepository.deleteByOwnerUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(shoppingShareRepository.deleteByOwnerUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(inventoryLotRepository.deleteByUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(wasteEventRepository.deleteByUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(productTypeRepository.deleteByUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(productRepository.deleteByUserId).toHaveBeenCalledWith(
      UserId.fromString('user-1'),
    );
    expect(
      invocationOrder(shoppingListRepository.deleteByOwnerUserId as jest.Mock),
    ).toBeLessThan(
      invocationOrder(shoppingShareRepository.deleteByOwnerUserId as jest.Mock),
    );
    expect(
      invocationOrder(shoppingShareRepository.deleteByOwnerUserId as jest.Mock),
    ).toBeLessThan(
      invocationOrder(wasteEventRepository.deleteByUserId as jest.Mock),
    );
    expect(
      invocationOrder(wasteEventRepository.deleteByUserId as jest.Mock),
    ).toBeLessThan(
      invocationOrder(inventoryLotRepository.deleteByUserId as jest.Mock),
    );
    expect(
      invocationOrder(inventoryLotRepository.deleteByUserId as jest.Mock),
    ).toBeLessThan(
      invocationOrder(productTypeRepository.deleteByUserId as jest.Mock),
    );
  });
});

function makeUseCase(
  counts: {
    deletedShoppingShareCount: number;
    deletedShoppingListCount: number;
    deletedWasteEventCount: number;
    deletedInventoryLotCount: number;
    deletedProductTypeCount: number;
  } = {
    deletedShoppingShareCount: 0,
    deletedShoppingListCount: 0,
    deletedWasteEventCount: 0,
    deletedInventoryLotCount: 0,
    deletedProductTypeCount: 0,
  },
) {
  const productTypeRepository = {
    deleteByUserId: jest.fn().mockResolvedValue(counts.deletedProductTypeCount),
  } as unknown as jest.Mocked<ProductTypeRepository>;
  const productRepository = {
    deleteByUserId: jest.fn().mockResolvedValue(6),
  } as unknown as jest.Mocked<ProductRepository>;
  const inventoryLotRepository = {
    deleteByUserId: jest
      .fn()
      .mockResolvedValue(counts.deletedInventoryLotCount),
  } as unknown as jest.Mocked<InventoryLotRepository>;
  const shoppingShareRepository = {
    deleteByOwnerUserId: jest
      .fn()
      .mockResolvedValue(counts.deletedShoppingShareCount),
  } as unknown as jest.Mocked<ShoppingShareRepository>;
  const shoppingListRepository = {
    deleteByOwnerUserId: jest
      .fn()
      .mockResolvedValue(counts.deletedShoppingListCount),
  } as unknown as jest.Mocked<ShoppingListRepository>;
  const wasteEventRepository = {
    deleteByUserId: jest.fn().mockResolvedValue(counts.deletedWasteEventCount),
  } as unknown as jest.Mocked<WasteEventRepository>;
  const pantryMutationPort = makePantryMutationMock();
  pantryMutationPort.beginPantryDeletion.mockImplementation(
    async (_ownerUserId, request) => request?.deletionToken ?? 'delete-token',
  );
  const useCase = new DeletePantryDataUseCase(
    productTypeRepository,
    inventoryLotRepository,
    shoppingShareRepository,
    shoppingListRepository,
    wasteEventRepository,
    productRepository,
    pantryMutationPort,
  );

  return {
    useCase,
    productTypeRepository,
    productRepository,
    inventoryLotRepository,
    shoppingListRepository,
    shoppingShareRepository,
    wasteEventRepository,
    pantryMutationPort,
  };
}

function invocationOrder(mock: jest.Mock): number {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}
