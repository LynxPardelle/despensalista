import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ShoppingListRepository } from '../../domain/repositories/shopping-list.repository';
import { PantryMutationPort } from './pantry-mutation.port';

export function makePantryMutationMock(
  repositories: {
    lots?: InventoryLotRepository;
    types?: ProductTypeRepository;
    lists?: ShoppingListRepository;
  } = {},
): jest.Mocked<PantryMutationPort> {
  return {
    findReceipt: jest.fn(),
    consume: jest.fn(),
    checkout: jest.fn(),
    createInventoryLot: jest.fn(async (lot) =>
      repositories.lots ? repositories.lots.save(lot) : lot,
    ),
    archiveInventoryLot: jest.fn(async (_expected, lot) =>
      repositories.lots ? repositories.lots.save(lot) : lot,
    ),
    restoreInventoryLot: jest.fn(async (_expected, lot) =>
      repositories.lots ? repositories.lots.save(lot) : lot,
    ),
    deleteInventoryLot: jest.fn(async (lot) => {
      await repositories.lots?.delete(lot.id);
    }),
    beginProductTypeDeletion: jest.fn(),
    createProductType: jest.fn(async (type) =>
      repositories.types ? repositories.types.save(type) : type,
    ),
    archiveProductType: jest.fn(async (_expected, type) =>
      repositories.types ? repositories.types.save(type) : type,
    ),
    restoreProductType: jest.fn(async (_expected, type) =>
      repositories.types ? repositories.types.save(type) : type,
    ),
    updateProductType: jest.fn(async (_expected, type) =>
      repositories.types ? repositories.types.save(type) : type,
    ),
    deleteProductType: jest.fn(async (type) => {
      await repositories.types?.delete(type.id);
    }),
    createShoppingList: jest.fn(async (list) =>
      repositories.lists ? repositories.lists.save(list) : list,
    ),
    createProduct: jest.fn((product) => Promise.resolve(product)),
    updateProduct: jest.fn((_expected, product) => Promise.resolve(product)),
    createShoppingShare: jest.fn((share) => Promise.resolve(share)),
    updateShoppingShare: jest.fn((_expected, share) => Promise.resolve(share)),
    deleteShoppingList: jest.fn(async (list) => {
      await repositories.lists?.delete(list.id);
    }),
    beginPantryDeletion: jest.fn(),
    completePantryDeletion: jest.fn(),
  };
}
