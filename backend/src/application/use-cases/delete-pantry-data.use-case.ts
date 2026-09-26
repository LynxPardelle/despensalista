import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductRepository } from '../../domain/repositories/product.repository';
import { ShoppingListRepository } from '../../domain/repositories/shopping-list.repository';
import { ShoppingShareRepository } from '../../domain/repositories/shopping-share.repository';
import { WasteEventRepository } from '../../domain/repositories/waste-event.repository';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  INVENTORY_LOT_REPOSITORY,
  PRODUCT_REPOSITORY,
  PRODUCT_TYPE_REPOSITORY,
  SHOPPING_LIST_REPOSITORY,
  SHOPPING_SHARE_REPOSITORY,
  WASTE_EVENT_REPOSITORY,
  PANTRY_MUTATION_PORT,
} from '../tokens';
import { PantryMutationPort } from '../ports/pantry-mutation.port';

export interface DeletePantryDataCommand {
  userId: string;
  confirmationText: string;
  // Internal account-deletion mode, never copied from the pantry-reset DTO.
  accountDeletion?: boolean;
}

export interface DeletePantryDataResult {
  deletedInventoryLotCount: number;
  deletedProductTypeCount: number;
  deletedShoppingListCount: number;
  deletedShoppingShareCount: number;
  deletedWasteEventCount: number;
}

const DELETE_PANTRY_DATA_CONFIRMATION = 'ELIMINAR';

@Injectable()
export class DeletePantryDataUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
    @Inject(SHOPPING_SHARE_REPOSITORY)
    private readonly shoppingShareRepository: ShoppingShareRepository,
    @Inject(SHOPPING_LIST_REPOSITORY)
    private readonly shoppingListRepository: ShoppingListRepository,
    @Inject(WASTE_EVENT_REPOSITORY)
    private readonly wasteEventRepository: WasteEventRepository,
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepository: ProductRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(
    command: DeletePantryDataCommand,
  ): Promise<DeletePantryDataResult> {
    if (command.confirmationText.trim() !== DELETE_PANTRY_DATA_CONFIRMATION) {
      throw new BadRequestException(
        `Confirmation text must be ${DELETE_PANTRY_DATA_CONFIRMATION}`,
      );
    }

    const userId = UserId.fromString(command.userId);
    const preserveDeletionLockUntil = command.accountDeletion
      ? new Date(Date.now() + 24 * 60 * 60 * 1000)
      : undefined;
    if (preserveDeletionLockUntil) {
      await this.pantryMutationPort.beginPantryDeletion(
        command.userId,
        preserveDeletionLockUntil,
      );
    } else {
      await this.pantryMutationPort.beginPantryDeletion(command.userId);
    }
    const deletedShoppingListCount =
      await this.shoppingListRepository.deleteByOwnerUserId(userId);
    const deletedShoppingShareCount =
      await this.shoppingShareRepository.deleteByOwnerUserId(userId);
    const deletedWasteEventCount =
      await this.wasteEventRepository.deleteByUserId(userId);
    const deletedInventoryLotCount =
      await this.inventoryLotRepository.deleteByUserId(userId);
    const deletedProductTypeCount =
      await this.productTypeRepository.deleteByUserId(userId);
    await this.productRepository.deleteByUserId(userId);
    await this.pantryMutationPort.completePantryDeletion(
      command.userId,
      preserveDeletionLockUntil,
    );

    return {
      deletedInventoryLotCount,
      deletedProductTypeCount,
      deletedShoppingListCount,
      deletedShoppingShareCount,
      deletedWasteEventCount,
    };
  }
}
