import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryLot } from '../../domain/entities/inventory-lot.entity';
import { InventoryLotRepository } from '../../domain/repositories/inventory-lot.repository';
import { InventoryLotId } from '../../domain/value-objects/inventory-lot-id.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { INVENTORY_LOT_REPOSITORY } from '../tokens';
import {
  PantryMutationConflictError,
  PantryMutationPort,
} from '../ports/pantry-mutation.port';
import { PANTRY_MUTATION_PORT } from '../tokens';

export interface ArchiveInventoryLotCommand {
  lotId: string;
  userId: string;
  reason?: string;
}

@Injectable()
export class ArchiveInventoryLotUseCase {
  constructor(
    @Inject(INVENTORY_LOT_REPOSITORY)
    private readonly inventoryLotRepository: InventoryLotRepository,
    @Inject(PANTRY_MUTATION_PORT)
    private readonly pantryMutationPort: PantryMutationPort,
  ) {}

  async execute(command: ArchiveInventoryLotCommand): Promise<InventoryLot> {
    const lot = await this.findOwnedLot(command.lotId, command.userId);

    const expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive(command.reason);

    try {
      return await this.pantryMutationPort.archiveInventoryLot(expected, lot);
    } catch (error) {
      if (error instanceof PantryMutationConflictError) {
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
