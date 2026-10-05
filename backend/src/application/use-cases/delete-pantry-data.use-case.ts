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
import {
  PantryDeletionResult,
  PantryMutationConflictError,
  PantryMutationPort,
  PantryOperationContext,
  PantryOperationReceipt,
} from '../ports/pantry-mutation.port';
import { buildPantryIdempotencyContext } from '../utils/pantry-idempotency';

export interface DeletePantryDataCommand {
  userId: string;
  confirmationText: string;
  // Internal account-deletion mode, never copied from the pantry-reset DTO.
  accountDeletion?: boolean;
  deletionToken?: string;
  idempotencyKey?: string;
}

export type DeletePantryDataResult = PantryDeletionResult;

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
    const retainFence = Boolean(command.accountDeletion);
    let deletionContext: PantryOperationContext | undefined;
    if (!retainFence) {
      let context: ReturnType<typeof buildPantryIdempotencyContext>;
      try {
        context = buildPantryIdempotencyContext({
          ownerUserId: command.userId,
          operation: 'delete_pantry_data',
          idempotencyKey: command.idempotencyKey,
          request: { confirmationText: command.confirmationText.trim() },
        });
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
      const replay = await this.pantryMutationPort.findReceipt(context);
      if (replay) {
        if (!isPantryDeletionResult(replay.response)) {
          throw new PantryMutationConflictError(
            'Pantry deletion receipt is invalid',
          );
        }
        return replay.response;
      }
      deletionContext = context;
    }
    const deletionToken = await this.pantryMutationPort.beginPantryDeletion(
      command.userId,
      retainFence
        ? { deletionToken: command.deletionToken, retainFence: true }
        : { deletionToken: deletionContext!.operationId },
    );
    try {
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
      const result = {
        deletedInventoryLotCount,
        deletedProductTypeCount,
        deletedShoppingListCount,
        deletedShoppingShareCount,
        deletedWasteEventCount,
      };
      if (deletionContext) {
        await this.pantryMutationPort.completePantryDeletion(
          command.userId,
          deletionToken,
          false,
          {
            ...deletionContext,
            operation: 'delete_pantry_data',
            response: result,
          },
        );
      } else {
        await this.pantryMutationPort.completePantryDeletion(
          command.userId,
          deletionToken,
          true,
        );
      }

      return result;
    } catch (error) {
      if (!retainFence) {
        await this.pantryMutationPort.abortPantryDeletion(
          command.userId,
          deletionToken,
        );
      }
      throw error;
    }
  }
}

function isPantryDeletionResult(
  value: PantryOperationReceipt['response'],
): value is PantryDeletionResult {
  return Boolean(
    value &&
    !Array.isArray(value) &&
    typeof value === 'object' &&
    typeof (value as PantryDeletionResult).deletedInventoryLotCount ===
      'number' &&
    typeof (value as PantryDeletionResult).deletedProductTypeCount ===
      'number' &&
    typeof (value as PantryDeletionResult).deletedShoppingListCount ===
      'number' &&
    typeof (value as PantryDeletionResult).deletedShoppingShareCount ===
      'number' &&
    typeof (value as PantryDeletionResult).deletedWasteEventCount === 'number',
  );
}
