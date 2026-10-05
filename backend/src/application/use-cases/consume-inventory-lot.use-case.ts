import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import {
  WasteEvent,
  WasteReason,
} from '../../domain/entities/waste-event.entity';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { InventoryLotId } from '../../domain/value-objects/inventory-lot-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import {
  IdempotencyPayloadConflictError,
  IdempotentMutationResult,
  PantryMutationConflictError,
  PantryMutationPort,
  PantryQuotaExceededError,
} from '../ports/pantry-mutation.port';
import {
  INVENTORY_LOT_REPOSITORY,
  PANTRY_MUTATION_PORT,
  PRODUCT_TYPE_REPOSITORY,
} from '../tokens';
import {
  buildPantryIdempotencyContext,
  deterministicMutationEntityId,
} from '../utils/pantry-idempotency';

export interface ConsumeInventoryLotCommand {
  lotId: string;
  userId: string;
  quantity: number;
  wasteReason?: WasteReason;
  wasteNote?: string;
  idempotencyKey?: string;
}

@Injectable()
export class ConsumeInventoryLotUseCase {
  constructor(
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(
    command: ConsumeInventoryLotCommand,
  ): Promise<IdempotentMutationResult<InventoryLot | null>> {
    let receipt: ReturnType<typeof buildPantryIdempotencyContext>;
    try {
      receipt = buildPantryIdempotencyContext({
        ownerUserId: command.userId,
        operation: 'consume_inventory_lot',
        idempotencyKey: command.idempotencyKey,
        request: {
          lotId: command.lotId,
          quantity: command.quantity,
          wasteReason: command.wasteReason,
          wasteNote: command.wasteNote?.trim() || undefined,
        },
      });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    try {
      const replay = await this.pantryMutationPort.findReceipt(receipt);
      if (replay) {
        return {
          value: replay.response
            ? InventoryLot.fromPrimitives(
                replay.response as ReturnType<InventoryLot['toPrimitives']>,
              )
            : null,
          replayed: true,
        };
      }

      const inventoryLot = await this.inventoryLotRepository.findById(
        InventoryLotId.fromString(command.lotId),
      );

      if (
        !inventoryLot ||
        inventoryLot.userId.toString() !==
          UserId.fromString(command.userId).toString()
      ) {
        throw new NotFoundException('Inventory lot not found for this user');
      }

      if (inventoryLot.archivedAt) {
        throw new BadRequestException(
          'Archived inventory lots cannot be consumed',
        );
      }

      if (command.quantity <= 0) {
        throw new BadRequestException(
          'Consume quantity must be greater than zero',
        );
      }

      if (command.quantity > inventoryLot.quantity) {
        throw new BadRequestException('Consume quantity exceeds lot quantity');
      }

      const expectedLot = InventoryLot.fromPrimitives(
        inventoryLot.toPrimitives(),
      );
      let wasteEvent: WasteEvent | undefined;

      if (command.wasteReason) {
        const productType = await this.productTypeRepository.findById(
          inventoryLot.productTypeId,
        );
        if (
          !productType ||
          productType.userId.toString() !== inventoryLot.userId.toString()
        ) {
          throw new NotFoundException('Product type not found');
        }

        const generatedWasteEvent = WasteEvent.create({
          userId: inventoryLot.userId,
          productTypeId: inventoryLot.productTypeId,
          inventoryLotId: inventoryLot.id,
          productName: productType.baseName,
          quantity: command.quantity,
          unit: inventoryLot.unit,
          reason: command.wasteReason,
          note: command.wasteNote,
          estimatedLoss: estimateLoss(
            command.quantity,
            productType.shoppingMetadata.estimatedUnitPrice,
          ),
        });
        wasteEvent = WasteEvent.fromPrimitives({
          ...generatedWasteEvent.toPrimitives(),
          id: deterministicMutationEntityId('waste', receipt.operationId, 0),
        });
      }

      inventoryLot.consume(command.quantity);
      const committed = await this.pantryMutationPort.consume({
        receipt,
        expectedLot,
        updatedLot: inventoryLot.isEmpty() ? null : inventoryLot,
        wasteEvent,
      });

      return {
        value: committed.value
          ? InventoryLot.fromPrimitives(committed.value)
          : null,
        replayed: committed.replayed,
      };
    } catch (error) {
      throw mapMutationError(error);
    }
  }
}

function estimateLoss(
  quantity: number,
  estimatedUnitPrice: number | undefined,
): number | undefined {
  if (
    estimatedUnitPrice === undefined ||
    !Number.isFinite(estimatedUnitPrice)
  ) {
    return undefined;
  }
  return Number((quantity * estimatedUnitPrice).toFixed(2));
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
