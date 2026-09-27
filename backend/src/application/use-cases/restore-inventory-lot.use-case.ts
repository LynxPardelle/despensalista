import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { ProductTypeRepository } from '../../domain/repositories/product-type.repository';
import { InventoryLotId } from '../../domain/value-objects/inventory-lot-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { INVENTORY_LOT_REPOSITORY, PRODUCT_TYPE_REPOSITORY } from '../tokens';
import {
  PantryMutationConflictError,
  PantryMutationPort,
  PantryQuotaExceededError,
} from '../ports/pantry-mutation.port';
import { PANTRY_MUTATION_PORT } from '../tokens';

export interface RestoreInventoryLotCommand {
  lotId: string;
  userId: string;
}

@Injectable()
export class RestoreInventoryLotUseCase {
  constructor(
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
    @Inject(PRODUCT_TYPE_REPOSITORY)
    private readonly productTypeRepository: ProductTypeRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: RestoreInventoryLotCommand): Promise<InventoryLot> {
    const lot = await this.findOwnedLot(command.lotId, command.userId);
    const productType = await this.productTypeRepository.findById(
      lot.productTypeId,
    );

    if (
      !productType ||
      productType.userId.toString() !== lot.userId.toString()
    ) {
      throw new NotFoundException('Product type not found for this user');
    }

    if (productType.isArchived()) {
      throw new BadRequestException(
        'Inventory lots cannot be restored for archived product types',
      );
    }

    const expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.restore();

    try {
      return await this.pantryMutationPort.restoreInventoryLot(expected, lot);
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

  private async findOwnedLot(
    lotId: string,
    userId: string,
  ): Promise<InventoryLot> {
    const lot = await this.inventoryLotRepository.findById(
      InventoryLotId.fromString(lotId),
    );

    if (
      !lot ||
      lot.userId.toString() !== UserId.fromString(userId).toString()
    ) {
      throw new NotFoundException('Inventory lot not found');
    }

    return lot;
  }
}
