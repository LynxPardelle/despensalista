import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { BadRequestException } from '@nestjs/common';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductRepository } from '../../domain/repositories/product.repository';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ShoppingListRepository } from '../../domain/repositories/shopping-list.repository';
import { ShoppingShareRepository } from '../../domain/repositories/shopping-share.repository';
import { WasteEventRepository } from '../../domain/repositories/waste-event.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { DeletePantryDataUseCase } from './delete-pantry-data.use-case';

describe('DeletePantryDataUseCase', () => {
  it('retains a one-day mutation tombstone for account deletion but not normal pantry reset', async () => {
    const { useCase, pantryMutationPort } = makeUseCase();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await useCase.execute({
        userId: 'user-1',
        confirmationText: 'ELIMINAR',
        accountDeletion: true,
      });
      expect(
        pantryMutationPort.completePantryDeletion,
      ).toHaveBeenLastCalledWith('user-1', new Date(now + 24 * 60 * 60 * 1000));
      await useCase.execute({ userId: 'user-1', confirmationText: 'ELIMINAR' });
      expect(
        pantryMutationPort.completePantryDeletion,
      ).toHaveBeenLastCalledWith('user-1', undefined);
    } finally {
      clock.mockRestore();
    }
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
