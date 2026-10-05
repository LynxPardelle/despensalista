import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { InventoryLotId } from '../../domain/value-objects/inventory-lot-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { INVENTORY_LOT_REPOSITORY, PANTRY_MUTATION_PORT } from '../tokens';
import { PantryMutationPort } from '../ports/pantry-mutation.port';

export interface DeleteInventoryLotCommand {
  lotId: string;
  userId: string;
  confirmationText: string;
}

@Injectable()
export class DeleteInventoryLotUseCase {
  constructor(
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: DeleteInventoryLotCommand): Promise<void> {
    const lot = await this.findOwnedLot(command.lotId, command.userId);

    if (!lot.canDeletePermanently()) {
      throw new BadRequestException(
        'Archive the inventory lot before deleting it permanently',
      );
    }

    try {
      lot.assertDeleteConfirmation(command.confirmationText);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    await this.pantryMutationPort.deleteInventoryLot(lot);
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
