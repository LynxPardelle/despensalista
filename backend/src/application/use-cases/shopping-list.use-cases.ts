import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PANTRY_MUTATION_PORT, SHOPPING_LIST_REPOSITORY } from '../tokens';
import {
  PantryMutationConflictError,
  PantryMutationPort,
  PantryQuotaExceededError,
} from '../ports/pantry-mutation.port';
import {
  ShoppingList,
  ShoppingListItemPrimitives,
} from '../../domain/entities/shopping-list.entity';
import { ShoppingListRepository } from '../../domain/repositories/shopping-list.repository';

@Injectable()
export class CreateShoppingListUseCase {
  constructor(
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: {
    ownerUserId: string;
    title: string;
    occasion?: string;
    shoppingLocation?: string;
    items: ShoppingListItemPrimitives[];
  }): Promise<ShoppingList> {
    const list = ShoppingList.create(command);

    try {
      return await this.pantryMutationPort.createShoppingList(list);
    } catch (error) {
      if (
        error instanceof PantryQuotaExceededError ||
        error instanceof PantryMutationConflictError
      ) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}

@Injectable()
export class ListShoppingListsUseCase {
  constructor(
    @Inject(SHOPPING_LIST_REPOSITORY)
    private readonly shoppingListRepository: ShoppingListRepository,
  ) {}

  async execute(ownerUserId: string): Promise<ShoppingList[]> {
    return this.shoppingListRepository.listByOwnerUserId(ownerUserId);
  }
}

@Injectable()
export class DeleteShoppingListUseCase {
  constructor(
    @Inject(SHOPPING_LIST_REPOSITORY)
    private readonly shoppingListRepository: ShoppingListRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: {
    ownerUserId: string;
    listId: string;
  }): Promise<ShoppingList> {
    const list = await this.shoppingListRepository.findById(command.listId);

    if (!list) {
      throw new NotFoundException('Shopping list not found');
    }

    try {
      list.assertOwnedBy(command.ownerUserId);
    } catch {
      throw new ForbiddenException(
        'Shopping list is not owned by current user',
      );
    }

    try {
      await this.pantryMutationPort.deleteShoppingList(list);
    } catch (error) {
      if (error instanceof PantryMutationConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    return list;
  }
}
