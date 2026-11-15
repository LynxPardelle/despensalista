import { makePantryMutationMock } from '../ports/pantry-mutation.mock';
import { FREE_HOUSEHOLD_PLAN } from '../ports/household-plan-reader';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PantryQuotaExceededError } from '../ports/pantry-mutation.port';
import { QuantityUnit } from '../../domain/enums';
import { ShoppingList } from '../../domain/entities/shopping-list.entity';
import { ShoppingListRepository } from '../../domain/repositories/shopping-list.repository';
import {
  CreateShoppingListUseCase,
  DeleteShoppingListUseCase,
  ListShoppingListsUseCase,
} from './shopping-list.use-cases';

describe('Shopping list use cases', () => {
  const freePlans = {
    getPlan: jest.fn().mockResolvedValue(FREE_HOUSEHOLD_PLAN),
  };
  it('applies the household plan when saving a shared list', async () => {
    const mutation = makePantryMutationMock({ lists: makeRepository() });
    const plans = {
      getPlan: jest.fn().mockResolvedValue({
        tier: 'plus',
        memberLimit: 5,
        savedListLimit: 15,
        paidThrough: null,
      }),
    };
    const useCase = new CreateShoppingListUseCase(mutation, plans);
    const command = {
      householdId: 'household-1',
      ownerUserId: 'user-1',
      title: 'Lista del hogar',
      items: [
        {
          productTypeId: 'type-rice',
          baseName: 'Arroz',
          quantity: 1,
          unit: QuantityUnit.KILOGRAM,
        },
      ],
    };

    await useCase.execute(command);

    expect(plans.getPlan).toHaveBeenCalledWith('household-1');
    expect(mutation.createShoppingList).toHaveBeenCalledWith(
      expect.any(ShoppingList),
      15,
    );
  });

  it('creates a server-backed list under the per-user limit', async () => {
    const repository = makeRepository();
    const useCase = new CreateShoppingListUseCase(
      makePantryMutationMock({ lists: repository }),
      freePlans,
    );

    const list = await useCase.execute({
      householdId: 'household-1',
      ownerUserId: 'user-1',
      title: 'Mayoreo semanal',
      occasion: 'Quincena',
      shoppingLocation: 'Mayoreo',
      items: [
        {
          productTypeId: 'type-rice',
          baseName: 'Arroz',
          quantity: 2,
          unit: QuantityUnit.KILOGRAM,
          shoppingLocation: 'Mayoreo',
          estimatedUnitPrice: 35,
          estimatedLineTotal: 70,
        },
      ],
    });

    expect(repository.save).toHaveBeenCalledWith(expect.any(ShoppingList));
    expect(list.toPrimitives()).toEqual(
      expect.objectContaining({
        ownerUserId: 'user-1',
        title: 'Mayoreo semanal',
        occasion: 'Quincena',
        shoppingLocation: 'Mayoreo',
      }),
    );
  });

  it('rejects list creation after reaching the per-user limit', async () => {
    const repository = makeRepository({
      existingLists: Array.from({ length: 25 }, (_, index) =>
        makeShoppingList({ id: `list-${index}` }),
      ),
    });
    const mutation = makePantryMutationMock({ lists: repository });
    mutation.createShoppingList.mockRejectedValue(
      new PantryQuotaExceededError('Saved shopping list quota exceeded'),
    );
    const useCase = new CreateShoppingListUseCase(mutation, freePlans);

    await expect(
      useCase.execute({
        householdId: 'household-1',
        ownerUserId: 'user-1',
        title: 'Lista extra',
        items: [
          {
            productTypeId: 'type-rice',
            baseName: 'Arroz',
            quantity: 1,
            unit: QuantityUnit.KILOGRAM,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('lists saved shopping lists newest first through the repository', async () => {
    const repository = makeRepository({
      existingLists: [makeShoppingList({ id: 'list-1' })],
    });
    const useCase = new ListShoppingListsUseCase(repository);

    await expect(useCase.execute('user-1')).resolves.toHaveLength(1);
    expect(repository.listByOwnerUserId).toHaveBeenCalledWith('user-1');
  });

  it('prevents deleting another owner shopping list', async () => {
    const repository = makeRepository({
      listById: makeShoppingList({ ownerUserId: 'other-user' }),
    });
    const useCase = new DeleteShoppingListUseCase(
      repository,
      makePantryMutationMock({ lists: repository }),
    );

    await expect(
      useCase.execute({ ownerUserId: 'user-1', listId: 'list-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.delete).not.toHaveBeenCalled();
  });
});

function makeRepository(
  options: {
    existingLists?: ShoppingList[];
    listById?: ShoppingList | null;
  } = {},
): jest.Mocked<ShoppingListRepository> {
  return {
    save: jest.fn(async (list) => list),
    findById: jest.fn().mockResolvedValue(options.listById ?? null),
    listByOwnerUserId: jest.fn().mockResolvedValue(options.existingLists ?? []),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteByOwnerUserId: jest.fn().mockResolvedValue(0),
  };
}

function makeShoppingList(
  overrides: Partial<ReturnType<ShoppingList['toPrimitives']>> = {},
): ShoppingList {
  return ShoppingList.fromPrimitives({
    id: 'list-1',
    ownerUserId: 'user-1',
    title: 'Mayoreo semanal',
    items: [
      {
        productTypeId: 'type-rice',
        baseName: 'Arroz',
        quantity: 2,
        unit: QuantityUnit.KILOGRAM,
      },
    ],
    createdAt: new Date('2026-06-09T00:00:00.000Z'),
    updatedAt: new Date('2026-06-09T00:00:00.000Z'),
    ...overrides,
  });
}
