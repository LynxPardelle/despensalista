import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import {
  ProductType,
  ProductTypeShoppingMetadataPatch,
} from '../../domain/entities/product-type.entity';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { MAX_SHOPPING_CHECKOUT_ITEMS } from '../constants/query-limits';
import {
  IdempotencyPayloadConflictError,
  IdempotentMutationResult,
  PantryMutationConflictError,
  PantryMutationPort,
  PantryQuotaExceededError,
  ProductTypeTransactionChange,
} from '../ports/pantry-mutation.port';
import { PANTRY_MUTATION_PORT, PRODUCT_TYPE_REPOSITORY } from '../tokens';
import { parseQuantityUnit } from '../utils/enum-parsers';
import {
  buildPantryIdempotencyContext,
  deterministicMutationEntityId,
} from '../utils/pantry-idempotency';

export interface CloseShoppingPurchaseItemCommand {
  productTypeId: string;
  variantName?: string;
  quantity: number;
  unit: string;
  paidUnitPrice?: number;
  shoppingLocation?: string;
  expiresAt?: Date;
}

export interface CloseShoppingPurchaseCommand {
  userId: string;
  idempotencyKey?: string;
  items: CloseShoppingPurchaseItemCommand[];
}

interface PreparedPurchaseItem {
  command: CloseShoppingPurchaseItemCommand;
  productType: ProductType;
  unit: ReturnType<typeof parseQuantityUnit>;
}

@Injectable()
export class CloseShoppingPurchaseUseCase {
  constructor(
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(
    command: CloseShoppingPurchaseCommand,
  ): Promise<IdempotentMutationResult<InventoryLot[]>> {
    if (command.items.length === 0) {
      throw new BadRequestException('Checkout must include at least one item');
    }
    if (command.items.length > MAX_SHOPPING_CHECKOUT_ITEMS) {
      throw new BadRequestException(
        `Checkout cannot include more than ${MAX_SHOPPING_CHECKOUT_ITEMS} items`,
      );
    }

    let receipt: ReturnType<typeof buildPantryIdempotencyContext>;
    try {
      receipt = buildPantryIdempotencyContext({
        ownerUserId: command.userId,
        operation: 'close_shopping_purchase',
        idempotencyKey: command.idempotencyKey,
        request: command.items.map((item) => ({
          ...item,
          variantName: item.variantName?.trim() || undefined,
          shoppingLocation: item.shoppingLocation?.trim() || undefined,
          expiresAt: item.expiresAt?.toISOString(),
        })),
      });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    try {
      const replay = await this.pantryMutationPort.findReceipt(receipt);
      if (replay) {
        const response = Array.isArray(replay.response) ? replay.response : [];
        return {
          value: response.map((lot) => InventoryLot.fromPrimitives(lot)),
          replayed: true,
        };
      }

      const userId = UserId.fromString(command.userId);
      const productTypeChanges = await this.loadProductTypes(
        userId,
        command.items,
      );
      const productTypeById = new Map(
        productTypeChanges.map((change) => [
          change.updated.id.toString(),
          change.updated,
        ]),
      );
      const preparedItems = command.items.map((item) =>
        this.prepareItem(item, productTypeById.get(item.productTypeId)),
      );
      const purchaseDate = new Date();
      const lots: InventoryLot[] = [];

      for (const [index, prepared] of preparedItems.entries()) {
        const generatedLot = InventoryLot.create(
          userId,
          prepared.productType.id,
          prepared.command.variantName,
          prepared.command.quantity,
          prepared.unit,
          prepared.command.expiresAt,
          purchaseDate,
        );
        lots.push(
          InventoryLot.fromPrimitives({
            ...generatedLot.toPrimitives(),
            id: deterministicMutationEntityId(
              'lot',
              receipt.operationId,
              index,
            ),
          }),
        );
        const patch = this.toShoppingMetadataPatch(prepared.command);
        if (patch) {
          prepared.productType.updateShoppingMetadata(patch);
        }
      }

      productTypeChanges.forEach((change) => {
        change.changed =
          JSON.stringify(change.expected.toPrimitives()) !==
          JSON.stringify(change.updated.toPrimitives());
      });
      const committed = await this.pantryMutationPort.checkout({
        receipt,
        lots,
        productTypes: productTypeChanges,
      });

      return {
        value: committed.value.map((lot) => InventoryLot.fromPrimitives(lot)),
        replayed: committed.replayed,
      };
    } catch (error) {
      throw mapMutationError(error);
    }
  }

  private async loadProductTypes(
    userId: UserId,
    items: CloseShoppingPurchaseItemCommand[],
  ): Promise<ProductTypeTransactionChange[]> {
    const uniqueIds = [...new Set(items.map((item) => item.productTypeId))];
    return Promise.all(
      uniqueIds.map(async (id) => {
        const productType = await this.productTypeRepository.findById(
          ProductTypeId.fromString(id),
        );
        if (
          !productType ||
          productType.userId.toString() !== userId.toString()
        ) {
          throw new NotFoundException('Product type not found for this user');
        }
        if (productType.isArchived()) {
          throw new BadRequestException(
            'Archived product types cannot be checked out',
          );
        }
        return {
          expected: ProductType.fromPrimitives(productType.toPrimitives()),
          updated: productType,
          changed: false,
        };
      }),
    );
  }

  private prepareItem(
    item: CloseShoppingPurchaseItemCommand,
    productType: ProductType | undefined,
  ): PreparedPurchaseItem {
    if (!productType) {
      throw new NotFoundException('Product type not found for this user');
    }
    const unit = parseQuantityUnit(item.unit);
    if (productType.defaultUnit !== unit) {
      throw new BadRequestException(
        `Lot unit must match product type default unit (${productType.defaultUnit})`,
      );
    }
    return { command: item, productType, unit };
  }

  private toShoppingMetadataPatch(
    item: CloseShoppingPurchaseItemCommand,
  ): ProductTypeShoppingMetadataPatch | null {
    const patch: ProductTypeShoppingMetadataPatch = {};
    if (item.paidUnitPrice !== undefined) {
      patch.estimatedUnitPrice = item.paidUnitPrice;
    }
    if (item.shoppingLocation !== undefined) {
      patch.shoppingLocation = item.shoppingLocation;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }
}

function mapMutationError(error: unknown): Error {
  if (
    error instanceof IdempotencyPayloadConflictError ||
    error instanceof PantryMutationConflictError ||
    error instanceof PantryQuotaExceededError
  ) {
    return new ConflictException(error.message);
  }
  return error instanceof Error ? error : new Error('Pantry mutation failed');
}
